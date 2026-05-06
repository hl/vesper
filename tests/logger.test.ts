import { describe, expect, it } from "bun:test";
import { Logger } from "../src/logger.js";

describe("Logger", () => {
  it("emits JSONL to stderr when enabled", () => {
    const logger = new Logger(true);

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    logger.apiCall("claude-sonnet-4-20250514", 100, 200, 350);
    logger.toolCall("read", "src/main.ts", true, 12);
    logger.subagentUsage("reviewer", 40, 10);
    logger.mcpServerStartup("jira", "bun", true, 25);
    logger.mcpToolCall("jira", "search", true, 15, true);
    logger.signalWrite("done", "/tmp/done.txt");
    logger.skillsLoaded(3, 4096, ["a.md", "b.md", "c.md"]);

    process.stderr.write = original;

    const lines = captured.trim().split("\n");
    expect(lines.length).toBe(7);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.event).toBe("string");
      expect(typeof parsed.run_id).toBe("string");
      expect(typeof parsed.timestamp).toBe("string");
      // Verify timestamp is valid ISO 8601
      const date = new Date(parsed.timestamp);
      expect(date.toISOString()).toBe(parsed.timestamp);
    }

    // Verify event-specific fields
    const apiCallEvent = JSON.parse(lines[0]);
    expect(apiCallEvent.event).toBe("api_call");
    expect(apiCallEvent.model).toBe("claude-sonnet-4-20250514");
    expect(apiCallEvent.input_tokens).toBe(100);
    expect(apiCallEvent.output_tokens).toBe(200);
    expect(apiCallEvent.latency_ms).toBe(350);

    const toolCallEvent = JSON.parse(lines[1]);
    expect(toolCallEvent.event).toBe("tool_call");
    expect(toolCallEvent.tool).toBe("read");
    expect(toolCallEvent.target).toBe("src/main.ts");
    expect(toolCallEvent.permitted).toBe(true);
    expect(toolCallEvent.duration_ms).toBe(12);

    const subagentUsageEvent = JSON.parse(lines[2]);
    expect(subagentUsageEvent.event).toBe("subagent_usage");
    expect(subagentUsageEvent.agent).toBe("reviewer");
    expect(subagentUsageEvent.input_tokens).toBe(40);
    expect(subagentUsageEvent.output_tokens).toBe(10);

    const mcpStartupEvent = JSON.parse(lines[3]);
    expect(mcpStartupEvent.event).toBe("mcp_server_startup");
    expect(mcpStartupEvent.server).toBe("jira");
    expect(mcpStartupEvent.command).toBe("bun");
    expect(mcpStartupEvent.success).toBe(true);
    expect(mcpStartupEvent.duration_ms).toBe(25);

    const mcpToolEvent = JSON.parse(lines[4]);
    expect(mcpToolEvent.event).toBe("mcp_tool_call");
    expect(mcpToolEvent.server).toBe("jira");
    expect(mcpToolEvent.tool).toBe("search");
    expect(mcpToolEvent.permitted).toBe(true);
    expect(mcpToolEvent.success).toBe(true);
    expect(mcpToolEvent.duration_ms).toBe(15);

    const signalEvent = JSON.parse(lines[5]);
    expect(signalEvent.event).toBe("signal_write");
    expect(signalEvent.signal_type).toBe("done");
    expect(signalEvent.path).toBe("/tmp/done.txt");

    const skillsEvent = JSON.parse(lines[6]);
    expect(skillsEvent.event).toBe("skills_loaded");
    expect(skillsEvent.file_count).toBe(3);
    expect(skillsEvent.total_bytes).toBe(4096);
    expect(skillsEvent.files).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("emits nothing to stderr when disabled", () => {
    const logger = new Logger(false);

    let captured = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };

    logger.apiCall("claude-sonnet-4-20250514", 100, 200, 350);
    logger.toolCall("read", "src/main.ts", true, 12);
    logger.signalWrite("done", "/tmp/done.txt");
    logger.skillsLoaded(2, 1024, ["x.md", "y.md"]);

    process.stderr.write = original;

    expect(captured).toBe("");
  });

  it("has a run_id that matches UUID format", () => {
    const logger = new Logger(false);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(logger.runId).toMatch(uuidRegex);
  });
});
