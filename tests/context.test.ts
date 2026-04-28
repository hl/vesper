import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageClient } from "../src/agent.js";
import {
  buildStubMetadata,
  compactConversation,
  estimatePayloadTokens,
  estimateTokens,
  generateStub,
  getModelContextWindow,
  MODEL_CONTEXT_WINDOWS,
  pruneMessages,
  type StubMetadata,
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

// ---------------------------------------------------------------------------
// generateStub
// ---------------------------------------------------------------------------

describe("generateStub", () => {
  it("generates stub with size when present", () => {
    const meta: StubMetadata = {
      toolName: "read_file",
      target: "src/main.ts",
      outcome: "42 lines",
      size: "3KB",
    };
    expect(generateStub(meta)).toBe("[read_file: src/main.ts — 42 lines, 3KB]");
  });

  it("generates stub without size when absent", () => {
    const meta: StubMetadata = {
      toolName: "write_file",
      target: "out.txt",
      outcome: "ok",
    };
    expect(generateStub(meta)).toBe("[write_file: out.txt — ok]");
  });
});

// ---------------------------------------------------------------------------
// buildStubMetadata
// ---------------------------------------------------------------------------

describe("buildStubMetadata", () => {
  it("builds metadata for read_file with correct line count", () => {
    const result = JSON.stringify({ content: "line1\nline2\nline3" });
    const meta = buildStubMetadata("read_file", { path: "src/app.ts" }, result);
    expect(meta.toolName).toBe("read_file");
    expect(meta.target).toBe("src/app.ts");
    expect(meta.outcome).toBe("3 lines");
    expect(meta.size).toBeDefined();
  });

  it("builds metadata for read_file without counting trailing newline as an extra line", () => {
    const result = JSON.stringify({ content: "line1\nline2\n" });
    const meta = buildStubMetadata("read_file", { path: "src/app.ts" }, result);
    expect(meta.outcome).toBe("2 lines");
  });

  it("builds metadata for write_file ok result", () => {
    const result = JSON.stringify({ ok: true });
    const meta = buildStubMetadata("write_file", { path: "out.txt", content: "data" }, result);
    expect(meta.toolName).toBe("write_file");
    expect(meta.target).toBe("out.txt");
    expect(meta.outcome).toBe("ok");
    expect(meta.size).toBeUndefined();
  });

  it("builds metadata for write_file error result", () => {
    const result = JSON.stringify({ error: "permission_denied" });
    const meta = buildStubMetadata("write_file", { path: "secret.txt", content: "x" }, result);
    expect(meta.outcome).toBe("error: permission_denied");
  });

  it("builds metadata for patch_file with hunks", () => {
    const patch = "@@ -1,3 +1,3 @@\n-old\n+new\n@@ -10,3 +10,3 @@\n-x\n+y";
    const result = JSON.stringify({ ok: true });
    const meta = buildStubMetadata("patch_file", { path: "file.ts", patch }, result);
    expect(meta.toolName).toBe("patch_file");
    expect(meta.target).toBe("file.ts");
    expect(meta.outcome).toBe("ok");
    expect(meta.size).toBe("2 hunks");
  });

  it("builds metadata for run_command", () => {
    const result = JSON.stringify({ stdout: "hello\nworld\n", stderr: "", exit_code: 0 });
    const meta = buildStubMetadata("run_command", { command: "echo", args: ["hello"] }, result);
    expect(meta.toolName).toBe("run_command");
    expect(meta.target).toBe("echo hello");
    expect(meta.outcome).toBe("exit 0");
    expect(meta.size).toContain("stdout");
  });

  it("builds metadata for run_command with non-zero exit code", () => {
    const result = JSON.stringify({ stdout: "", stderr: "not found", exit_code: 1 });
    const meta = buildStubMetadata("run_command", { command: "ls", args: ["-la"] }, result);
    expect(meta.outcome).toBe("exit 1");
  });

  it("builds metadata for signal tool", () => {
    const result = JSON.stringify({ ok: true });
    const meta = buildStubMetadata("signal", { type: "complete" }, result);
    expect(meta.toolName).toBe("signal");
    expect(meta.target).toBe("complete");
    expect(meta.outcome).toBe("ok");
  });

  it("builds metadata for subagent tool", () => {
    const result = JSON.stringify({ ok: true, signal: "complete", exit_code: 0 });
    const meta = buildStubMetadata("subagent", { agent: "reviewer" }, result);
    expect(meta.toolName).toBe("subagent");
    expect(meta.target).toBe("reviewer");
    expect(meta.outcome).toBe("complete");
    expect(meta.size).toBe("exit 0");
  });

  it("builds metadata for Task alias", () => {
    const result = JSON.stringify({ ok: true, signal: "needs_approval", exit_code: 0 });
    const meta = buildStubMetadata("Task", { subagent_type: "reviewer" }, result);
    expect(meta.toolName).toBe("Task");
    expect(meta.target).toBe("reviewer");
    expect(meta.outcome).toBe("needs_approval");
    expect(meta.size).toBe("exit 0");
  });

  it("builds metadata for delete_file", () => {
    const result = JSON.stringify({ ok: true });
    const meta = buildStubMetadata("delete_file", { path: "tmp.txt" }, result);
    expect(meta.toolName).toBe("delete_file");
    expect(meta.target).toBe("tmp.txt");
    expect(meta.outcome).toBe("ok");
  });

  it("builds metadata for list_files", () => {
    const result = JSON.stringify({ entries: ["a.txt", "b.txt", "c.txt"] });
    const meta = buildStubMetadata("list_files", { path: "src" }, result);
    expect(meta.toolName).toBe("list_files");
    expect(meta.target).toBe("src");
    expect(meta.outcome).toBe("3 entries");
    expect(meta.size).toBeUndefined();
  });

  it("builds metadata for list_files with truncated results", () => {
    const result = JSON.stringify({
      entries: ["a.txt", "b.txt"],
      truncated: true,
      total_entries: 500,
    });
    const meta = buildStubMetadata("list_files", { path: "src" }, result);
    expect(meta.outcome).toBe("2+ entries");
  });

  it("reports error for read_file when file not found", () => {
    const result = JSON.stringify({ error: "not_found" });
    const meta = buildStubMetadata("read_file", { path: "missing.ts" }, result);
    expect(meta.toolName).toBe("read_file");
    expect(meta.target).toBe("missing.ts");
    expect(meta.outcome).toBe("error: not_found");
    expect(meta.size).toBeUndefined();
  });

  it("reports error for list_files when directory not found", () => {
    const result = JSON.stringify({ error: "not_found" });
    const meta = buildStubMetadata("list_files", { path: "no-such-dir" }, result);
    expect(meta.toolName).toBe("list_files");
    expect(meta.target).toBe("no-such-dir");
    expect(meta.outcome).toBe("error: not_found");
  });

  it("reports error for run_command when denied", () => {
    const result = JSON.stringify({ error: "permission_denied" });
    const meta = buildStubMetadata("run_command", { command: "rm", args: ["-rf"] }, result);
    expect(meta.toolName).toBe("run_command");
    expect(meta.target).toBe("rm -rf");
    expect(meta.outcome).toBe("error: permission_denied");
    expect(meta.size).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pruneMessages
// ---------------------------------------------------------------------------

describe("pruneMessages", () => {
  // Helper to build a typical 3-turn conversation:
  // messages[0]: user task (string content)
  // messages[1]: assistant with tool_use
  // messages[2]: user with tool_result (turn 1)
  // messages[3]: assistant with tool_use
  // messages[4]: user with tool_result (turn 2 — most recent)
  function buildConversation() {
    const metadata = new Map<string, StubMetadata>();

    metadata.set("toolu_1", {
      toolName: "read_file",
      target: "src/main.ts",
      outcome: "50 lines",
      size: "2KB",
    });
    metadata.set("toolu_2", {
      toolName: "write_file",
      target: "out.txt",
      outcome: "ok",
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Do the task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read_file",
            input: { path: "src/main.ts" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: JSON.stringify({ content: "x".repeat(500) }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "write_file",
            input: { path: "out.txt", content: "data" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: JSON.stringify({ ok: true }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];

    return { messages, metadata };
  }

  it("returns messages unchanged when strategy is off", () => {
    const { messages, metadata } = buildConversation();
    const result = pruneMessages(messages, metadata, "off", 100_000, 0.7, 200_000);
    expect(result.messages).toBe(messages); // Same reference
    expect(result.prunedCount).toBe(0);
  });

  it("prunes all tool_result user messages when strategy is always", () => {
    const { messages, metadata } = buildConversation();
    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);

    expect(result.prunedCount).toBe(2);
    // messages[0] unchanged (initial user task)
    expect(result.messages[0].content).toBe("Do the task");
    // messages[2] should be pruned (first tool result)
    const prunedContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent[0].content).toBe("[read_file: src/main.ts — 50 lines, 2KB]");
    // messages[4] should also be pruned
    const lastContent = result.messages[4].content as Anthropic.ToolResultBlockParam[];
    expect(lastContent[0].content).toBe("[write_file: out.txt — ok]");
  });

  it("preserves tool_use_id on pruned blocks", () => {
    const { messages, metadata } = buildConversation();
    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    const prunedContent2 = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent2[0].tool_use_id).toBe("toolu_1");
    expect(prunedContent2[0].type).toBe("tool_result");
    const prunedContent4 = result.messages[4].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent4[0].tool_use_id).toBe("toolu_2");
    expect(prunedContent4[0].type).toBe("tool_result");
  });

  it("does not prune when threshold strategy is below threshold", () => {
    const { messages, metadata } = buildConversation();
    // estimatedTokens=100_000, threshold=0.7, modelWindow=200_000
    // 100_000 <= 0.7 * 200_000 (140_000) → no pruning
    const result = pruneMessages(messages, metadata, "threshold", 100_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(0);
    // messages should be the same reference (unchanged)
    expect(result.messages).toBe(messages);
  });

  it("prunes when threshold strategy is above threshold", () => {
    const { messages, metadata } = buildConversation();
    // estimatedTokens=150_000, threshold=0.7, modelWindow=200_000
    // 150_000 > 0.7 * 200_000 (140_000) → prune
    const result = pruneMessages(messages, metadata, "threshold", 150_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(2);
    const prunedContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent[0].content).toContain("[read_file:");
  });

  it("never modifies messages[0] (initial user task)", () => {
    const { messages, metadata } = buildConversation();
    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    expect(result.messages[0]).toBe(messages[0]); // Same reference
    expect(result.messages[0].content).toBe("Do the task");
  });

  it("prunes all tool_result messages (R3 most-recent protection is caller's responsibility)", () => {
    // pruneMessages prunes all tool_result user messages in the input.
    // R3 (most recent turn protection) is ensured by the caller: the current
    // turn's tool results are appended AFTER pruneMessages runs, so they
    // are never in the input.
    const { messages, metadata } = buildConversation();
    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    // Both messages[2] and messages[4] are pruned
    expect(result.prunedCount).toBe(2);
    const content2 = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(content2[0].content).toContain("[read_file:");
    const content4 = result.messages[4].content as Anthropic.ToolResultBlockParam[];
    expect(content4[0].content).toContain("[write_file:");
  });

  it("prunes signal tool results like any other tool result", () => {
    const metadata = new Map<string, StubMetadata>();
    metadata.set("toolu_sig", {
      toolName: "signal",
      target: "complete",
      outcome: "ok",
    });
    metadata.set("toolu_2", {
      toolName: "read_file",
      target: "file.ts",
      outcome: "10 lines",
      size: "1KB",
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_sig",
            name: "signal",
            input: { type: "complete" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sig",
            content: JSON.stringify({ ok: true }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "read_file",
            input: { path: "file.ts" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: JSON.stringify({ content: "data" }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];

    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(2);
    const prunedContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent[0].content).toBe("[signal: complete — ok]");
    const prunedContent4 = result.messages[4].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent4[0].content).toBe("[read_file: file.ts — 10 lines, 1KB]");
  });

  it("skips tool_result blocks with array content", () => {
    const metadata = new Map<string, StubMetadata>();
    metadata.set("toolu_arr", {
      toolName: "read_file",
      target: "file.ts",
      outcome: "10 lines",
      size: "1KB",
    });
    metadata.set("toolu_last", {
      toolName: "read_file",
      target: "other.ts",
      outcome: "5 lines",
      size: "500B",
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_arr",
            name: "read_file",
            input: { path: "file.ts" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_arr",
            // Array content — should be skipped
            content: [{ type: "text", text: "data" }],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_last",
            name: "read_file",
            input: { path: "other.ts" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_last",
            content: "original content",
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];

    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    // The array-content block (toolu_arr) should NOT be pruned; toolu_last IS pruned
    expect(result.prunedCount).toBe(1);
    const firstToolContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(Array.isArray(firstToolContent[0].content)).toBe(true);
    // Verify toolu_last was pruned
    const lastToolContent = result.messages[4].content as Anthropic.ToolResultBlockParam[];
    expect(lastToolContent[0].content).toContain("[read_file:");
  });

  it("handles conversation with only one user message (initial task)", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Task" }];
    const metadata = new Map<string, StubMetadata>();
    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(0);
    expect(result.messages.length).toBe(1);
  });

  it("handles write_file stub format correctly", () => {
    const metadata = new Map<string, StubMetadata>();
    metadata.set("toolu_w", {
      toolName: "write_file",
      target: "path/to/file.ts",
      outcome: "ok",
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_w",
            name: "write_file",
            input: { path: "path/to/file.ts", content: "data" },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_w",
            content: JSON.stringify({ ok: true }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];

    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(1);
    const prunedContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent[0].content).toBe("[write_file: path/to/file.ts — ok]");
  });

  it("handles run_command stub format correctly", () => {
    const metadata = new Map<string, StubMetadata>();
    metadata.set("toolu_cmd", {
      toolName: "run_command",
      target: "echo hello",
      outcome: "exit 0",
      size: "6B stdout",
    });

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_cmd",
            name: "run_command",
            input: { command: "echo", args: ["hello"] },
          } as Anthropic.ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cmd",
            content: JSON.stringify({ stdout: "hello\n", stderr: "", exit_code: 0 }),
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ];

    const result = pruneMessages(messages, metadata, "always", 100_000, 0.7, 200_000);
    expect(result.prunedCount).toBe(1);
    const prunedContent = result.messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(prunedContent[0].content).toBe("[run_command: echo hello — exit 0, 6B stdout]");
  });
});

// ---------------------------------------------------------------------------
// compactConversation
// ---------------------------------------------------------------------------

function makeCompactionUsage(overrides?: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 500,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

function makeCompactionMessage(overrides?: {
  stop_reason?: Anthropic.Message["stop_reason"];
  content?: Anthropic.ContentBlock[];
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: "msg_compaction",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: overrides?.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    content: overrides?.content ?? [
      {
        type: "text",
        text: "## Accomplished\n- Did stuff\n\n## Remaining Work\n- More stuff",
        citations: null,
      } as Anthropic.TextBlock,
    ],
    usage: makeCompactionUsage(overrides?.usage),
  } as Anthropic.Message;
}

describe("compactConversation", () => {
  it("returns summary text and usage from a successful compaction call", async () => {
    const stubClient: MessageClient = {
      create: async () => makeCompactionMessage(),
    };

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Do the task" },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will do the task." } as Anthropic.TextBlock],
      },
    ];

    const result = await compactConversation(stubClient, "test-model", messages, "Do the task");

    expect(result.summary).toContain("## Accomplished");
    expect(result.summary).toContain("Did stuff");
    expect(result.usage.input_tokens).toBe(500);
    expect(result.usage.output_tokens).toBe(200);
  });

  it("uses the specified model for the compaction call", async () => {
    let capturedModel: string | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedModel = params.model;
        return makeCompactionMessage();
      },
    };

    await compactConversation(
      stubClient,
      "claude-haiku-3",
      [{ role: "user", content: "task" }],
      "task",
    );

    expect(capturedModel).toBe("claude-haiku-3");
  });

  it("throws when compaction API call fails", async () => {
    const stubClient: MessageClient = {
      create: async () => {
        throw new Error("API connection failed");
      },
    };

    await expect(
      compactConversation(stubClient, "test-model", [{ role: "user", content: "task" }], "task"),
    ).rejects.toThrow("API connection failed");
  });

  it("throws when compaction response is truncated (max_tokens)", async () => {
    const stubClient: MessageClient = {
      create: async () =>
        makeCompactionMessage({
          stop_reason: "max_tokens",
          content: [
            { type: "text", text: "Partial summary...", citations: null } as Anthropic.TextBlock,
          ],
        }),
    };

    await expect(
      compactConversation(stubClient, "test-model", [{ role: "user", content: "task" }], "task"),
    ).rejects.toThrow("truncated");
  });

  it("throws when compaction produces empty summary", async () => {
    const stubClient: MessageClient = {
      create: async () =>
        makeCompactionMessage({
          content: [{ type: "text", text: "   ", citations: null } as Anthropic.TextBlock],
        }),
    };

    await expect(
      compactConversation(stubClient, "test-model", [{ role: "user", content: "task" }], "task"),
    ).rejects.toThrow("empty summary");
  });

  it("sends conversation as JSON in the compaction request", async () => {
    let capturedMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedMessages = params.messages;
        return makeCompactionMessage();
      },
    };

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Build the feature" }];

    await compactConversation(stubClient, "test-model", messages, "Build the feature");

    expect(capturedMessages).toBeDefined();
    expect(capturedMessages?.length).toBe(1);
    const content = capturedMessages?.[0].content as string;
    expect(content).toContain("Build the feature");
    expect(content).toContain("agentic continuity");
  });

  it("sends no tools in the compaction request", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeCompactionMessage();
      },
    };

    await compactConversation(
      stubClient,
      "test-model",
      [{ role: "user", content: "task" }],
      "task",
    );

    // No tools property should be set
    expect(capturedParams?.tools).toBeUndefined();
  });

  it("uses custom max_tokens when provided", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeCompactionMessage();
      },
    };

    await compactConversation(
      stubClient,
      "test-model",
      [{ role: "user", content: "task" }],
      "task",
      4096,
    );

    expect(capturedParams?.max_tokens).toBe(4096);
  });

  it("uses default max_tokens of 8192 when not provided", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeCompactionMessage();
      },
    };

    await compactConversation(
      stubClient,
      "test-model",
      [{ role: "user", content: "task" }],
      "task",
    );

    expect(capturedParams?.max_tokens).toBe(8192);
  });
});
