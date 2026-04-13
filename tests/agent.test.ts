import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { executeTool, extractLastText, type MessageClient, runAgent } from "../src/agent.js";
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
});
