import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../src/config.js";
import { runAgent, executeTool, type MessageClient } from "../src/agent.js";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    system_prompt: "test.md",
    token_budget: overrides?.token_budget ?? 100_000,
    log_denied_calls: overrides?.log_denied_calls ?? false,
    tools: {
      read: ["**"],
      write: ["**"],
      delete: ["**"],
      commands: [],
      ...(overrides?.tools ?? {}),
    },
    completion: {
      watch_file: null,
      no_progress_limit: 3,
      ...(overrides?.completion ?? {}),
    },
  };
}

function makeUsage(overrides?: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

function makeTextBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}

function makeMessage(overrides?: {
  stop_reason?: Anthropic.Message["stop_reason"];
  content?: Anthropic.ContentBlock[];
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: overrides?.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    content: overrides?.content ?? [makeTextBlock("Done.")],
    usage: makeUsage(overrides?.usage),
  } as Anthropic.Message;
}

function makeToolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id = "toolu_test_1",
): Anthropic.ToolUseBlock {
  return {
    type: "tool_use",
    id,
    name,
    input,
    caller: { type: "direct" },
  } as Anthropic.ToolUseBlock;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let tempDir: string;

const envVars = [
  "VESPER_SIGNAL_COMPLETE",
  "VESPER_SIGNAL_NEEDS_APPROVAL",
  "VESPER_SIGNAL_FAILED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vesper-agent-"));
  for (const key of envVars) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of envVars) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  // 1. end_turn on first call — no watch_file configured (null)
  //    With watch_file null, CompletionTracker always returns "continue",
  //    so after the first iteration the loop continues.  But MAX_ITERATIONS
  //    will eventually be hit and, since watch_file is null, the agent treats
  //    it as complete.
  //
  //    To exercise the immediate-complete path, configure watch_file pointing
  //    to a file that does not exist -> tracker returns "complete" on first check.
  it("returns exit 0 and writes complete signal when watch_file does not exist", async () => {
    const config = makeConfig({
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("All done.")],
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
    };

    // tasks.txt does NOT exist in tempDir -> tracker returns "complete"
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
  });

  // 2. Token budget exhaustion — single API call exceeds budget
  it("writes needs-approval signal and exits 0 when token budget is exhausted", async () => {
    const config = makeConfig({ token_budget: 200 });

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 150, output_tokens: 80 },
        }),
    };

    const result = await runAgent(config, "system", "task", tempDir, "budget-agent", stubClient);

    expect(result.exitCode).toBe(0);
    const signalPath = join(tempDir, ".vesper-needs-approval");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("token_budget_exceeded");
    expect(payload.agent).toBe("budget-agent");
    // The signal message should mention the budget and token counts
    expect(payload.message).toContain("200");
    expect(payload.message).toContain("150");
    expect(payload.message).toContain("80");
  });

  // 3. Token budget checked per API call — first call within budget,
  //    second call (tool result round-trip) exceeds it.
  it("writes needs-approval after the second API call when budget is exceeded mid-iteration", async () => {
    const config = makeConfig({ token_budget: 300 });

    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: model wants to use a tool. Usage within budget.
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("read_file", { path: "hello.txt" }, "toolu_1"),
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          });
        }
        // Second call: after tool result. Usage pushes over budget.
        return makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("Read the file.")],
          usage: { input_tokens: 120, output_tokens: 80 },
        });
      },
    };

    // Create the file the tool will read so executeTool succeeds
    writeFileSync(join(tempDir, "hello.txt"), "hello world");

    const result = await runAgent(config, "system", "task", tempDir, "mid-budget-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(2);
    expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(true);

    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-needs-approval"), "utf-8"));
    expect(payload.reason).toBe("token_budget_exceeded");
    // Cumulative: 100+120 input, 50+80 output = 350 > 300
    expect(payload.message).toContain("220");
    expect(payload.message).toContain("130");
  });

  // 4. API error — client.create throws
  it("writes failed signal with reason 'error' and exits 1 on API error", async () => {
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () => {
        throw new Error("Connection refused");
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "err-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("error");
    expect(payload.agent).toBe("err-agent");
    expect(payload.message).toContain("Connection refused");
  });

  // 5. Tool execution: read_file permitted
  it("executes read_file when path matches allow-list and returns file content", async () => {
    const config = makeConfig({
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    writeFileSync(join(tempDir, "data.txt"), "file-content-here");

    let capturedToolResult: string | undefined;
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_read"),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        // Second call: inspect the tool result from messages
        const msgs = params.messages;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          const toolResult = lastMsg.content[0];
          if (typeof toolResult === "object" && "content" in toolResult) {
            capturedToolResult = toolResult.content as string;
          }
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    // tasks.txt missing -> immediate complete
    const result = await runAgent(config, "system", "task", tempDir, "read-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(2);
    // The tool result should contain the file content
    expect(capturedToolResult).toBeDefined();
    const parsed = JSON.parse(capturedToolResult as string);
    expect(parsed.content).toBe("file-content-here");
  });

  // 6. Tool execution: permission denied for write outside allow-list
  it("returns permission_denied when write_file path is outside allow-list", async () => {
    const config = makeConfig({
      tools: { read: ["**"], write: ["src/**"], delete: ["**"], commands: [] },
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    let capturedToolResult: string | undefined;
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("write_file", { path: "secrets.env", content: "bad" }, "toolu_write"),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        const msgs = params.messages;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          const toolResult = lastMsg.content[0];
          if (typeof toolResult === "object" && "content" in toolResult) {
            capturedToolResult = toolResult.content as string;
          }
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "perm-agent", stubClient);

    expect(capturedToolResult).toBeDefined();
    const parsed = JSON.parse(capturedToolResult as string);
    expect(parsed.error).toBe("permission_denied");
    // File should NOT have been written
    expect(existsSync(join(tempDir, "secrets.env"))).toBe(false);
  });

  // 7. Unknown tool name
  it("returns permission_denied for an unknown tool name", async () => {
    const config = makeConfig({
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    let capturedToolResult: string | undefined;
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("hack_system", { target: "root" }, "toolu_hack"),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        const msgs = params.messages;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          const toolResult = lastMsg.content[0];
          if (typeof toolResult === "object" && "content" in toolResult) {
            capturedToolResult = toolResult.content as string;
          }
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "hack-agent", stubClient);

    expect(capturedToolResult).toBeDefined();
    const parsed = JSON.parse(capturedToolResult as string);
    expect(parsed.error).toBe("permission_denied");
  });

  // 8. No-progress detection
  it("writes failed signal with 'no_progress' after no_progress_limit iterations without change", async () => {
    // watch_file exists with unchanging content -> tracker increments no-progress counter
    const config = makeConfig({
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    writeFileSync(join(tempDir, "tasks.txt"), "- task 1\n- task 2\n");

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
    };

    const result = await runAgent(config, "system", "task", tempDir, "stuck-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("no_progress");
    expect(payload.agent).toBe("stuck-agent");
    expect(payload.message).toContain("3");
  });

  // 9. Completion: watch file empty
  it("writes complete signal and exits 0 when watch file is empty after first iteration", async () => {
    const config = makeConfig({
      completion: { watch_file: "tasks.txt", no_progress_limit: 3 },
    });

    // Create an empty watch file
    writeFileSync(join(tempDir, "tasks.txt"), "");

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
    };

    const result = await runAgent(config, "system", "task", tempDir, "done-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
    // Should not have written a failed signal
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeTool direct tests
// ---------------------------------------------------------------------------

describe("executeTool", () => {
  // 5 (direct call variant). read_file permitted
  it("reads a file successfully when path matches allow-list", async () => {
    const config = makeConfig();
    writeFileSync(join(tempDir, "readable.txt"), "the-content");

    const result = await executeTool("read_file", { path: "readable.txt" }, tempDir, config);
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe("the-content");
  });

  // 6 (direct). write_file outside allow-list
  it("returns permission_denied when write_file path does not match allow-list", async () => {
    const config = makeConfig({
      tools: { read: ["**"], write: ["src/**"], delete: ["**"], commands: [] },
    });

    const result = await executeTool(
      "write_file",
      { path: "outside.txt", content: "data" },
      tempDir,
      config,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("permission_denied");
  });

  // 7 (direct). Unknown tool
  it("returns permission_denied for an unrecognized tool name", async () => {
    const config = makeConfig();
    const result = await executeTool("hack_system", { target: "root" }, tempDir, config);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("permission_denied");
  });

  // 10. Malformed input — path is not a string
  it("returns permission_denied when input has wrong types", async () => {
    const config = makeConfig();
    const result = await executeTool("read_file", { path: 42 }, tempDir, config);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("permission_denied");
  });

  it("returns permission_denied when input is null", async () => {
    const config = makeConfig();
    const result = await executeTool("read_file", null, tempDir, config);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("permission_denied");
  });

  it("returns permission_denied when input is a non-object primitive", async () => {
    const config = makeConfig();
    const result = await executeTool("read_file", "not-an-object", tempDir, config);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("permission_denied");
  });
});
