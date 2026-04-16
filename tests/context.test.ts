import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  estimatePayloadTokens,
  estimateTokens,
  getModelContextWindow,
  MODEL_CONTEXT_WINDOWS,
} from "../src/context.js";
import { Logger } from "../src/logger.js";

describe("estimateTokens", () => {
  it("returns Math.ceil(length / 3) for a normal string", () => {
    // "hello world" = 11 chars → ceil(11/3) = 4
    expect(estimateTokens("hello world")).toBe(4);
  });

  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for a single character", () => {
    // 1 char → ceil(1/3) = 1
    expect(estimateTokens("a")).toBe(1);
  });

  it("returns correct estimate for a string exactly divisible by 3", () => {
    // "abc" = 3 chars → ceil(3/3) = 1
    expect(estimateTokens("abc")).toBe(1);
  });
});

describe("getModelContextWindow", () => {
  it("matches claude-sonnet-4 prefix for claude-sonnet-4-6", () => {
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });

  it("matches longest prefix for claude-opus-4-5-20251101", () => {
    // Both "claude-opus-4" could match; longest prefix wins
    expect(getModelContextWindow("claude-opus-4-5-20251101")).toBe(200_000);
  });

  it("matches exact model ID", () => {
    expect(getModelContextWindow("claude-haiku-3")).toBe(200_000);
  });

  it("returns default 200_000 for unknown model", () => {
    expect(getModelContextWindow("unknown-model-v1")).toBe(200_000);
  });

  it("emits context_window_unknown when falling back to default", () => {
    const logger = new Logger(true);

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    const result = getModelContextWindow("unknown-model-v1", logger);

    process.stderr.write = original;

    expect(result).toBe(200_000);
    const lines = captured.trim().split("\n");
    expect(lines.length).toBe(1);

    const event = JSON.parse(lines[0]);
    expect(event.event).toBe("context_window_unknown");
    expect(event.model).toBe("unknown-model-v1");
    expect(event.fallback_window).toBe(200_000);
  });

  it("does not emit logger event when model is known", () => {
    const logger = new Logger(true);

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    getModelContextWindow("claude-sonnet-4-6", logger);

    process.stderr.write = original;

    expect(captured).toBe("");
  });

  it("does not throw when logger is omitted for unknown model", () => {
    expect(getModelContextWindow("unknown-model-v1")).toBe(200_000);
  });
});

describe("estimatePayloadTokens", () => {
  it("returns a positive number for a typical payload", () => {
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: "You are a helpful assistant." },
    ];
    const tools: Anthropic.Tool[] = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
        },
      },
    ];
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Hello, can you read a file?" },
    ];

    const result = estimatePayloadTokens(system, tools, messages);
    expect(result).toBeGreaterThan(0);
  });

  it("returns system + tools cost only when messages array is empty", () => {
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: "System prompt text." }];
    const tools: Anthropic.Tool[] = [
      {
        name: "write_file",
        description: "Write a file",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ];

    const withMessages = estimatePayloadTokens(system, tools, [
      { role: "user", content: "Some user message" },
    ]);
    const withoutMessages = estimatePayloadTokens(system, tools, []);

    expect(withoutMessages).toBeGreaterThan(0);
    expect(withMessages).toBeGreaterThan(withoutMessages);
  });

  it("returns 0 when all components are empty", () => {
    expect(estimatePayloadTokens([], [], [])).toBe(0);
  });

  it("sums estimates from system, tools, and messages independently", () => {
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: "System" }];
    const tools: Anthropic.Tool[] = [];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "User message" }];

    const systemOnly = estimatePayloadTokens(system, [], []);
    const messagesOnly = estimatePayloadTokens([], [], messages);
    const combined = estimatePayloadTokens(system, tools, messages);

    expect(combined).toBe(systemOnly + messagesOnly);
  });
});

describe("MODEL_CONTEXT_WINDOWS", () => {
  it("contains expected model prefixes", () => {
    expect(MODEL_CONTEXT_WINDOWS["claude-sonnet-4"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS["claude-opus-4"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS["claude-haiku-4"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS["claude-haiku-3"]).toBe(200_000);
  });
});
