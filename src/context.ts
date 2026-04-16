import type Anthropic from "@anthropic-ai/sdk";
import type { MessageClient } from "./agent.js";
import type { ContextManagementConfig } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * Known model context windows. Keyed by model ID prefix.
 * Longest prefix match wins in getModelContextWindow.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-haiku-3": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Estimate token count for a text string using chars/3 heuristic.
 * Returns 0 for empty strings.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3);
}

/**
 * Estimate total token count for an API payload (system blocks, tool definitions, messages).
 * Serializes each component with JSON.stringify and sums the estimates.
 * System + tools are fixed per invocation; the caller can cache these.
 */
export function estimatePayloadTokens(
  system: Anthropic.TextBlockParam[],
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
): number {
  let total = 0;
  for (const block of system) {
    total += estimateTokens(JSON.stringify(block));
  }
  for (const tool of tools) {
    total += estimateTokens(JSON.stringify(tool));
  }
  for (const message of messages) {
    total += estimateTokens(JSON.stringify(message));
  }
  return total;
}

/**
 * Look up the context window size for a model ID using longest-prefix matching.
 * When no prefix matches, returns 200,000 (conservative default) and emits
 * a context_window_unknown logger event if a logger is provided.
 */
export function getModelContextWindow(model: string, logger?: Logger): number {
  let bestPrefix = "";
  let bestWindow = 0;

  for (const [prefix, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestWindow = window;
    }
  }

  if (bestPrefix.length > 0) {
    return bestWindow;
  }

  if (logger) {
    logger.contextWindowUnknown(model, DEFAULT_CONTEXT_WINDOW);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Stub metadata & pruning
// ---------------------------------------------------------------------------

/**
 * Metadata captured from a tool result during execution, used to generate
 * a compact stub string when pruning old tool results.
 */
export interface StubMetadata {
  toolName: string;
  /** File path or command string — the primary "target" of the tool call. */
  target: string;
  /** "ok" | "error" | specific status for the outcome column. */
  outcome: string;
  /** Optional size info (e.g. "142 lines, 3KB" or "12KB stdout"). */
  size?: string;
}

/**
 * Generate a compact stub string from metadata.
 * Format: `[tool_name: target — outcome, size]` or `[tool_name: target — outcome]`
 */
export function generateStub(meta: StubMetadata): string {
  if (meta.size) {
    return `[${meta.toolName}: ${meta.target} — ${meta.outcome}, ${meta.size}]`;
  }
  return `[${meta.toolName}: ${meta.target} — ${meta.outcome}]`;
}

/**
 * Build StubMetadata from a tool execution result.
 * Called after tool execution in the agent loop, using the post-truncation result string.
 */
export function buildStubMetadata(
  toolName: string,
  input: Record<string, unknown>,
  resultString: string,
): StubMetadata {
  switch (toolName) {
    case "read_file":
    case "list_files": {
      const path = typeof input.path === "string" ? input.path : "unknown";
      // Parse the JSON result to count newlines in the actual file content,
      // not the JSON-escaped string where \n becomes two chars (backslash + n).
      let content = resultString;
      try {
        const parsed = JSON.parse(resultString) as Record<string, unknown>;
        if (typeof parsed.content === "string") {
          content = parsed.content;
        }
      } catch {
        // Fall back to raw string if JSON parsing fails
      }
      const lineCount = (content.match(/\n/g) || []).length;
      const byteSize = Buffer.byteLength(content, "utf-8");
      const sizeStr = formatSize(byteSize);
      return {
        toolName,
        target: path,
        outcome: `${lineCount} lines`,
        size: sizeStr,
      };
    }
    case "write_file":
    case "delete_file": {
      const path = typeof input.path === "string" ? input.path : "unknown";
      let outcome = "ok";
      try {
        const parsed = JSON.parse(resultString) as Record<string, unknown>;
        if (parsed.error) {
          outcome = `error: ${String(parsed.error)}`;
        }
      } catch {
        // keep "ok" default
      }
      return { toolName, target: path, outcome };
    }
    case "patch_file": {
      const path = typeof input.path === "string" ? input.path : "unknown";
      let outcome = "ok";
      let hunkCount: number | undefined;
      try {
        const parsed = JSON.parse(resultString) as Record<string, unknown>;
        if (parsed.error) {
          outcome = `error: ${String(parsed.error)}`;
        }
      } catch {
        // keep "ok" default
      }
      // Count hunks from the patch input
      if (typeof input.patch === "string") {
        hunkCount = (input.patch.match(/^@@\s/gm) || []).length;
      }
      const size = hunkCount !== undefined ? `${hunkCount} hunks` : undefined;
      return { toolName, target: path, outcome, size };
    }
    case "run_command": {
      const command = typeof input.command === "string" ? input.command : "unknown";
      const args = Array.isArray(input.args) ? (input.args as string[]).join(" ") : "";
      const target = args ? `${command} ${args}` : command;
      let exitCode = 0;
      let stdoutSize = 0;
      try {
        const parsed = JSON.parse(resultString) as Record<string, unknown>;
        if (typeof parsed.exit_code === "number") {
          exitCode = parsed.exit_code;
        }
        if (typeof parsed.stdout === "string") {
          stdoutSize = Buffer.byteLength(parsed.stdout, "utf-8");
        }
      } catch {
        // keep defaults
      }
      return {
        toolName,
        target,
        outcome: `exit ${exitCode}`,
        size: `${formatSize(stdoutSize)} stdout`,
      };
    }
    case "signal": {
      // Signal tool results are simple `{ ok: true }` or error objects
      let outcome = "ok";
      try {
        const parsed = JSON.parse(resultString) as Record<string, unknown>;
        if (parsed.error) {
          outcome = `error: ${String(parsed.error)}`;
        }
      } catch {
        // keep "ok" default
      }
      const signalType = typeof input.type === "string" ? input.type : "unknown";
      return { toolName, target: signalType, outcome };
    }
    default: {
      // Unknown tool — use generic metadata
      const target =
        typeof input.path === "string"
          ? input.path
          : typeof input.command === "string"
            ? input.command
            : toolName;
      return { toolName, target, outcome: "ok" };
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}KB`;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer for an agentic coding assistant. Your job is to produce a structured summary of the conversation so far, optimized for agentic continuity — the agent will use this summary to continue working effectively.

Produce a summary with these sections:

## Accomplished
- What tasks or sub-tasks have been completed
- Key decisions made and their rationale

## Files Modified
- List each file that was created, modified, or deleted, with a brief note on what changed

## Commands Run
- List commands executed and their outcomes (success/failure, key output)

## Current State
- What is the working state right now (e.g., tests passing, build broken, partially implemented)
- Any errors or issues that were encountered but not yet resolved

## Remaining Work
- What tasks or sub-tasks still need to be done
- Any blockers or open questions

Be concise but preserve all information the agent needs to continue the work. Do not include pleasantries or meta-commentary.`;

const COMPACTION_MAX_TOKENS = 8192;

/**
 * Compact a conversation by summarizing it via an extra API call.
 * Returns the summary text and usage for budget tracking.
 *
 * Throws if the API call fails or if the response is truncated (stop_reason === "max_tokens"),
 * per R9 — callers should catch and write a failed signal.
 */
export async function compactConversation(
  client: MessageClient,
  model: string,
  messages: Anthropic.MessageParam[],
  userContent: string,
  maxTokens?: number,
): Promise<{ summary: string; usage: Anthropic.Usage }> {
  const compactionMessages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Please summarize the following conversation for agentic continuity.\n\nOriginal task:\n${userContent}\n\nConversation:\n${JSON.stringify(messages)}`,
    },
  ];

  const response = await client.create({
    model,
    max_tokens: maxTokens ?? COMPACTION_MAX_TOKENS,
    system: [{ type: "text", text: COMPACTION_SYSTEM_PROMPT }],
    messages: compactionMessages,
  });

  // R9: Treat max_tokens truncation as a compaction failure
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Compaction response was truncated (stop_reason: max_tokens). Summary may be incomplete.",
    );
  }

  // Extract text from the response
  let summary = "";
  for (const block of response.content) {
    if (block.type === "text") {
      summary += block.text;
    }
  }

  if (summary.trim().length === 0) {
    throw new Error("Compaction produced an empty summary.");
  }

  return { summary: summary.trim(), usage: response.usage };
}

/**
 * Prune tool results from prior turns by replacing their content with stub strings.
 *
 * - `off`: return messages unchanged
 * - `always`: replace tool_result content in all user messages with tool results
 * - `threshold`: same as `always` but only when estimatedTokens > threshold * modelWindow
 *
 * Returns a new array (shallow copy); original messages are not mutated.
 * messages[0] (initial user task) is never modified.
 *
 * R3 (most recent turn protection) is handled by the caller: this function is called
 * on the existing messages array BEFORE the current turn's tool results are appended,
 * so the current turn is never in the input.
 */
export function pruneMessages(
  messages: Anthropic.MessageParam[],
  metadata: Map<string, StubMetadata>,
  strategy: ContextManagementConfig["pruning"],
  estimatedTokens: number,
  threshold: number,
  modelWindow: number,
): { messages: Anthropic.MessageParam[]; prunedCount: number } {
  if (strategy === "off") {
    return { messages, prunedCount: 0 };
  }

  if (strategy === "threshold" && estimatedTokens <= threshold * modelWindow) {
    return { messages, prunedCount: 0 };
  }

  let prunedCount = 0;
  const result: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Never modify messages[0] (initial user task) or non-user messages
    if (i === 0 || msg.role !== "user") {
      result.push(msg);
      continue;
    }

    // Only prune user messages that contain tool_result blocks (array content)
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    // msg.content is an array of ContentBlockParam (since we checked !Array.isArray above)
    const contentArr = msg.content as Exclude<Anthropic.MessageParam["content"], string>;
    const newContent: typeof contentArr = [];
    let messageModified = false;

    for (const block of contentArr) {
      if (typeof block === "string") {
        // String content in user messages — pass through
        newContent.push(block as unknown as (typeof contentArr)[number]);
        continue;
      }

      if (block.type !== "tool_result") {
        newContent.push(block);
        continue;
      }

      const toolResult = block;

      // Skip blocks with array content (unexpected format per plan)
      if (Array.isArray(toolResult.content)) {
        newContent.push(toolResult);
        continue;
      }

      const meta = metadata.get(toolResult.tool_use_id);
      if (meta) {
        const stub = generateStub(meta);
        newContent.push({
          type: "tool_result",
          tool_use_id: toolResult.tool_use_id,
          content: stub,
        });
        prunedCount++;
        messageModified = true;
      } else {
        // No metadata — leave unchanged
        newContent.push(toolResult);
      }
    }

    if (messageModified) {
      result.push({ role: "user", content: newContent });
    } else {
      result.push(msg);
    }
  }

  return { messages: result, prunedCount };
}
