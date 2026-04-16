import type Anthropic from "@anthropic-ai/sdk";
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
