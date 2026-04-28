import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import { type AgentConfig, loadConfig, resolveAgent, type SignalConfig } from "./config.js";
import {
  buildStubMetadata,
  compactConversation,
  estimatePayloadTokens,
  getModelContextWindow,
  pruneMessages,
  type StubMetadata,
} from "./context.js";
import { VesperError } from "./errors.js";
import { Logger } from "./logger.js";
import {
  checkCommandPermission,
  checkPathPermission,
  isContained,
  logDeniedCall,
  resolveReal,
} from "./permissions.js";
import {
  getSignalPaths,
  type SignalPaths,
  writeAgentNeedsApproval,
  writeComplete,
  writeFailed,
  writeNeedsApproval,
} from "./signals.js";
import { deleteFile, listFiles, patchFile, readFile, runCommand, writeFile } from "./tools.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_CONTEXT_LENGTH = 1000;

const CONTEXT_OVERFLOW_PATTERNS = [
  "prompt is too long",
  "maximum context length",
  "context window",
  "exceeds the maximum",
  "too many tokens",
];

export function isContextLengthError(err: unknown): err is BadRequestError {
  return (
    err instanceof BadRequestError &&
    err.type === "invalid_request_error" &&
    CONTEXT_OVERFLOW_PATTERNS.some((p) => err.message.toLowerCase().includes(p))
  );
}

export function extractLastText(response: Anthropic.Message): string | null {
  for (let i = response.content.length - 1; i >= 0; i--) {
    const block = response.content[i];
    if (block.type === "text" && block.text.trim().length > 0) {
      const text = block.text.trim();
      return text.length > MAX_CONTEXT_LENGTH ? text.slice(0, MAX_CONTEXT_LENGTH) : text;
    }
  }
  return null;
}
const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path relative to the working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_files",
    description:
      "List the contents of a directory at the given path relative to the working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "write_file",
    description:
      "Write content to a file at the given path, creating intermediate directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "patch_file",
    description: "Apply a unified diff patch to a file at the given path.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        patch: { type: "string", description: "Unified diff patch to apply" },
      },
      required: ["path", "patch"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "delete_file",
    description: "Delete a file at the given path.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "run_command",
    description: "Run a command with arguments as a child process.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command binary to run" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the command",
        },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "subagent",
    description:
      "Run another configured Vesper agent as a sequential sub-agent for a bounded task. " +
      "Use this when instructions ask for a sub-agent, Agent, Task, spawn_agent, or subagent primitive. " +
      "Only agent names listed in tools.subagents are permitted.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Name of the configured Vesper agent to run as a sub-agent",
        },
        prompt: {
          type: "string",
          description: "Task prompt to send to the sub-agent",
        },
      },
      required: ["agent", "prompt"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "Task",
    description:
      "Compatibility alias for prompts written for Claude Code's Task sub-agent tool. " +
      "Runs the configured Vesper agent named by subagent_type. " +
      "Only agent names listed in tools.subagents are permitted.",
    input_schema: {
      type: "object" as const,
      properties: {
        subagent_type: {
          type: "string",
          description: "Name of the configured Vesper agent to run as a sub-agent",
        },
        prompt: {
          type: "string",
          description: "Task prompt to send to the sub-agent",
        },
        description: {
          type: "string",
          description: "Short human-readable description of the delegated task",
        },
      },
      required: ["subagent_type", "prompt"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Signal tool is defined separately — it bypasses permission filtering and is always
// available to all agents. This is a deliberate departure from structural permission
// enforcement: the signal tool has no I/O and no safety surface.
const SIGNAL_TOOL_DEFINITION: Anthropic.Tool = {
  name: "signal",
  description:
    "Signal vesper how to exit this invocation. " +
    'Use "complete" when all work is done. ' +
    'Use "needs_approval" when human input is needed. ' +
    'Use "failed" when the agent cannot proceed. ' +
    "If you do not call this tool, the default exit behavior from the agent config applies.",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["complete", "needs_approval", "failed"],
        description: "The signal type to write on exit",
      },
      message: {
        type: "string",
        description:
          "Optional context message for needs_approval or failed signals. Ignored for complete.",
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  strict: true,
};

/**
 * Resolve a path and check if it is inside cwd.
 * Returns the resolved real path if inside cwd, or null if outside or unresolvable.
 */
export function isInsideCwd(targetPath: string, cwd: string): string | null {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(targetPath);
  } catch {
    return null;
  }
  return isContained(realTarget, realCwd) ? realTarget : null;
}

/**
 * Load skill files from a directory. Returns the composed skills string or null.
 */
export function loadSkills(skillsDir: string, cwd: string, logger: Logger): string | null {
  const resolvedDir = resolve(cwd, skillsDir);

  // Containment check
  const realDir = isInsideCwd(resolvedDir, cwd);
  if (realDir === null) return null;

  // Must be a directory
  try {
    const stat = statSync(realDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  // Read and filter .md files
  let entries: string[];
  try {
    entries = readdirSync(realDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((e) => extname(e) === ".md").sort();
  if (mdFiles.length === 0) return null;

  const parts: string[] = [];
  const loadedFiles: string[] = [];
  let totalBytes = 0;

  for (const filename of mdFiles) {
    try {
      const filePath = resolve(realDir, filename);
      let realFile: string;
      try {
        realFile = realpathSync(filePath);
      } catch {
        continue; // Skip broken symlinks or inaccessible files
      }
      if (!isContained(realFile, realDir)) {
        continue; // Skip symlinks pointing outside the skills directory
      }
      const content = readFileSync(realFile, "utf-8");
      if (content.trim().length === 0) continue;
      parts.push(`## ${filename}\n${content}`);
      loadedFiles.push(filename);
      totalBytes += Buffer.byteLength(content, "utf-8");
    } catch {
      // Skip individual file read errors
    }
  }

  if (parts.length === 0) return null;

  logger.skillsLoaded(loadedFiles.length, totalBytes, loadedFiles);
  return `[Skills]\n\n${parts.join("\n\n")}`;
}

// R3: Filter tool definitions to only include tools the agent has permission to use.
// The signal tool is always appended unconditionally (R11).
function filterTools(
  config: AgentConfig,
  subagentDepth = 0,
  maxSubagentDepth = 1,
): Anthropic.Tool[] {
  const toolPermissionMap: Record<string, string[]> = {
    read_file: config.tools.read,
    list_files: config.tools.read,
    write_file: config.tools.write,
    patch_file: config.tools.write,
    delete_file: config.tools.delete,
    run_command: config.tools.commands,
    subagent: config.tools.subagents,
    Task: config.tools.subagents,
  };
  const filtered = TOOL_DEFINITIONS.filter((tool) => {
    if ((tool.name === "subagent" || tool.name === "Task") && subagentDepth >= maxSubagentDepth) {
      return false;
    }
    const list = toolPermissionMap[tool.name];
    return list !== undefined && list.length > 0;
  });
  // Signal tool is always available — append after permission filtering
  filtered.push(SIGNAL_TOOL_DEFINITION);
  // R2: Apply cache_control to the last tool definition for prompt caching
  const last = filtered[filtered.length - 1];
  filtered[filtered.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  return filtered;
}

function validateString(input: Record<string, unknown>, field: string): string | null {
  const val = input[field];
  return typeof val === "string" ? val : null;
}

function validateStringArray(input: Record<string, unknown>, field: string): string[] | null {
  const val = input[field];
  if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) return null;
  return val as string[];
}

function getPermissionList(
  toolName: string,
  config: AgentConfig,
):
  | { type: "path"; operation: "read" | "write" | "delete"; list: string[] }
  | { type: "command" }
  | null {
  switch (toolName) {
    case "read_file":
    case "list_files":
      return { type: "path", operation: "read", list: config.tools.read };
    case "write_file":
    case "patch_file":
      return { type: "path", operation: "write", list: config.tools.write };
    case "delete_file":
      return { type: "path", operation: "delete", list: config.tools.delete };
    case "run_command":
      return { type: "command" };
    default:
      return null;
  }
}

// R4/R5: Build denial response — structured when reveal_permissions is true, opaque otherwise
function denialResponse(
  config: AgentConfig,
  toolName: string,
  target: string,
  allowedPatterns?: string[],
): string {
  if (config.reveal_permissions) {
    return JSON.stringify({
      error: "permission_denied",
      tool: toolName,
      target,
      ...(allowedPatterns !== undefined ? { allowed_patterns: allowedPatterns } : {}),
    });
  }
  return JSON.stringify({ error: "permission_denied" });
}

function validateSubagentRequest(
  toolName: string,
  input: unknown,
): { agent: string; prompt: string; description: string | null } | { error: string } {
  const inp = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const agent =
    toolName === "Task" ? validateString(inp, "subagent_type") : validateString(inp, "agent");
  const prompt = validateString(inp, "prompt");
  const description = validateString(inp, "description");

  if (agent === null || agent.trim().length === 0) {
    return {
      error:
        toolName === "Task"
          ? "subagent_type must be a non-empty string"
          : "agent must be a non-empty string",
    };
  }
  if (prompt === null || prompt.trim().length === 0) {
    return { error: "prompt must be a non-empty string" };
  }

  return { agent, prompt, description };
}

function loadContextFilesForSystemPrompt(files: string[], cwd: string): string {
  let content = "";
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return content;
  }

  for (const file of files) {
    const filePath = resolve(cwd, file);
    if (!existsSync(filePath)) continue;

    let realPath: string;
    try {
      realPath = realpathSync(filePath);
    } catch {
      continue;
    }
    if (!isContained(realPath, realCwd)) continue;

    const text = readFileSync(realPath, "utf-8");
    if (text.trim().length > 0) {
      content += `\n\n# ${file}\n\n${text}`;
    }
  }

  return content;
}

function loadAgentSystemPrompt(config: AgentConfig, vesperDir: string, cwd: string): string {
  const systemPromptPath = resolve(vesperDir, config.system_prompt);
  const realVesperDir = realpathSync(vesperDir);
  let realSystemPromptPath: string;
  try {
    realSystemPromptPath = realpathSync(systemPromptPath);
  } catch {
    throw new VesperError(`System prompt file not found: ${systemPromptPath}`, 1);
  }
  if (!isContained(realSystemPromptPath, realVesperDir)) {
    throw new VesperError(
      `System prompt path "${config.system_prompt}" resolves outside vesper directory`,
      1,
    );
  }

  let systemPrompt = readFileSync(realSystemPromptPath, "utf-8");
  if (config.context_files.length > 0) {
    systemPrompt += loadContextFilesForSystemPrompt(config.context_files, cwd);
  }
  return systemPrompt;
}

function makeSubagentSignalConfig(agent: string): SignalConfig {
  const id = randomUUID();
  const safeAgent = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    complete: `.vesper-subagent-${safeAgent}-${id}.complete`,
    needs_approval: `.vesper-subagent-${safeAgent}-${id}.needs-approval`,
    failed: `.vesper-subagent-${safeAgent}-${id}.failed`,
  };
}

function readSubagentSignal(paths: SignalPaths): {
  signal: "complete" | "needs_approval" | "failed" | "none";
  payload: unknown;
} {
  if (existsSync(paths.complete)) {
    return { signal: "complete", payload: null };
  }
  if (existsSync(paths.needsApproval)) {
    return {
      signal: "needs_approval",
      payload: JSON.parse(readFileSync(paths.needsApproval, "utf-8")),
    };
  }
  if (existsSync(paths.failed)) {
    return { signal: "failed", payload: JSON.parse(readFileSync(paths.failed, "utf-8")) };
  }
  return { signal: "none", payload: null };
}

function cleanupSubagentSignals(paths: SignalPaths): void {
  for (const path of [paths.complete, paths.needsApproval, paths.failed]) {
    rmSync(path, { force: true });
  }
}

async function executeSubagentTool(
  toolName: string,
  input: unknown,
  cwd: string,
  config: AgentConfig,
  client: MessageClient,
  subagentDepth: number,
  maxSubagentDepth: number,
): Promise<string> {
  const request = validateSubagentRequest(toolName, input);
  if ("error" in request) {
    return JSON.stringify({ error: "invalid_input", message: request.error });
  }

  if (!config.tools.subagents.includes(request.agent)) {
    if (config.log_denied_calls) {
      logDeniedCall(toolName, request.agent);
    }
    return denialResponse(config, toolName, request.agent, config.tools.subagents);
  }

  if (subagentDepth >= maxSubagentDepth) {
    return JSON.stringify({
      error: "subagent_depth_exceeded",
      message: `Sub-agent depth limit of ${maxSubagentDepth} reached`,
    });
  }

  const signalConfig = makeSubagentSignalConfig(request.agent);
  const signalPaths = getSignalPaths(cwd, signalConfig);

  try {
    const resolved = resolveAgent(request.agent, cwd);
    const subagentConfig = loadConfig(resolved.configPath);
    const systemPrompt = loadAgentSystemPrompt(subagentConfig, resolved.vesperDir, cwd);
    const result = await runAgent(
      subagentConfig,
      systemPrompt,
      request.prompt,
      cwd,
      request.agent,
      client,
      {
        signalPaths,
        subagentDepth: subagentDepth + 1,
        maxSubagentDepth,
      },
    );
    const { signal, payload } = readSubagentSignal(signalPaths);

    return JSON.stringify({
      ok: result.exitCode === 0 && signal !== "failed",
      agent: request.agent,
      description: request.description,
      exit_code: result.exitCode,
      signal,
      message: result.finalText ?? null,
      signal_payload: payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      error: "subagent_failed",
      agent: request.agent,
      message,
    });
  } finally {
    cleanupSubagentSignals(signalPaths);
  }
}

export async function executeTool(
  toolName: string,
  input: unknown,
  cwd: string,
  config: AgentConfig,
): Promise<string> {
  const perm = getPermissionList(toolName, config);
  if (perm === null) {
    return denialResponse(config, toolName, "unknown");
  }

  const inp = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  if (perm.type === "path") {
    const path = validateString(inp, "path");
    if (path === null) {
      return denialResponse(config, toolName, "invalid_input", perm.list);
    }
    if (!checkPathPermission(path, cwd, perm.list)) {
      if (config.log_denied_calls) {
        logDeniedCall(toolName, path);
      }
      return denialResponse(config, toolName, path, perm.list);
    }

    // Use the symlink-resolved real path for I/O to prevent TOCTOU attacks.
    // resolveReal is non-null here: checkPathPermission already verified it.
    const resolvedPath = resolveReal(path, cwd) as string;

    switch (toolName) {
      case "read_file":
        return JSON.stringify(await readFile(resolvedPath, config.max_tool_result_size));
      case "list_files":
        return JSON.stringify(await listFiles(resolvedPath, config.max_tool_result_size));
      case "write_file": {
        const content = validateString(inp, "content");
        if (content === null) return denialResponse(config, toolName, path, perm.list);
        return JSON.stringify(await writeFile(resolvedPath, content));
      }
      case "patch_file": {
        const patch = validateString(inp, "patch");
        if (patch === null) return denialResponse(config, toolName, path, perm.list);
        return JSON.stringify(await patchFile(resolvedPath, patch));
      }
      case "delete_file":
        return JSON.stringify(await deleteFile(resolvedPath));
      default:
        return denialResponse(config, toolName, path, perm.list);
    }
  }

  // Command
  const command = validateString(inp, "command");
  const args = validateStringArray(inp, "args");
  if (command === null || args === null) {
    return denialResponse(config, toolName, "invalid_input", config.tools.commands);
  }
  if (!checkCommandPermission(command, args, config.tools.commands)) {
    if (config.log_denied_calls) {
      logDeniedCall(toolName, `${command} ${args.join(" ")}`);
    }
    return denialResponse(config, toolName, `${command} ${args.join(" ")}`, config.tools.commands);
  }

  return JSON.stringify(
    await runCommand(
      command,
      args,
      cwd,
      config.command_timeout,
      config.command_env,
      config.max_tool_result_size,
    ),
  );
}

export interface RunAgentResult {
  exitCode: number;
  finalText?: string | null;
}

/** Minimal interface for the Anthropic messages API, enabling test stubs. */
export interface MessageClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface RunAgentOptions {
  signalPaths?: SignalPaths;
  subagentDepth?: number;
  maxSubagentDepth?: number;
}

export async function runAgent(
  config: AgentConfig,
  systemPrompt: string,
  taskPrompt: string,
  cwd: string,
  agentName: string,
  client?: MessageClient,
  options?: RunAgentOptions,
): Promise<RunAgentResult> {
  const messagesClient: MessageClient = client ?? new Anthropic().messages;
  const logger = new Logger(config.log_events);
  const signalPaths = options?.signalPaths ?? getSignalPaths(cwd, config.signals);
  const subagentDepth = options?.subagentDepth ?? 0;
  const maxSubagentDepth = options?.maxSubagentDepth ?? 1;

  // R1: Configurable model per agent
  const model = config.model ?? DEFAULT_MODEL;

  // R3: Filter tools to match permissions; R2: cache_control applied inside filterTools.
  // Signal tool is always present, so tools is never empty.
  const tools = filterTools(config, subagentDepth, maxSubagentDepth);

  // R2: System prompt as structured content block with cache_control
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Load skills
  const skillsContent = config.skills !== null ? loadSkills(config.skills, cwd, logger) : null;

  // Build user message: [Skills] → [Previous Context] → [Task]
  let userContent = taskPrompt;

  // Inject scratchpad contents
  let scratchpadContent: string | null = null;
  if (config.scratchpad !== null) {
    const scratchpadPath = resolve(cwd, config.scratchpad);
    const realScratchpad = isInsideCwd(scratchpadPath, cwd);
    if (realScratchpad !== null) {
      const scratchpadFile = Bun.file(realScratchpad);
      if (await scratchpadFile.exists()) {
        const text = await scratchpadFile.text();
        if (text.trim().length > 0) {
          scratchpadContent = text;
        }
      }
    }
  }

  // Compose user message based on which sections are present
  if (skillsContent !== null && scratchpadContent !== null) {
    userContent = `${skillsContent}\n\n[Previous Context]\n${scratchpadContent}\n\n[Task]\n${taskPrompt}`;
  } else if (skillsContent !== null) {
    userContent = `${skillsContent}\n\n[Task]\n${taskPrompt}`;
  } else if (scratchpadContent !== null) {
    userContent = `[Previous Context]\n${scratchpadContent}\n\n[Task]\n${taskPrompt}`;
  }

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  // Recorded signal from the agent's signal tool call (last call wins)
  let recordedSignal: { type: "complete" | "needs_approval" | "failed"; message?: string } | null =
    null;

  // Stub metadata for tool result pruning (keyed by tool_use_id)
  const stubMetadata: Map<string, StubMetadata> = new Map();
  const modelWindow = getModelContextWindow(model, logger);
  let finalText: string | null = null;

  // Pre-compute fixed cost tokens (system + tools) once before the loop
  const fixedCostTokens = estimatePayloadTokens(systemBlocks, tools, []);

  // Compaction fires at most once per invocation (R4, R5)
  let compactionAttempted = false;
  const compactionEnabled = config.context_management.compaction_enabled;
  const compactionThreshold = config.context_management.compaction_threshold;
  const compactionModel = config.context_management.compaction_model ?? model;

  const contextLimit = 0.95 * modelWindow;
  const compactionLimit = compactionThreshold * modelWindow;

  // Tool loop — model calls tools until it stops
  while (true) {
    // Pre-call context guard: estimate context and fail gracefully at 95% of model window
    let estimatedContextTokens = fixedCostTokens + estimatePayloadTokens([], [], messages);
    if (compactionEnabled && !compactionAttempted && estimatedContextTokens > compactionLimit) {
      compactionAttempted = true;
      const beforeTokens = estimatedContextTokens;

      const writeScratchpad = async (summary: string) => {
        if (config.scratchpad === null) return;
        try {
          let realCwd: string;
          try {
            realCwd = realpathSync(cwd);
          } catch {
            realCwd = cwd;
          }
          const scratchpadPath = resolve(realCwd, config.scratchpad);
          if (!isContained(scratchpadPath, realCwd)) return;
          const real = resolveReal(config.scratchpad, realCwd);
          if (real !== null && !isContained(real, realCwd)) return;
          await Bun.write(scratchpadPath, summary);
        } catch {
          // Best-effort: scratchpad write failure should not derail compaction
        }
      };

      let summary: string;
      try {
        const { summary: s, usage: compactionUsage } = await compactConversation(
          messagesClient,
          compactionModel,
          messages,
          userContent,
        );
        summary = s;

        // R8: Count compaction usage against token budget
        totalInputTokens += compactionUsage.input_tokens;
        totalOutputTokens += compactionUsage.output_tokens;
      } catch (err) {
        // R9: Compaction failure writes failed signal
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeFailed(
          signalPaths,
          agentName,
          "error",
          `Conversation compaction failed: ${errMsg}`,
        );
        logger.signalWrite("failed", signalPaths.failed);
        return { exitCode: 1 };
      }

      // Check token budget after compaction (may trigger needs_approval).
      // Write scratchpad first so the summary survives for the next invocation.
      if (totalInputTokens + totalOutputTokens >= config.token_budget) {
        await writeScratchpad(summary);
        await writeNeedsApproval(
          signalPaths,
          agentName,
          config.token_budget,
          totalInputTokens,
          totalOutputTokens,
          null,
        );
        logger.signalWrite("needs_approval", signalPaths.needsApproval);
        return { exitCode: 0 };
      }

      // R5: Replace messages with single user message containing original task + summary
      messages = [
        {
          role: "user",
          content: `[Original Task]\n${userContent}\n\n[Conversation Summary]\n${summary}`,
        },
      ];

      // Clear stale stub metadata — old tool_use_ids no longer exist in messages
      stubMetadata.clear();

      // Re-estimate after compaction
      estimatedContextTokens = fixedCostTokens + estimatePayloadTokens([], [], messages);

      logger.contextCompacted(beforeTokens, estimatedContextTokens);

      // R14: If still over compaction threshold after compaction, write scratchpad + needs_approval
      if (estimatedContextTokens > compactionLimit) {
        await writeScratchpad(summary);
        await writeAgentNeedsApproval(
          signalPaths,
          agentName,
          `Context still exceeds threshold after compaction (${estimatedContextTokens} tokens > ${Math.round(compactionLimit)} limit)`,
        );
        logger.signalWrite("needs_approval", signalPaths.needsApproval);
        return { exitCode: 0 };
      }
    }

    // Pre-call guard: if still over 95%, fail (compaction either not enabled, already attempted, or succeeded but context still high)
    if (estimatedContextTokens > contextLimit) {
      logger.contextGuardTriggered(estimatedContextTokens, modelWindow);
      await writeFailed(
        signalPaths,
        agentName,
        "error",
        `Estimated context size (${estimatedContextTokens} tokens) exceeds 95% of model window (${modelWindow} tokens)`,
      );
      logger.signalWrite("failed", signalPaths.failed);
      return { exitCode: 1 };
    }

    let response: Anthropic.Message;
    const callStart = Date.now();
    try {
      response = await messagesClient.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemBlocks,
        tools,
        messages,
      });
    } catch (err) {
      if (isContextLengthError(err)) {
        await writeFailed(
          signalPaths,
          agentName,
          "error",
          `Context window overflow: ${err.message}`,
        );
        logger.signalWrite("failed", signalPaths.failed);
        return { exitCode: 1 };
      }
      const message = err instanceof Error ? err.message : String(err);
      await writeFailed(signalPaths, agentName, "error", `API error: ${message}`);
      logger.signalWrite("failed", signalPaths.failed);
      return { exitCode: 1 };
    }
    const callLatency = Date.now() - callStart;

    // Track usage after each API call
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    logger.apiCall(model, response.usage.input_tokens, response.usage.output_tokens, callLatency);

    // Post-call estimation drift detection: warn when heuristic diverges >30% from actual.
    if (response.usage.input_tokens > 0) {
      const ratio = estimatedContextTokens / response.usage.input_tokens;
      if (ratio > 1.3 || ratio < 0.7) {
        logger.contextEstimationDrift(estimatedContextTokens, response.usage.input_tokens, ratio);
      }
    }

    // Treat max_tokens truncation as a hard error (checked before budget)
    if (response.stop_reason === "max_tokens") {
      await writeFailed(
        signalPaths,
        agentName,
        "error",
        "Response truncated: stop_reason was 'max_tokens'. The model's output exceeded the per-call limit.",
        extractLastText(response),
      );
      logger.signalWrite("failed", signalPaths.failed);
      return { exitCode: 1 };
    }

    // Check token budget after each API call
    if (totalInputTokens + totalOutputTokens >= config.token_budget) {
      await writeNeedsApproval(
        signalPaths,
        agentName,
        config.token_budget,
        totalInputTokens,
        totalOutputTokens,
        extractLastText(response),
      );
      logger.signalWrite("needs_approval", signalPaths.needsApproval);
      return { exitCode: 0 };
    }

    // If no tool use, conversation is complete
    if (response.stop_reason !== "tool_use") {
      finalText = extractLastText(response);
      break;
    }

    // Extract and execute tool calls
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      // Intercept signal tool — records exit signal in local state, no I/O
      if (toolUse.name === "signal") {
        const input = toolUse.input as Record<string, unknown>;
        const rawType = input.type;
        if (rawType !== "complete" && rawType !== "needs_approval" && rawType !== "failed") {
          const errContent = JSON.stringify({
            error: "invalid_signal_type",
            message: `Invalid signal type: ${String(rawType)}. Must be "complete", "needs_approval", or "failed".`,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: errContent,
          });
          stubMetadata.set(toolUse.id, buildStubMetadata("signal", input, errContent));
          continue;
        }
        const signalMessage = typeof input.message === "string" ? input.message : undefined;
        recordedSignal = { type: rawType, message: signalMessage };
        logger.toolCall("signal", rawType, true, 0);
        const signalContent = JSON.stringify({ ok: true });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: signalContent,
        });
        stubMetadata.set(toolUse.id, buildStubMetadata("signal", input, signalContent));
        continue;
      }

      if (toolUse.name === "subagent" || toolUse.name === "Task") {
        const toolStart = Date.now();
        let result: string;
        try {
          result = await executeSubagentTool(
            toolUse.name,
            toolUse.input,
            cwd,
            config,
            messagesClient,
            subagentDepth,
            maxSubagentDepth,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          result = JSON.stringify({ error: "internal_error", message: errMsg });
        }
        const toolDuration = Date.now() - toolStart;
        const parsed = JSON.parse(result) as Record<string, unknown>;
        const permitted = parsed.error !== "permission_denied";
        const inp = toolUse.input as Record<string, unknown>;
        const target =
          typeof inp.agent === "string"
            ? inp.agent
            : typeof inp.subagent_type === "string"
              ? inp.subagent_type
              : toolUse.name;
        logger.toolCall(toolUse.name, target, permitted, toolDuration);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
        stubMetadata.set(toolUse.id, buildStubMetadata(toolUse.name, inp, result, parsed));
        continue;
      }

      const toolStart = Date.now();
      let result: string;
      try {
        result = await executeTool(toolUse.name, toolUse.input, cwd, config);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = JSON.stringify({ error: "internal_error", message: errMsg });
      }
      const toolDuration = Date.now() - toolStart;
      const parsed = JSON.parse(result) as Record<string, unknown>;
      const permitted = parsed.error !== "permission_denied";
      const inp = toolUse.input as Record<string, unknown>;
      const target =
        typeof inp.path === "string"
          ? inp.path
          : typeof inp.command === "string"
            ? inp.command
            : toolUse.name;
      logger.toolCall(toolUse.name, target, permitted, toolDuration);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
      stubMetadata.set(toolUse.id, buildStubMetadata(toolUse.name, inp, result, parsed));
    }

    // Prune prior turn tool results before appending new turn
    const estimatedTokens = estimatePayloadTokens(systemBlocks, tools, [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ]);
    const { messages: prunedMessages, prunedCount } = pruneMessages(
      messages,
      stubMetadata,
      config.context_management.pruning,
      estimatedTokens,
      config.context_management.pruning_threshold,
      modelWindow,
    );
    if (prunedCount > 0) {
      const afterTokens = estimatePayloadTokens(systemBlocks, tools, [
        ...prunedMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ]);
      logger.contextPruned(prunedCount, estimatedTokens - afterTokens);
    }

    // Append assistant response and tool results for next round
    messages = [
      ...prunedMessages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];
  }

  // Conversation complete — write signal based on recorded signal or default
  if (recordedSignal?.type === "complete") {
    await writeComplete(signalPaths);
    logger.signalWrite("complete", signalPaths.complete);
  } else if (recordedSignal?.type === "needs_approval") {
    await writeAgentNeedsApproval(signalPaths, agentName, recordedSignal.message);
    logger.signalWrite("needs_approval", signalPaths.needsApproval);
  } else if (recordedSignal?.type === "failed") {
    await writeFailed(
      signalPaths,
      agentName,
      "agent_failed",
      recordedSignal.message ?? "Agent signaled failure",
      recordedSignal.message,
    );
    logger.signalWrite("failed", signalPaths.failed);
  } else if (config.default_signal === "complete") {
    await writeComplete(signalPaths);
    logger.signalWrite("complete", signalPaths.complete);
  }
  // else: default_signal is "none" and no signal recorded — no file written, brr continues

  return { exitCode: 0, finalText };
}
