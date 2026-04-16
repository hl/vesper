import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { BadRequestError } from "@anthropic-ai/sdk";
import {
  executeTool,
  extractLastText,
  isContextLengthError,
  type MessageClient,
  runAgent,
} from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    system_prompt: "test.md",
    token_budget: overrides?.token_budget ?? 100_000,
    log_denied_calls: overrides?.log_denied_calls ?? false,
    model: overrides?.model,
    reveal_permissions: overrides?.reveal_permissions ?? false,
    log_events: overrides?.log_events ?? false,
    command_timeout: overrides?.command_timeout ?? 30,
    command_env: overrides?.command_env ?? [],
    max_tool_result_size: overrides?.max_tool_result_size ?? 102400,
    scratchpad: overrides?.scratchpad ?? null,
    skills: overrides?.skills ?? null,
    default_signal: overrides?.default_signal ?? "complete",
    context_files: overrides?.context_files ?? [],
    signals: overrides?.signals ?? {
      complete: ".vesper-complete",
      needs_approval: ".vesper-needs-approval",
      failed: ".vesper-failed",
    },
    context_management: overrides?.context_management ?? {
      pruning: "off",
      pruning_threshold: 0.7,
      compaction_enabled: false,
      compaction_threshold: 0.8,
      compaction_model: null,
    },
    tools: {
      read: ["**"],
      write: ["**"],
      delete: ["**"],
      commands: [],
      ...(overrides?.tools ?? {}),
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "vesper-agent-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractLastText", () => {
  it("returns last text block content", () => {
    const msg = makeMessage({
      content: [makeTextBlock("First block"), makeTextBlock("Last block")],
    });
    expect(extractLastText(msg)).toBe("Last block");
  });

  it("returns null when no text blocks", () => {
    const msg = makeMessage({ content: [] });
    expect(extractLastText(msg)).toBeNull();
  });

  it("skips empty text blocks", () => {
    const msg = makeMessage({
      content: [makeTextBlock("Meaningful text"), makeTextBlock("   ")],
    });
    expect(extractLastText(msg)).toBe("Meaningful text");
  });

  it("truncates to 1000 characters", () => {
    const longText = "x".repeat(2000);
    const msg = makeMessage({ content: [makeTextBlock(longText)] });
    const result = extractLastText(msg);
    expect(result?.length).toBe(1000);
  });
});

describe("runAgent", () => {
  // 1. end_turn on first call — writes complete signal and exits
  it("returns exit 0 and writes complete signal on end_turn", async () => {
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("All done.")],
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
    };

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
            content: [makeToolUseBlock("read_file", { path: "hello.txt" }, "toolu_1")],
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

    const result = await runAgent(
      config,
      "system",
      "task",
      tempDir,
      "mid-budget-agent",
      stubClient,
    );

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
    const config = makeConfig({});

    writeFileSync(join(tempDir, "data.txt"), "file-content-here");

    let capturedToolResult: string | undefined;
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_read")],
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
              makeToolUseBlock(
                "write_file",
                { path: "secrets.env", content: "bad" },
                "toolu_write",
              ),
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
    const config = makeConfig({});

    let capturedToolResult: string | undefined;
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("hack_system", { target: "root" }, "toolu_hack")],
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

  // R1: Configurable model
  it("passes config.model to the API client when set", async () => {
    const config = makeConfig({
      model: "claude-opus-4-20250514",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "model-agent", stubClient);

    expect(capturedParams).toBeDefined();
    expect(capturedParams?.model).toBe("claude-opus-4-20250514");
  });

  // R2: Prompt caching — system is an array with cache_control
  it("sends system prompt as an array with cache_control for prompt caching", async () => {
    const config = makeConfig({});

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system prompt text", "task", tempDir, "cache-agent", stubClient);

    expect(capturedParams).toBeDefined();
    expect(Array.isArray(capturedParams?.system)).toBe(true);
    const systemBlocks = capturedParams?.system as Array<{
      type: string;
      text?: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks.length).toBeGreaterThan(0);
    expect(systemBlocks[0].type).toBe("text");
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // R3: Tool filtering — only read tools when write/delete/commands are empty
  it("sends only read tools when write, delete, and commands are empty arrays", async () => {
    const config = makeConfig({
      tools: { read: ["**"], write: [], delete: [], commands: [] },
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "filter-agent", stubClient);

    expect(capturedParams).toBeDefined();
    const toolNames = capturedParams?.tools?.map((t) => (t as Anthropic.Tool).name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("list_files");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("patch_file");
    expect(toolNames).not.toContain("delete_file");
    expect(toolNames).not.toContain("run_command");
  });

  // R4: Permission transparency — reveal_permissions: true
  it("includes tool, target, and allowed_patterns in denial when reveal_permissions is true", async () => {
    const config = makeConfig({
      reveal_permissions: true,
      tools: { read: ["**"], write: ["src/**"], delete: ["**"], commands: [] },
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
              makeToolUseBlock("write_file", { path: "secrets.env", content: "bad" }, "toolu_w1"),
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

    await runAgent(config, "system", "task", tempDir, "reveal-agent", stubClient);

    expect(capturedToolResult).toBeDefined();
    const parsed = JSON.parse(capturedToolResult as string);
    expect(parsed.error).toBe("permission_denied");
    expect(parsed.tool).toBe("write_file");
    expect(parsed.target).toBe("secrets.env");
    expect(parsed.allowed_patterns).toEqual(["src/**"]);
  });

  // R5: Permission transparency off — reveal_permissions: false (default)
  it("returns plain permission_denied with no extra fields when reveal_permissions is false", async () => {
    const config = makeConfig({
      reveal_permissions: false,
      tools: { read: ["**"], write: ["src/**"], delete: ["**"], commands: [] },
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
              makeToolUseBlock("write_file", { path: "secrets.env", content: "bad" }, "toolu_w2"),
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

    await runAgent(config, "system", "task", tempDir, "opaque-agent", stubClient);

    expect(capturedToolResult).toBeDefined();
    const parsed = JSON.parse(capturedToolResult as string);
    expect(parsed).toEqual({ error: "permission_denied" });
    expect(parsed.tool).toBeUndefined();
    expect(parsed.target).toBeUndefined();
    expect(parsed.allowed_patterns).toBeUndefined();
  });

  // R9: Scratchpad injection — file exists
  it("injects scratchpad contents before the task prompt when scratchpad file exists", async () => {
    const config = makeConfig({
      scratchpad: "scratch.md",
    });

    writeFileSync(join(tempDir, "scratch.md"), "Some previous context here.");

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "scratch-agent", stubClient);

    expect(capturedParams).toBeDefined();
    const firstMsg = capturedParams?.messages[0] as Anthropic.MessageParam;
    expect(firstMsg.role).toBe("user");
    const content = firstMsg.content as string;
    expect(content.startsWith("[Previous Context]")).toBe(true);
    expect(content).toContain("Some previous context here.");
    expect(content).toContain("do the task");
  });

  // R9: Scratchpad injection — file missing
  it("sends plain task prompt when scratchpad file does not exist", async () => {
    const config = makeConfig({
      scratchpad: "nonexistent-scratch.md",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "no-scratch-agent", stubClient);

    expect(capturedParams).toBeDefined();
    const firstMsg = capturedParams?.messages[0] as Anthropic.MessageParam;
    expect(firstMsg.role).toBe("user");
    const content = firstMsg.content as string;
    expect(content).toBe("do the task");
  });

  // R12: max_tokens truncation
  it("writes failed signal with truncated message when stop_reason is max_tokens", async () => {
    const config = makeConfig({});

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "max_tokens",
          content: [makeTextBlock("Partial output that got cut off")],
          usage: { input_tokens: 50, output_tokens: 4096 },
        }),
    };

    const result = await runAgent(config, "system", "task", tempDir, "trunc-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("error");
    expect(payload.agent).toBe("trunc-agent");
    expect(payload.message.toLowerCase()).toContain("truncated");
  });

  // Tool execution error — executeTool throws, model receives error result
  it("returns error tool_result to model when executeTool throws instead of aborting", async () => {
    // Create a regular file that blocks mkdir -p when write_file tries to
    // create intermediate directories through it. This causes writeFile to
    // throw ENOTDIR, exercising the catch path in the tool loop.
    writeFileSync(join(tempDir, "blocker"), "I am a file, not a directory");

    const config = makeConfig();

    let callCount = 0;
    let toolResultContent: string | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              // write_file through a regular file triggers ENOTDIR in mkdir
              makeToolUseBlock(
                "write_file",
                { path: "blocker/sub/file.txt", content: "data" },
                "toolu_err",
              ),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        // Second call: model sees the tool result and finishes
        const lastMsg = params.messages[params.messages.length - 1];
        if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
          const toolResult = lastMsg.content[0] as Anthropic.ToolResultBlockParam;
          toolResultContent = toolResult.content as string;
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "err-agent", stubClient);

    // The conversation should complete normally — not crash
    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(2);
    // The tool result should contain the internal_error from the catch path
    expect(toolResultContent).toBeDefined();
    const parsed = JSON.parse(toolResultContent as string);
    expect(parsed.error).toBe("internal_error");
    expect(parsed.message).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skill injection tests
// ---------------------------------------------------------------------------

describe("skill injection", () => {
  it("injects skills from .md files before task prompt", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "patterns.md"), "Use pattern X for Y.");
    writeFileSync(join(skillsDir, "conventions.md"), "Always use strict mode.");

    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "skill-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toContain("[Skills]");
    expect(content).toContain("## conventions.md");
    expect(content).toContain("## patterns.md");
    expect(content).toContain("Always use strict mode.");
    expect(content).toContain("Use pattern X for Y.");
    expect(content).toContain("[Task]\ndo the task");
  });

  it("sorts skill files lexicographically", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "b-second.md"), "Second skill.");
    writeFileSync(join(skillsDir, "a-first.md"), "First skill.");

    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "sort-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    const firstIdx = content.indexOf("## a-first.md");
    const secondIdx = content.indexOf("## b-second.md");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("silently skips when skills directory does not exist", async () => {
    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "no-skills-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toBe("do the task");
  });

  it("silently skips when skills directory is empty (no .md files)", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "readme.txt"), "Not a markdown file.");

    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "empty-skills-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toBe("do the task");
  });

  it("silently skips when skills path is a regular file", async () => {
    writeFileSync(join(tempDir, "skills-file"), "not a directory");

    const config = makeConfig({
      skills: "skills-file",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do the task", tempDir, "file-skills-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toBe("do the task");
  });

  it("skips whitespace-only skill files", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "empty.md"), "   \n  \n  ");
    writeFileSync(join(skillsDir, "real.md"), "Real content.");

    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "empty-file-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toContain("## real.md");
    expect(content).not.toContain("## empty.md");
  });

  it("composes skills + scratchpad + task correctly when both present", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "tip.md"), "Always test first.");
    writeFileSync(join(tempDir, "scratch.md"), "Previous context here.");

    const config = makeConfig({
      skills: ".vesper/skills",
      scratchpad: "scratch.md",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "do work", tempDir, "both-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    // Verify ordering: [Skills] before [Previous Context] before [Task]
    const skillsIdx = content.indexOf("[Skills]");
    const prevIdx = content.indexOf("[Previous Context]");
    const taskIdx = content.indexOf("[Task]");
    expect(skillsIdx).toBeLessThan(prevIdx);
    expect(prevIdx).toBeLessThan(taskIdx);
    expect(content).toContain("Always test first.");
    expect(content).toContain("Previous context here.");
    expect(content).toContain("do work");
  });

  it("only includes non-.md files are ignored from skills directory", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "valid.md"), "Valid skill.");
    writeFileSync(join(skillsDir, "ignored.txt"), "Should be ignored.");
    writeFileSync(join(skillsDir, "also-ignored.yaml"), "also: ignored");

    const config = makeConfig({
      skills: ".vesper/skills",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "filter-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toContain("## valid.md");
    expect(content).not.toContain("ignored.txt");
    expect(content).not.toContain("also-ignored.yaml");
  });

  it("skips skill files that are symlinks pointing outside the skills directory", async () => {
    const skillsDir = join(tempDir, ".vesper", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "legit.md"), "Legitimate skill.");

    // Create an outside file and symlink it into the skills directory
    const outsideDir = mkdtempSync(join(tmpdir(), "vesper-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.txt"), "Secret content.");
      symlinkSync(join(outsideDir, "secret.txt"), join(skillsDir, "evil.md"));

      const config = makeConfig({
        skills: ".vesper/skills",
      });

      let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
      const stubClient: MessageClient = {
        create: async (params) => {
          capturedParams = params;
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        },
      };

      await runAgent(config, "system", "task", tempDir, "symlink-skills-agent", stubClient);

      const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
      expect(content).toContain("## legit.md");
      expect(content).toContain("Legitimate skill.");
      expect(content).not.toContain("Secret content.");
      expect(content).not.toContain("## evil.md");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("scratchpad still works after isInsideCwd refactor", async () => {
    writeFileSync(join(tempDir, "scratch.md"), "Scratchpad content.");

    const config = makeConfig({
      scratchpad: "scratch.md",
    });

    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        capturedParams = params;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      },
    };

    await runAgent(config, "system", "the task", tempDir, "compat-agent", stubClient);

    const content = (capturedParams?.messages[0] as Anthropic.MessageParam).content as string;
    expect(content).toContain("[Previous Context]");
    expect(content).toContain("Scratchpad content.");
    expect(content).toContain("[Task]\nthe task");
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

// ---------------------------------------------------------------------------
// Signal tool
// ---------------------------------------------------------------------------

describe("signal tool", () => {
  it("writes complete signal when agent calls signal(complete)", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
  });

  it("writes needs_approval with agent reason when agent calls signal(needs_approval)", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("signal", {
                type: "needs_approval",
                message: "Task X needs review",
              }),
            ],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    const signalPath = join(tempDir, ".vesper-needs-approval");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("agent_needs_approval");
    expect(payload.context).toBe("Task X needs review");
  });

  it("writes failed with agent reason when agent calls signal(failed)", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("signal", {
                type: "failed",
                message: "Dependency missing",
              }),
            ],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("agent_failed");
    expect(payload.context).toBe("Dependency missing");
  });

  it("writes complete by default when default_signal is complete and no signal called", async () => {
    const config = makeConfig({ default_signal: "complete" });
    const stubClient: MessageClient = {
      create: async () => makeMessage({ stop_reason: "end_turn" }),
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
  });

  it("writes no signal file when default_signal is none and no signal called", async () => {
    const config = makeConfig({ default_signal: "none" });
    const stubClient: MessageClient = {
      create: async () => makeMessage({ stop_reason: "end_turn" }),
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(false);
  });

  it("conversation continues after signal tool call", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "prompt.md" }, "toolu_read_1")],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(callCount).toBe(3);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
  });

  it("last signal call wins when signal is called multiple times", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock(
                "signal",
                {
                  type: "needs_approval",
                  message: "Changed mind",
                },
                "toolu_signal_2",
              ),
            ],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(true);
    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-needs-approval"), "utf-8"));
    expect(payload.reason).toBe("agent_needs_approval");
  });

  it("vesper API error overrides recorded signal (R12)", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        // Second API call fails
        throw new Error("API connection lost");
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(true);
    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-failed"), "utf-8"));
    expect(payload.reason).toBe("error");
  });

  it("vesper budget exhaustion overrides recorded signal (R12)", async () => {
    const config = makeConfig({ token_budget: 200 });
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
            usage: { input_tokens: 100, output_tokens: 50 },
          });
        }
        // Second call exceeds budget
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(true);
    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-needs-approval"), "utf-8"));
    expect(payload.reason).toBe("token_budget_exceeded");
  });

  it("explicit signal overrides default_signal: none", async () => {
    const config = makeConfig({ default_signal: "none" });
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
  });

  it("signal tool works for agent with zero permission-gated tools", async () => {
    const config = makeConfig({
      tools: { read: [], write: [], delete: [], commands: [] },
      default_signal: "none",
    });
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("signal", {
                type: "failed",
                message: "Cannot proceed",
              }),
            ],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("agent_failed");
    expect(payload.context).toBe("Cannot proceed");
  });

  it("signal tool works alongside other tools in same API response batch", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("signal", { type: "complete" }),
              makeToolUseBlock("read_file", { path: "prompt.md" }, "toolu_read_1"),
            ],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test content");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
    expect(callCount).toBe(2);
  });

  it("max_tokens overrides previously recorded signal", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete" })],
          });
        }
        return makeMessage({ stop_reason: "max_tokens" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    const result = await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(true);
    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-failed"), "utf-8"));
    expect(payload.reason).toBe("error");
  });

  it("signal(failed) without message uses default fallback text and null context", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "failed" })],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);
    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("agent_failed");
    expect(payload.message).toBe("Agent signaled failure");
    expect(payload.context).toBeNull();
  });

  it("signal(complete) with message silently ignores the message", async () => {
    const config = makeConfig();
    let callCount = 0;
    const stubClient: MessageClient = {
      create: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("signal", { type: "complete", message: "all done" })],
          });
        }
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    writeFileSync(join(tempDir, "prompt.md"), "test");
    await runAgent(config, "system", "task", tempDir, "test-agent", stubClient);

    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
    expect(readFileSync(join(tempDir, ".vesper-complete"), "utf-8")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Context-length error detection (R13)
// ---------------------------------------------------------------------------

describe("isContextLengthError", () => {
  it("returns true for BadRequestError with context overflow message", () => {
    const err = new BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      "prompt is too long",
      new Headers(),
      "invalid_request_error",
    );
    expect(isContextLengthError(err)).toBe(true);
  });

  it("returns false for BadRequestError with unrelated message", () => {
    const err = new BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "invalid model" } },
      "invalid model",
      new Headers(),
      "invalid_request_error",
    );
    expect(isContextLengthError(err)).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isContextLengthError(new Error("Connection refused"))).toBe(false);
  });

  it("returns false for BadRequestError with non-invalid_request_error type", () => {
    const err = new BadRequestError(
      400,
      { type: "error", error: { type: "api_error", message: "prompt is too long" } },
      "prompt is too long",
      new Headers(),
      "api_error",
    );
    expect(isContextLengthError(err)).toBe(false);
  });

  it("matches 'maximum context length' pattern", () => {
    const err = new BadRequestError(
      400,
      {
        type: "error",
        error: { type: "invalid_request_error", message: "maximum context length exceeded" },
      },
      "maximum context length exceeded",
      new Headers(),
      "invalid_request_error",
    );
    expect(isContextLengthError(err)).toBe(true);
  });

  it("matches 'too many tokens' pattern", () => {
    const err = new BadRequestError(
      400,
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Request has too many tokens" },
      },
      "Request has too many tokens",
      new Headers(),
      "invalid_request_error",
    );
    expect(isContextLengthError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool result pruning integration tests
// ---------------------------------------------------------------------------

describe("tool result pruning", () => {
  it("prunes prior turn read_file results when pruning is always", async () => {
    const config = makeConfig({
      context_management: {
        pruning: "always",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    writeFileSync(join(tempDir, "data.txt"), "line1\nline2\nline3\n");

    let callCount = 0;
    let thirdCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          // First call: model reads a file
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_r1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          // Second call: model reads again
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_r2")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        // Third call: capture the messages to verify pruning
        thirdCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "prune-agent", stubClient);
    expect(result.exitCode).toBe(0);
    expect(callCount).toBe(3);

    // Verify messages sent to API on the third call:
    // messages[0]: user task (unchanged)
    // messages[1]: assistant tool_use
    // messages[2]: user tool_result (first turn — should be pruned)
    // messages[3]: assistant tool_use
    // messages[4]: user tool_result (second turn — most recent, not pruned)
    expect(thirdCallMessages).toBeDefined();
    const msgs = thirdCallMessages as Anthropic.MessageParam[];

    // messages[0] unchanged
    expect(msgs[0].content).toBe("task");

    // messages[2] should be pruned (first turn's tool result)
    const firstToolResult = msgs[2].content as Anthropic.ToolResultBlockParam[];
    expect(firstToolResult[0].tool_use_id).toBe("toolu_r1");
    const stubContent = firstToolResult[0].content as string;
    expect(stubContent).toContain("[read_file:");
    expect(stubContent).toContain("data.txt");
    // Stub should NOT contain the original file content
    expect(stubContent).not.toContain("line1");

    // messages[4] should NOT be pruned (most recent turn)
    const lastToolResult = msgs[4].content as Anthropic.ToolResultBlockParam[];
    expect(lastToolResult[0].tool_use_id).toBe("toolu_r2");
    const lastContent = lastToolResult[0].content as string;
    // Should still contain the full JSON result
    expect(lastContent).toContain("line1");
  });

  it("does not prune messages when pruning is off", async () => {
    const config = makeConfig({
      context_management: {
        pruning: "off",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    writeFileSync(join(tempDir, "data.txt"), "original-content");

    let callCount = 0;
    let secondCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "data.txt" }, "toolu_2")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        secondCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "nopruneagent", stubClient);
    expect(callCount).toBe(3);

    // Verify first turn's tool result is NOT pruned
    const msgs = secondCallMessages as Anthropic.MessageParam[];
    const firstToolResult = msgs[2].content as Anthropic.ToolResultBlockParam[];
    const content = firstToolResult[0].content as string;
    expect(content).toContain("original-content");
  });

  it("prunes write_file results with correct stub format", async () => {
    const config = makeConfig({
      context_management: {
        pruning: "always",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    let callCount = 0;
    let thirdCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("write_file", { path: "out.txt", content: "data" }, "toolu_w1"),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "out.txt" }, "toolu_r1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        thirdCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "write-prune-agent", stubClient);
    expect(callCount).toBe(3);

    const msgs = thirdCallMessages as Anthropic.MessageParam[];
    const firstToolResult = msgs[2].content as Anthropic.ToolResultBlockParam[];
    expect(firstToolResult[0].content).toBe("[write_file: out.txt — ok]");
  });

  it("prunes run_command results with correct stub format", async () => {
    const config = makeConfig({
      tools: { read: ["**"], write: ["**"], delete: ["**"], commands: ["echo"] },
      context_management: {
        pruning: "always",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    let callCount = 0;
    let thirdCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [
              makeToolUseBlock("run_command", { command: "echo", args: ["hello"] }, "toolu_c1"),
            ],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "out.txt" }, "toolu_r1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        thirdCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    writeFileSync(join(tempDir, "out.txt"), "dummy");

    await runAgent(config, "system", "task", tempDir, "cmd-prune-agent", stubClient);
    expect(callCount).toBe(3);

    const msgs = thirdCallMessages as Anthropic.MessageParam[];
    const firstToolResult = msgs[2].content as Anthropic.ToolResultBlockParam[];
    const stub = firstToolResult[0].content as string;
    expect(stub).toContain("[run_command:");
    expect(stub).toContain("echo hello");
    expect(stub).toContain("exit 0");
    expect(stub).toContain("stdout");
  });

  it("preserves tool_use_id linkage across pruned messages", async () => {
    const config = makeConfig({
      context_management: {
        pruning: "always",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    writeFileSync(join(tempDir, "a.txt"), "content-a");

    let callCount = 0;
    let thirdCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "a.txt" }, "toolu_link_1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "a.txt" }, "toolu_link_2")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        thirdCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "linkage-agent", stubClient);

    const msgs = thirdCallMessages as Anthropic.MessageParam[];

    // Check that the assistant tool_use id matches the following user tool_result id
    // for the pruned first turn
    const assistantContent = msgs[1].content as Anthropic.ContentBlock[];
    const toolUse = assistantContent.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock;
    const toolResult = (msgs[2].content as Anthropic.ToolResultBlockParam[])[0];
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolResult.tool_use_id).toBe("toolu_link_1");
  });

  it("threshold mode does not prune when below threshold", async () => {
    const config = makeConfig({
      context_management: {
        pruning: "threshold",
        pruning_threshold: 0.7,
        compaction_enabled: false,
        compaction_threshold: 0.8,
        compaction_model: null,
      },
    });

    writeFileSync(join(tempDir, "tiny.txt"), "x");

    let callCount = 0;
    let thirdCallMessages: Anthropic.MessageParam[] | undefined;
    const stubClient: MessageClient = {
      create: async (params) => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "tiny.txt" }, "toolu_t1")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        if (callCount === 2) {
          return makeMessage({
            stop_reason: "tool_use",
            content: [makeToolUseBlock("read_file", { path: "tiny.txt" }, "toolu_t2")],
            usage: { input_tokens: 50, output_tokens: 30 },
          });
        }
        thirdCallMessages = params.messages;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      },
    };

    await runAgent(config, "system", "task", tempDir, "thresh-agent", stubClient);
    expect(callCount).toBe(3);

    // With tiny messages the estimated tokens should be well below 70% of 200k
    // so no pruning should occur
    const msgs = thirdCallMessages as Anthropic.MessageParam[];
    const firstToolResult = msgs[2].content as Anthropic.ToolResultBlockParam[];
    const content = firstToolResult[0].content as string;
    // Should NOT be a stub — should still contain original content
    expect(content).toContain("x");
    expect(content).not.toContain("[read_file:");
  });
});

// ---------------------------------------------------------------------------
// Pre-call context guard (Unit 5)
// ---------------------------------------------------------------------------

describe("pre-call context guard", () => {
  it("proceeds normally when estimated context is at 50% of model window", async () => {
    // Default model window is 200k. With a small system prompt and task,
    // estimated context will be well below 95% (190k tokens).
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("Done.")],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    };

    const result = await runAgent(config, "system", "task", tempDir, "guard-ok-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(false);
  });

  it("writes failed signal when estimated context exceeds 95% of model window", async () => {
    // Generate a massive user message that will push context over 95% of 200k.
    // 200k * 0.95 = 190k tokens. At chars/3 heuristic, we need ~570k chars.
    const hugeTask = "x".repeat(600_000);
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    };

    const result = await runAgent(
      config,
      "system",
      hugeTask,
      tempDir,
      "guard-fail-agent",
      stubClient,
    );

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("error");
    expect(payload.agent).toBe("guard-fail-agent");
    expect(payload.message).toContain("Estimated context size");
    expect(payload.message).toContain("exceeds 95% of model window");
    expect(payload.message).toContain("200000");
  });

  it("proceeds when estimated context is at 94.9% (just under threshold)", async () => {
    // 200k * 0.95 = 190k tokens. We need estimated tokens just under 190k.
    // At chars/3, 190k tokens = ~570k chars. We need slightly less.
    // estimatePayloadTokens includes system, tools, and messages.
    // We'll construct a task that brings us just under the threshold.
    // With JSON serialization overhead, the exact numbers shift. Let's compute
    // what we need: we need the total of system+tools+messages < 190k tokens.
    // System and tools are small (~few hundred tokens). We need the message to be ~189k tokens.
    // At chars/3 = 189k, we need ~567k chars of message. But JSON.stringify adds
    // quotes and escaping overhead, so we go slightly under.
    // Use 560k chars — should be close to 94% and under 95%.
    const task = "y".repeat(560_000);
    const config = makeConfig();

    let apiCalled = false;
    const stubClient: MessageClient = {
      create: async () => {
        apiCalled = true;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      },
    };

    const result = await runAgent(config, "system", task, tempDir, "guard-under-agent", stubClient);

    expect(result.exitCode).toBe(0);
    expect(apiCalled).toBe(true);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(false);
  });

  it("fires context guard on the very first API call", async () => {
    // If the system prompt + initial task is already over 95%, the guard
    // should fire before the first API call ever happens.
    const hugeSystem = "s".repeat(600_000);
    const config = makeConfig();

    let apiCalled = false;
    const stubClient: MessageClient = {
      create: async () => {
        apiCalled = true;
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    const result = await runAgent(
      config,
      hugeSystem,
      "task",
      tempDir,
      "guard-first-agent",
      stubClient,
    );

    expect(result.exitCode).toBe(1);
    expect(apiCalled).toBe(false);
    expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(true);

    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-failed"), "utf-8"));
    expect(payload.message).toContain("Estimated context size");
    expect(payload.message).toContain("exceeds 95% of model window");
  });

  it("emits context_guard_triggered logger event when guard fires", async () => {
    const hugeTask = "x".repeat(600_000);
    const config = makeConfig({ log_events: true });

    const stubClient: MessageClient = {
      create: async () => makeMessage({ stop_reason: "end_turn" }),
    };

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    try {
      await runAgent(config, "system", hugeTask, tempDir, "guard-log-agent", stubClient);
    } finally {
      process.stderr.write = original;
    }

    const lines = captured.trim().split("\n");
    const guardEvent = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "context_guard_triggered");

    expect(guardEvent).toBeDefined();
    expect(guardEvent.estimated_tokens).toBeGreaterThan(190_000);
    expect(guardEvent.model_window).toBe(200_000);
  });

  it("emits context_estimation_drift when estimate diverges >30% from actual", async () => {
    // The chars/3 heuristic will likely diverge from the actual token count
    // reported by the API. We can control this by setting a low actual count
    // that's far from what the estimator computes.
    const config = makeConfig({ log_events: true });

    // With a small system prompt and task, the estimated tokens will be low.
    // If the API reports a much higher actual, the ratio will diverge.
    // We'll set input_tokens very high relative to a small payload.
    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("Done.")],
          // The estimated tokens for "system" + tools + "task" is small (~few hundred).
          // Setting actual input_tokens to 10000 will make ratio < 0.7 (estimated/actual < 0.7).
          usage: { input_tokens: 10000, output_tokens: 50 },
        }),
    };

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    try {
      await runAgent(config, "system", "task", tempDir, "drift-agent", stubClient);
    } finally {
      process.stderr.write = original;
    }

    const lines = captured.trim().split("\n");
    const driftEvent = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "context_estimation_drift");

    expect(driftEvent).toBeDefined();
    expect(driftEvent.estimated).toBeGreaterThan(0);
    expect(driftEvent.actual).toBe(10000);
    expect(driftEvent.ratio).toBeLessThan(0.7);
  });

  it("does not emit drift when estimate is within 30% of actual", async () => {
    // Use a large task to dominate the estimate, making the tool definitions
    // overhead negligible. Then set actual input_tokens to a value within 30%
    // of the expected estimate.
    // With a 30k char task, estimate is ~10k tokens (30000/3 = 10000).
    // System + tools overhead adds ~700 tokens. Total ~10700.
    // Setting actual input_tokens to 10700 gives ratio ~1.0 (within bounds).
    const largeTask = "a".repeat(30_000);
    const config = makeConfig({ log_events: true });

    const stubClient: MessageClient = {
      create: async () =>
        makeMessage({
          stop_reason: "end_turn",
          content: [makeTextBlock("Done.")],
          usage: { input_tokens: 10700, output_tokens: 50 },
        }),
    };

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    try {
      await runAgent(config, "system", largeTask, tempDir, "no-drift-agent", stubClient);
    } finally {
      process.stderr.write = original;
    }

    const lines = captured
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    const driftEvent = lines
      .map((l) => JSON.parse(l))
      .find((e: { event: string }) => e.event === "context_estimation_drift");

    expect(driftEvent).toBeUndefined();
  });
});

describe("context-length error in runAgent", () => {
  it("writes failed signal with 'Context window overflow' for context-length BadRequestError", async () => {
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () => {
        throw new BadRequestError(
          400,
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "prompt is too long: 250000 tokens > 200000 maximum",
            },
          },
          "prompt is too long: 250000 tokens > 200000 maximum",
          new Headers(),
          "invalid_request_error",
        );
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "overflow-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("error");
    expect(payload.agent).toBe("overflow-agent");
    expect(payload.message).toContain("Context window overflow");
    expect(payload.message).toContain("prompt is too long");
  });

  it("writes generic 'API error' for non-context BadRequestError", async () => {
    const config = makeConfig();

    const stubClient: MessageClient = {
      create: async () => {
        throw new BadRequestError(
          400,
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "invalid model: nonexistent-model",
            },
          },
          "invalid model: nonexistent-model",
          new Headers(),
          "invalid_request_error",
        );
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "bad-model-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const signalPath = join(tempDir, ".vesper-failed");
    expect(existsSync(signalPath)).toBe(true);

    const payload = JSON.parse(readFileSync(signalPath, "utf-8"));
    expect(payload.reason).toBe("error");
    expect(payload.message).toContain("API error");
    expect(payload.message).not.toContain("Context window overflow");
  });

  it("writes generic 'API error' for plain Error (unchanged behavior)", async () => {
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
    expect(payload.message).toContain("API error");
    expect(payload.message).toContain("Connection refused");
    expect(payload.message).not.toContain("Context window overflow");
  });

  it("signal file JSON includes the specific error message for context overflow", async () => {
    const config = makeConfig();
    const specificMessage = "Your prompt has exceeded the maximum context length of 200000 tokens";

    const stubClient: MessageClient = {
      create: async () => {
        throw new BadRequestError(
          400,
          {
            type: "error",
            error: { type: "invalid_request_error", message: specificMessage },
          },
          specificMessage,
          new Headers(),
          "invalid_request_error",
        );
      },
    };

    const result = await runAgent(config, "system", "task", tempDir, "detail-agent", stubClient);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(readFileSync(join(tempDir, ".vesper-failed"), "utf-8"));
    // The message format is "Context window overflow: <SDK message>"
    // The SDK prefixes the status code, so the full message will contain "400 <message>"
    expect(payload.message).toStartWith("Context window overflow:");
    expect(payload.message).toContain("maximum context length");
  });
});
