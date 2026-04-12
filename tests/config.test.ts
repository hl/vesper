import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAgent, loadConfig } from "../src/config.js";
import { VesperError } from "../src/errors.js";

describe("resolveAgent", () => {
  let tempDir: string;
  let cwdVesper: string;
  let homeVesper: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-test-"));
    cwdVesper = join(tempDir, "project", ".vesper");
    fakeHome = join(tempDir, "fakehome");
    homeVesper = join(fakeHome, ".config", "vesper");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves agent files from cwd/.vesper/ when both .yml and .md exist", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: prompt.md\n");
    writeFileSync(join(cwdVesper, "myagent.md"), "# Prompt\n");

    const result = resolveAgent(
      "myagent",
      join(tempDir, "project"),
      fakeHome,
    );

    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
    expect(result.promptPath).toBe(join(cwdVesper, "myagent.md"));
    expect(result.configDir).toBe(cwdVesper);
  });

  it("falls back to ~/.config/vesper/ when not present in cwd", () => {
    mkdirSync(homeVesper, { recursive: true });
    writeFileSync(join(homeVesper, "myagent.yml"), "system_prompt: prompt.md\n");
    writeFileSync(join(homeVesper, "myagent.md"), "# Prompt\n");

    const result = resolveAgent(
      "myagent",
      join(tempDir, "project"),
      fakeHome,
    );

    expect(result.configPath).toBe(join(homeVesper, "myagent.yml"));
    expect(result.promptPath).toBe(join(homeVesper, "myagent.md"));
    expect(result.configDir).toBe(homeVesper);
  });

  it("prefers cwd/.vesper/ over ~/.config/vesper/ when both have files", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: prompt.md\n");
    writeFileSync(join(cwdVesper, "myagent.md"), "# CWD Prompt\n");

    mkdirSync(homeVesper, { recursive: true });
    writeFileSync(join(homeVesper, "myagent.yml"), "system_prompt: prompt.md\n");
    writeFileSync(join(homeVesper, "myagent.md"), "# Home Prompt\n");

    const result = resolveAgent(
      "myagent",
      join(tempDir, "project"),
      fakeHome,
    );

    expect(result.configPath).toBe(join(cwdVesper, "myagent.yml"));
  });

  it("exits with code 1 when .yml exists but .md is missing in cwd", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.yml"), "system_prompt: prompt.md\n");

    expect(() =>
      resolveAgent("myagent", join(tempDir, "project"), fakeHome),
    ).toThrow(VesperError);

    try {
      resolveAgent("myagent", join(tempDir, "project"), fakeHome);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("myagent.md");
    }
  });

  it("exits with code 1 when .md exists but .yml is missing in cwd", () => {
    mkdirSync(cwdVesper, { recursive: true });
    writeFileSync(join(cwdVesper, "myagent.md"), "# Prompt\n");

    expect(() =>
      resolveAgent("myagent", join(tempDir, "project"), fakeHome),
    ).toThrow(VesperError);

    try {
      resolveAgent("myagent", join(tempDir, "project"), fakeHome);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("myagent.yml");
    }
  });

  it("exits with code 1 when agent is not found in any location", () => {
    expect(() =>
      resolveAgent("nonexistent", join(tempDir, "project"), fakeHome),
    ).toThrow(VesperError);

    try {
      resolveAgent("nonexistent", join(tempDir, "project"), fakeHome);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("nonexistent");
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
completion:
  watch_file: done.txt
  no_progress_limit: 5
`;

  const minimalYaml = `
system_prompt: prompt.md
token_budget: 50000
tools: {}
completion: {}
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
    expect(config.completion.watch_file).toBe("done.txt");
    expect(config.completion.no_progress_limit).toBe(5);
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
    expect(config.completion.watch_file).toBeNull();
    expect(config.completion.no_progress_limit).toBe(3);
  });

  it("respects log_denied_calls when set to true", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
log_denied_calls: true
tools: {}
completion: {}
`;
    const path = writeYaml("log.yml", yaml);
    const config = loadConfig(path);
    expect(config.log_denied_calls).toBe(true);
  });

  it("exits with code 1 when system_prompt key is absent", () => {
    const yaml = `
token_budget: 50000
tools: {}
completion: {}
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
completion: {}
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
completion: {}
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

  it("exits with code 1 when completion key is absent", () => {
    const yaml = `
system_prompt: prompt.md
token_budget: 50000
tools: {}
`;
    const path = writeYaml("no-completion.yml", yaml);

    expect(() => loadConfig(path)).toThrow(VesperError);

    try {
      loadConfig(path);
    } catch (e) {
      expect(e).toBeInstanceOf(VesperError);
      expect((e as VesperError).code).toBe(1);
      expect((e as VesperError).message).toContain("completion");
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
completion: {}
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
completion: {}
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
});
