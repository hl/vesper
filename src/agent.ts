import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CompletionTracker } from "./completion.js";
import type { AgentConfig } from "./config.js";
import { Logger } from "./logger.js";
import { checkCommandPermission, checkPathPermission, logDeniedCall } from "./permissions.js";
import { getSignalPaths, writeComplete, writeFailed, writeNeedsApproval } from "./signals.js";
import { deleteFile, listFiles, patchFile, readFile, runCommand, writeFile } from "./tools.js";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250514";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ITERATIONS = 1000;

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
    },
    strict: true,
  },
];

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
  const normalizedCwd = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
  let realTarget: string | null;
  try {
    realTarget = realpathSync(targetPath);
  } catch {
    realTarget = null;
  }
  if (realTarget !== null && (realTarget === realCwd || realTarget.startsWith(normalizedCwd))) {
    return realTarget;
  }
  return null;
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
      const content = readFileSync(resolve(realDir, filename), "utf-8");
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

// R3: Filter tool definitions to only include tools the agent has permission to use
function filterTools(config: AgentConfig): Anthropic.Tool[] {
  const toolPermissionMap: Record<string, string[]> = {
    read_file: config.tools.read,
    list_files: config.tools.read,
    write_file: config.tools.write,
    patch_file: config.tools.write,
    delete_file: config.tools.delete,
    run_command: config.tools.commands,
  };
  const filtered = TOOL_DEFINITIONS.filter((tool) => {
    const list = toolPermissionMap[tool.name];
    return list !== undefined && list.length > 0;
  });
  // R2: Apply cache_control to the last tool definition for prompt caching
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    filtered[filtered.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  }
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

    const resolvedPath = resolve(cwd, path);

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
}

/** Minimal interface for the Anthropic messages API, enabling test stubs. */
export interface MessageClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export async function runAgent(
  config: AgentConfig,
  systemPrompt: string,
  taskPrompt: string,
  cwd: string,
  agentName: string,
  client?: MessageClient,
): Promise<RunAgentResult> {
  const messagesClient: MessageClient = client ?? new Anthropic().messages;
  const tracker = new CompletionTracker(
    config.completion.watch_file,
    config.completion.no_progress_limit,
    cwd,
  );
  const logger = new Logger(config.log_events);
  const signalPaths = getSignalPaths(cwd, config.signals);

  // R1: Configurable model per agent
  const model = config.model ?? DEFAULT_MODEL;

  // R3: Filter tools to match permissions; R2: cache_control applied inside filterTools
  const tools = filterTools(config);
  const toolsParam = tools.length > 0 ? tools : undefined;

  // R2: System prompt as structured content block with cache_control
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let iterationCount = 0;

  // Load skills once before the iteration loop (R6)
  const skillsContent = config.skills !== null ? loadSkills(config.skills, cwd, logger) : null;

  // Iteration loop — each iteration is a fresh API conversation.
  // Context does not accumulate across iterations (by design).
  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    logger.iterationStart(iterationCount);

    // Build user message: [Skills] → [Previous Context] → [Task]
    let userContent = taskPrompt;

    // R9: Inject scratchpad contents (re-read each iteration to capture agent writes)
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

    // Tool loop within this iteration
    while (true) {
      let response: Anthropic.Message;
      const callStart = Date.now();
      try {
        response = await messagesClient.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemBlocks,
          tools: toolsParam,
          messages,
        });
      } catch (err) {
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

      // R12: Treat max_tokens truncation as a hard error (checked before budget)
      if (response.stop_reason === "max_tokens") {
        await writeFailed(
          signalPaths,
          agentName,
          "error",
          "Response truncated: stop_reason was 'max_tokens'. The model's output exceeded the per-call limit.",
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
        );
        logger.signalWrite("needs_approval", signalPaths.needsApproval);
        return { exitCode: 0 };
      }

      // If no tool use, iteration is complete
      if (response.stop_reason !== "tool_use") {
        break;
      }

      // Extract and execute tool calls
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const toolStart = Date.now();
        const result = await executeTool(toolUse.name, toolUse.input, cwd, config);
        const toolDuration = Date.now() - toolStart;
        const parsed = JSON.parse(result) as Record<string, unknown>;
        const permitted = parsed.error !== "permission_denied";
        const target =
          typeof (toolUse.input as Record<string, unknown>)?.path === "string"
            ? ((toolUse.input as Record<string, unknown>).path as string)
            : typeof (toolUse.input as Record<string, unknown>)?.command === "string"
              ? ((toolUse.input as Record<string, unknown>).command as string)
              : toolUse.name;
        logger.toolCall(toolUse.name, target as string, permitted, toolDuration);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Append assistant response and tool results for next round
      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];
    }

    // Check completion condition
    const completionStatus = await tracker.check();
    logger.completionCheck(completionStatus);

    if (completionStatus === "complete") {
      await writeComplete(signalPaths);
      logger.signalWrite("complete", signalPaths.complete);
      return { exitCode: 0 };
    }
    if (completionStatus === "no_progress") {
      await writeFailed(
        signalPaths,
        agentName,
        "no_progress",
        `No progress detected after ${config.completion.no_progress_limit} consecutive iterations.`,
      );
      logger.signalWrite("failed", signalPaths.failed);
      return { exitCode: 1 };
    }

    // "continue" — next iteration
  }

  // Max iterations reached
  if (config.completion.watch_file === null) {
    await writeComplete(signalPaths);
    logger.signalWrite("complete", signalPaths.complete);
    return { exitCode: 0 };
  }
  await writeFailed(
    signalPaths,
    agentName,
    "error",
    `Maximum iteration limit (${MAX_ITERATIONS}) reached without completion.`,
  );
  logger.signalWrite("failed", signalPaths.failed);
  return { exitCode: 1 };
}
