import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import { CompletionTracker } from "./completion.js";
import { checkPathPermission, checkCommandPermission, logDeniedCall } from "./permissions.js";
import { writeComplete, writeNeedsApproval, writeFailed } from "./signals.js";
import { readFile, listFiles, writeFile, patchFile, deleteFile, runCommand } from "./tools.js";

const MODEL = "claude-sonnet-4-5-20250514";
const MAX_OUTPUT_TOKENS = 4096;

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

async function executeTool(
  toolName: string,
  input: unknown,
  cwd: string,
  config: AgentConfig,
): Promise<string> {
  const perm = getPermissionList(toolName, config);
  if (perm === null) {
    return JSON.stringify({ error: "permission_denied" });
  }

  const inp = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  if (perm.type === "path") {
    const path = validateString(inp, "path");
    if (path === null) {
      return JSON.stringify({ error: "permission_denied" });
    }
    if (!checkPathPermission(path, cwd, perm.list)) {
      if (config.log_denied_calls) {
        logDeniedCall(toolName, path);
      }
      return JSON.stringify({ error: "permission_denied" });
    }

    const resolvedPath = resolve(cwd, path);

    switch (toolName) {
      case "read_file":
        return JSON.stringify(await readFile(resolvedPath));
      case "list_files":
        return JSON.stringify(await listFiles(resolvedPath));
      case "write_file": {
        const content = validateString(inp, "content");
        if (content === null) return JSON.stringify({ error: "permission_denied" });
        return JSON.stringify(await writeFile(resolvedPath, content));
      }
      case "patch_file": {
        const patch = validateString(inp, "patch");
        if (patch === null) return JSON.stringify({ error: "permission_denied" });
        return JSON.stringify(await patchFile(resolvedPath, patch));
      }
      case "delete_file":
        return JSON.stringify(await deleteFile(resolvedPath));
      default:
        return JSON.stringify({ error: "permission_denied" });
    }
  }

  // Command
  const command = validateString(inp, "command");
  const args = validateStringArray(inp, "args") ?? [];
  if (command === null) {
    return JSON.stringify({ error: "permission_denied" });
  }
  if (!checkCommandPermission(command, args, config.tools.commands)) {
    if (config.log_denied_calls) {
      logDeniedCall(toolName, `${command} ${args.join(" ")}`);
    }
    return JSON.stringify({ error: "permission_denied" });
  }

  return JSON.stringify(await runCommand(command, args, cwd));
}

export interface RunAgentResult {
  exitCode: number;
}

export async function runAgent(
  config: AgentConfig,
  systemPrompt: string,
  taskPrompt: string,
  cwd: string,
  agentName: string,
): Promise<RunAgentResult> {
  const client = new Anthropic();
  const tracker = new CompletionTracker(
    config.completion.watch_file,
    config.completion.no_progress_limit,
    cwd,
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Iteration loop — each iteration is a fresh API conversation.
  // Context does not accumulate across iterations (by design).
  while (true) {
    let messages: Anthropic.MessageParam[] = [
      { role: "user", content: taskPrompt },
    ];

    // Tool loop within this iteration
    while (true) {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          tools: TOOL_DEFINITIONS,
          messages,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await writeFailed(cwd, agentName, "error", `API error: ${message}`);
        return { exitCode: 1 };
      }

      // Track usage after each API call
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Check token budget after each API call (not just after iteration)
      if (totalInputTokens + totalOutputTokens >= config.token_budget) {
        await writeNeedsApproval(cwd, agentName, config.token_budget, totalInputTokens, totalOutputTokens);
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
        const result = await executeTool(
          toolUse.name,
          toolUse.input,
          cwd,
          config,
        );
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
    if (completionStatus === "complete") {
      await writeComplete(cwd);
      return { exitCode: 0 };
    }
    if (completionStatus === "no_progress") {
      await writeFailed(
        cwd,
        agentName,
        "no_progress",
        `No progress detected after ${config.completion.no_progress_limit} consecutive iterations.`,
      );
      return { exitCode: 1 };
    }

    // "continue" — next iteration
  }
}
