import Anthropic from "@anthropic-ai/sdk";
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { AgentConfig } from "./config.js";
import { CompletionTracker } from "./completion.js";
import { checkPathPermission, checkCommandPermission, logDeniedCall } from "./permissions.js";
import { writeComplete, writeNeedsApproval, writeFailed, getSignalPaths } from "./signals.js";
import { readFile, listFiles, writeFile, patchFile, deleteFile, runCommand } from "./tools.js";
import { Logger } from "./logger.js";

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
    description: "List the contents of a directory at the given path relative to the working directory.",
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
    description: "Write content to a file at the given path, creating intermediate directories as needed.",
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
): { type: "path"; operation: "read" | "write" | "delete"; list: string[] } | { type: "command" } | null {
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
        return JSON.stringify(await readFile(resolvedPath));
      case "list_files":
        return JSON.stringify(await listFiles(resolvedPath));
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

  return JSON.stringify(await runCommand(command, args, cwd, config.command_timeout));
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
  const signalPaths = getSignalPaths(cwd);

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

  // Iteration loop — each iteration is a fresh API conversation.
  // Context does not accumulate across iterations (by design).
  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    logger.iterationStart(iterationCount);

    // R9: Inject scratchpad contents before task prompt if configured
    let userContent = taskPrompt;
    if (config.scratchpad !== null) {
      const scratchpadPath = resolve(cwd, config.scratchpad);
      // Containment check — scratchpad must be inside cwd
      let realCwd: string;
      try { realCwd = realpathSync(cwd); } catch { realCwd = cwd; }
      const normalizedCwd = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
      let realScratchpad: string | null;
      try { realScratchpad = realpathSync(scratchpadPath); } catch { realScratchpad = null; }
      if (realScratchpad !== null && (realScratchpad === realCwd || realScratchpad.startsWith(normalizedCwd))) {
        const scratchpadFile = Bun.file(realScratchpad);
        if (await scratchpadFile.exists()) {
          const scratchpadContent = await scratchpadFile.text();
          if (scratchpadContent.trim().length > 0) {
            userContent = `[Previous Context]\n${scratchpadContent}\n\n[Task]\n${taskPrompt}`;
          }
        }
      }
    }

    let messages: Anthropic.MessageParam[] = [
      { role: "user", content: userContent },
    ];

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
        await writeFailed(cwd, agentName, "error", `API error: ${message}`);
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
          cwd,
          agentName,
          "error",
          "Response truncated: stop_reason was 'max_tokens'. The model's output exceeded the per-call limit.",
        );
        logger.signalWrite("failed", signalPaths.failed);
        return { exitCode: 1 };
      }

      // Check token budget after each API call
      if (totalInputTokens + totalOutputTokens >= config.token_budget) {
        await writeNeedsApproval(cwd, agentName, config.token_budget, totalInputTokens, totalOutputTokens);
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
        const result = await executeTool(
          toolUse.name,
          toolUse.input,
          cwd,
          config,
        );
        const toolDuration = Date.now() - toolStart;
        const parsed = JSON.parse(result) as Record<string, unknown>;
        const permitted = parsed.error !== "permission_denied";
        const target = typeof (toolUse.input as Record<string, unknown>)?.path === "string"
          ? (toolUse.input as Record<string, unknown>).path as string
          : typeof (toolUse.input as Record<string, unknown>)?.command === "string"
            ? (toolUse.input as Record<string, unknown>).command as string
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
      await writeComplete(cwd);
      logger.signalWrite("complete", signalPaths.complete);
      return { exitCode: 0 };
    }
    if (completionStatus === "no_progress") {
      await writeFailed(
        cwd,
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
    await writeComplete(cwd);
    logger.signalWrite("complete", signalPaths.complete);
    return { exitCode: 0 };
  }
  await writeFailed(
    cwd,
    agentName,
    "error",
    `Maximum iteration limit (${MAX_ITERATIONS}) reached without completion.`,
  );
  logger.signalWrite("failed", signalPaths.failed);
  return { exitCode: 1 };
}
