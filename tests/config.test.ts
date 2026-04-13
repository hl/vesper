import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveAgent } from "../src/config.js";
import { VesperError } from "../src/errors.js";

describe("resolveAgent", () => {
  let tempDir: string;
  let cwdVesper: string;
  let homeVesper: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-test-"));
    cwdVesper = join(tempDir, "project", ".vesper", "agents");
    fakeHome = join(tempDir, "fakehome");
    homeVesper = join(fakeHome, ".config", "vesper");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves agent from cwd/.vesper/agents/ when .yml exists", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");

    const result = resolveAgent("myagent", join(tempDir, "project"), fakeHome);

    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
    expect(result.vesperDir).toBe(join(tempDir, "project", ".vesper"));
  });

  it("does not require co-located .md file", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");
    // No .md file alongside .yml — should still resolve

    const result = resolveAgent("myagent", join(tempDir, "project"), fakeHome);
    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
  });

  it("ignores co-located .md file when present", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");
    writeFileSync(join(cwdVesper, "myagent.md"), "# Legacy prompt\n");

    const result = resolveAgent("myagent", join(tempDir, "project"), fakeHome);
    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
    expect(result.vesperDir).toBe(join(tempDir, "project", ".vesper"));
  });

  it("falls back to ~/.config/vesper/agents/ when not present in cwd", () => {
    const homeAgents = join(homeVesper, "agents");
    mkdirSync(homeAgents, { recursive: true });
    writeFileSync(join(homeAgents, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");

    const result = resolveAgent("myagent", join(tempDir, "project"), fakeHome);

    expect(result.configPath).toBe(join(homeAgents, "myagent.yml"));
    expect(result.vesperDir).toBe(homeVesper);
  });

  it("prefers cwd/.vesper/ over ~/.config/vesper/ when both have the agent", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");

    const homeAgents = join(homeVesper, "agents");
    mkdirSync(homeAgents, { recursive: true });
    writeFileSync(join(homeAgents, "myagent.yml"), "system_prompt: system_prompts/myagent.md\n");

    const result = resolveAgent("myagent", join(tempDir, "project"), fakeHome);

    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
    expect(result.vesperDir).toBe(join(tempDir, "project", ".vesper"));
  });

  it("exits with code 1 when agent is not found in any location", () => {
    expect(() => resolveAgent("nonexistent", join(tempDir, "project"), fakeHome)).toThrow(
      VesperError,
    );

    try {
      resolveAgent("nonexistent", join(tempDir, "project"), fakeHome);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("nonexistent");
    }
  });

  it("shows migration hint when agent .yml exists at old .vesper/ path", () => {
    const oldDir = join(tempDir, "project", ".vesper");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "myagent.yml"), "system_prompt: prompt.md\n");

    try {
      resolveAgent("myagent", join(tempDir, "project"), fakeHome);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain(".vesper/agents");
      expect((e as VesperError).message).toContain("mkdir -p");
    }
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeYaml(filename: string, content: string): string {
    const path = join(tempDir, filename);
    writeFileSync(path, content);
    return path;
  }

  const validYaml = `
system_prompt: prompt.md
token_budget: 100000
tools:
  read:
    - "src/**/*.ts"
  write:
    - "src/**/*.ts"
  delete: []
  commands:
    - "bun test"
`;

  const minimalYaml = `
system_prompt: prompt.md
token_budget: 50000
tools: {}
`;

  it("parses a full config with all keys", () => {
    const path = writeYaml("full.yml", validYaml);
    const config = loadConfig(path);

    expect(config.system_prompt).toBe("prompt.md");
    expect(config.token_budget).toBe(100000);
    expect(config.log_denied_calls).toBe(false);
    expect(config.tools.read).toEqual(["src/**/*.ts"]);
    expect(config.tools.write).toEqual(["src/**/*.ts"]);
    expect(config.tools.delete).toEqual([]);
    expect(config.tools.commands).toEqual(["bun test"]);
  });

  it("parses all optional keys with correct defaults when absent", () => {
    const path = writeYaml("minimal.yml", minimalYaml);
    const config = loadConfig(path);

    expect(config.system_prompt).toBe("prompt.md");
    expect(config.token_budget).toBe(50000);
    expect(config.log_denied_calls).toBe(false);
    expect(config.tools.read).toEqual([]);
    expect(config.tools.write).toEqual([]);
    expect(config.tools.delete).toEqual([]);
    expect(config.tools.commands).toEqual([]);
  });

  it("silently ignores completion block in YAML for backward compatibility", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
tools: {}
completion:
  watch_file: done.txt
  no_progress_limit: 5
`;
    const path = writeYaml("has-completion.yml", yaml);
    const config = loadConfig(path);
    expect(config.system_prompt).toBe("prompt.md");
    expect(config.token_budget).toBe(50000);
  });

  it("respects log_denied_calls when set to true", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
log_denied_calls: true
tools: {}
`;
    const path = writeYaml("log.yml", yaml);
    const config = loadConfig(path);
    expect(config.log_denied_calls).toBe(true);
  });

  it("exits with code 1 when system_prompt key is absent", () => {
    const yaml = `
token_budget: 50000
tools: {}
`;
    const path = writeYaml("no-prompt.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("system_prompt");
    }
  });

  it("exits with code 1 when token_budget key is absent", () => {
    const yaml = `
system_prompt: prompt.md
tools: {}
`;
    const path = writeYaml("no-budget.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("token_budget");
    }
  });

  it("exits with code 1 when tools key is absent", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
`;
    const path = writeYaml("no-tools.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("tools");
    }
  });

  it("exits with code 1 when config is not a YAML mapping", () => {
    const path = writeYaml("bad.yml", "- just\n- a\n- list\n");

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("YAML mapping");
    }
  });

  it("exits with code 1 when system_prompt is not a string", () => {
    const yaml = `
system_prompt: 42
token_budget: 50000
tools: {}
`;
    const path = writeYaml("bad-prompt.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("system_prompt");
    }
  });

  it("exits with code 1 when token_budget is not a number", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: "not a number"
tools: {}
`;
    const path = writeYaml("bad-budget.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("token_budget");
    }
  });

  it("exits with code 1 when tools.read contains non-strings", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
tools:
  read:
    - 1
    - 2
    - 3
`;
    const path = writeYaml("bad-read.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("tools.read");
    }
  });

  it("exits with code 1 when token_budget is zero", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 0
tools: {}
`;
    const path = writeYaml("zero-budget.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("token_budget");
    }
  });

  it("exits with code 1 when token_budget is negative", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: -100
tools: {}
`;
    const path = writeYaml("negative-budget.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("token_budget");
    }
  });

  it("exits with code 1 when config file does not exist", () => {
    const path = join(tempDir, "nonexistent.yml");

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("not found");
    }
  });

  it("exits with code 1 when model is a non-string value", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
model: 42
tools: {}
`;
    const path = writeYaml("bad-model.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("model");
    }
  });

  it("parses model correctly when it is a valid string", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
model: claude-sonnet-4-20250514
tools: {}
`;
    const path = writeYaml("valid-model.yml", yaml);
    const config = loadConfig(path);
    expect(config.model).toBe("claude-sonnet-4-20250514");
  });

  it("exits with code 1 when command_timeout is zero", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
command_timeout: 0
tools: {}
`;
    const path = writeYaml("zero-timeout.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("command_timeout");
    }
  });

  it("exits with code 1 when command_timeout is a string", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
command_timeout: "fast"
tools: {}
`;
    const path = writeYaml("string-timeout.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("command_timeout");
    }
  });

  it("exits with code 1 when scratchpad is a non-string value", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
scratchpad: 42
tools: {}
`;
    const path = writeYaml("bad-scratchpad.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("scratchpad");
    }
  });

  it("parses scratchpad correctly when it is a valid string", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
scratchpad: /tmp/scratch.md
tools: {}
`;
    const path = writeYaml("valid-scratchpad.yml", yaml);
    const config = loadConfig(path);
    expect(config.scratchpad).toBe("/tmp/scratch.md");
  });

  it("exits with code 1 when skills is a non-string value", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
skills: 42
tools: {}
`;
    const path = writeYaml("bad-skills.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("skills");
    }
  });

  it("parses skills correctly when it is a valid string", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
skills: .vesper/skills
tools: {}
`;
    const path = writeYaml("valid-skills.yml", yaml);
    const config = loadConfig(path);
    expect(config.skills).toBe(".vesper/skills");
  });

  it("has correct v0.2 defaults when no new fields are specified", () => {
    const path = writeYaml("defaults-v02.yml", minimalYaml);
    const config = loadConfig(path);

    expect(config.model).toBeUndefined();
    expect(config.reveal_permissions).toBe(false);
    expect(config.log_events).toBe(false);
    expect(config.command_timeout).toBe(30);
    expect(config.scratchpad).toBeNull();
    expect(config.skills).toBeNull();
    expect(config.context_files).toEqual([]);
  });

  it("parses context_files correctly when it is a valid string array", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
context_files:
  - CLAUDE.md
  - .cursorrules
tools: {}
`;
    const path = writeYaml("valid-context-files.yml", yaml);
    const config = loadConfig(path);
    expect(config.context_files).toEqual(["CLAUDE.md", ".cursorrules"]);
  });

  it("defaults context_files to empty array when absent", () => {
    const path = writeYaml("no-context-files.yml", minimalYaml);
    const config = loadConfig(path);
    expect(config.context_files).toEqual([]);
  });

  it("exits with code 1 when context_files contains non-strings", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
context_files:
  - 1
  - 2
tools: {}
`;
    const path = writeYaml("bad-context-files.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("context_files");
    }
  });

  it("parses default_signal: complete correctly", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
default_signal: complete
tools: {}
`;
    const path = writeYaml("signal-complete.yml", yaml);
    const config = loadConfig(path);
    expect(config.default_signal).toBe("complete");
  });

  it("parses default_signal: none correctly", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
default_signal: none
tools: {}
`;
    const path = writeYaml("signal-none.yml", yaml);
    const config = loadConfig(path);
    expect(config.default_signal).toBe("none");
  });

  it("defaults default_signal to complete when absent", () => {
    const path = writeYaml("no-signal.yml", minimalYaml);
    const config = loadConfig(path);
    expect(config.default_signal).toBe("complete");
  });

  it("exits with code 1 when default_signal is an invalid string", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
default_signal: invalid
tools: {}
`;
    const path = writeYaml("bad-signal.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("default_signal");
    }
  });

  it("exits with code 1 when default_signal is a non-string value", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
default_signal: 123
tools: {}
`;
    const path = writeYaml("numeric-signal.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("default_signal");
    }
  });
});
