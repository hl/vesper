import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VesperError } from "../src/errors.js";
import { init } from "../src/init.js";

describe("vesper init", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-init-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readFile(relPath: string): string {
    return readFileSync(join(tempDir, relPath), "utf-8");
  }

  function fileExists(relPath: string): boolean {
    return existsSync(join(tempDir, relPath));
  }

  describe("happy path: init in empty directory", () => {
    it("creates all expected directories", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".vesper/agents")).toBe(true);
      expect(fileExists(".vesper/system_prompts")).toBe(true);
      expect(fileExists(".vesper/skills")).toBe(true);
      expect(fileExists(".vesper/memories")).toBe(true);

      // Verify they are directories
      expect(lstatSync(join(tempDir, ".vesper/agents")).isDirectory()).toBe(true);
      expect(lstatSync(join(tempDir, ".vesper/system_prompts")).isDirectory()).toBe(true);
      expect(lstatSync(join(tempDir, ".vesper/skills")).isDirectory()).toBe(true);
      expect(lstatSync(join(tempDir, ".vesper/memories")).isDirectory()).toBe(true);
    });

    it("creates example agent config", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".vesper/agents/example.yml")).toBe(true);
      const content = readFile(".vesper/agents/example.yml");
      expect(content).toContain("system_prompt: system_prompts/example.md");
      expect(content).toContain("token_budget: 100000");
      expect(content).toContain("tools:");
      expect(content).toContain("signals:");
    });

    it("creates example system prompt", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".vesper/system_prompts/example.md")).toBe(true);
      const content = readFile(".vesper/system_prompts/example.md");
      expect(content).toContain("You are a helpful agent");
      expect(content).toContain("## Guidelines");
    });

    it("creates CLAUDE.md", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".vesper/CLAUDE.md")).toBe(true);
      const content = readFile(".vesper/CLAUDE.md");
      expect(content).toContain("agents/");
      expect(content).toContain("system_prompts/");
      expect(content).toContain("skills/");
      expect(content).toContain("vesper run");
    });

    it("creates .gitignore with vesper entries", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".gitignore")).toBe(true);
      const content = readFile(".gitignore");
      expect(content).toContain("# vesper");
      expect(content).toContain(".vesper-complete");
      expect(content).toContain(".vesper-needs-approval");
      expect(content).toContain(".vesper-failed");
      expect(content).toContain(".vesper/.scratchpad*.md");
    });
  });

  describe("happy path: existing .vesper/ directory", () => {
    it("skips dir creation, still creates files", async () => {
      mkdirSync(join(tempDir, ".vesper", "agents"), { recursive: true });
      mkdirSync(join(tempDir, ".vesper", "system_prompts"), { recursive: true });

      await init({ force: false, global: false, cwd: tempDir });

      // Dirs still exist
      expect(fileExists(".vesper/agents")).toBe(true);
      expect(fileExists(".vesper/system_prompts")).toBe(true);
      // Files were created
      expect(fileExists(".vesper/agents/example.yml")).toBe(true);
      expect(fileExists(".vesper/system_prompts/example.md")).toBe(true);
      expect(fileExists(".vesper/CLAUDE.md")).toBe(true);
    });
  });

  describe("happy path: existing example.yml", () => {
    it("skips existing file without error", async () => {
      mkdirSync(join(tempDir, ".vesper", "agents"), { recursive: true });
      writeFileSync(join(tempDir, ".vesper/agents/example.yml"), "original content\n");

      await init({ force: false, global: false, cwd: tempDir });

      // Original content preserved
      const content = readFile(".vesper/agents/example.yml");
      expect(content).toBe("original content\n");

      // Other files still created
      expect(fileExists(".vesper/system_prompts/example.md")).toBe(true);
      expect(fileExists(".vesper/CLAUDE.md")).toBe(true);
    });
  });

  describe("happy path: --force overwrites", () => {
    it("overwrites existing example files with --force", async () => {
      mkdirSync(join(tempDir, ".vesper", "agents"), { recursive: true });
      mkdirSync(join(tempDir, ".vesper", "system_prompts"), { recursive: true });
      writeFileSync(join(tempDir, ".vesper/agents/example.yml"), "old config\n");
      writeFileSync(join(tempDir, ".vesper/system_prompts/example.md"), "old prompt\n");
      writeFileSync(join(tempDir, ".vesper/CLAUDE.md"), "old claude\n");

      await init({ force: true, global: false, cwd: tempDir });

      const config = readFile(".vesper/agents/example.yml");
      expect(config).toContain("system_prompt: system_prompts/example.md");
      expect(config).not.toBe("old config\n");

      const prompt = readFile(".vesper/system_prompts/example.md");
      expect(prompt).toContain("You are a helpful agent");
      expect(prompt).not.toBe("old prompt\n");

      const claude = readFile(".vesper/CLAUDE.md");
      expect(claude).toContain("Agent Configuration");
      expect(claude).not.toBe("old claude\n");
    });
  });

  describe("happy path: --global", () => {
    it("local init creates memories/ and .gitignore", async () => {
      // --global skips memories/ and .gitignore — verify local creates them
      await init({ force: false, global: false, cwd: tempDir });
      expect(fileExists(".vesper/memories")).toBe(true);
      expect(fileExists(".gitignore")).toBe(true);
    });

    it("global init creates under home dir, no memories/, no .gitignore", async () => {
      const fakeHome = join(tempDir, "fakehome");
      mkdirSync(fakeHome, { recursive: true });

      await init({ force: false, global: true, cwd: tempDir, home: fakeHome });

      const globalRoot = join(fakeHome, ".config", "vesper");

      // Directories created under ~/.config/vesper/
      expect(existsSync(join(globalRoot, "agents"))).toBe(true);
      expect(existsSync(join(globalRoot, "system_prompts"))).toBe(true);
      expect(existsSync(join(globalRoot, "skills"))).toBe(true);

      // No memories/ for global
      expect(existsSync(join(globalRoot, "memories"))).toBe(false);

      // Files created
      expect(existsSync(join(globalRoot, "agents", "example.yml"))).toBe(true);
      expect(existsSync(join(globalRoot, "system_prompts", "example.md"))).toBe(true);
      expect(existsSync(join(globalRoot, "CLAUDE.md"))).toBe(true);

      // No .gitignore in cwd (global init skips it)
      expect(fileExists(".gitignore")).toBe(false);
      // No .vesper/ in cwd (global init writes to ~/.config/vesper/)
      expect(fileExists(".vesper")).toBe(false);
    });
  });

  describe("happy path: .gitignore with partial entries", () => {
    it("appends only missing entries", async () => {
      writeFileSync(
        join(tempDir, ".gitignore"),
        "node_modules/\n.vesper-complete\n.vesper-failed\n",
      );

      await init({ force: false, global: false, cwd: tempDir });

      const content = readFile(".gitignore");
      // Original entries preserved
      expect(content).toContain("node_modules/");
      // Existing entries not duplicated
      const completeMatches = content.split(".vesper-complete").length - 1;
      expect(completeMatches).toBe(1);
      const failedMatches = content.split(".vesper-failed").length - 1;
      expect(failedMatches).toBe(1);
      // Missing entries added
      expect(content).toContain(".vesper-needs-approval");
      expect(content).toContain(".vesper/.scratchpad*.md");
      expect(content).toContain("# vesper");
    });
  });

  describe("happy path: .gitignore does not exist", () => {
    it("creates .gitignore with vesper entries", async () => {
      expect(fileExists(".gitignore")).toBe(false);

      await init({ force: false, global: false, cwd: tempDir });

      expect(fileExists(".gitignore")).toBe(true);
      const content = readFile(".gitignore");
      expect(content).toContain("# vesper");
      expect(content).toContain(".vesper-complete");
      expect(content).toContain(".vesper-needs-approval");
      expect(content).toContain(".vesper-failed");
      expect(content).toContain(".vesper/.scratchpad*.md");
    });
  });

  describe("happy path: all .gitignore entries present", () => {
    it("does not add # vesper section", async () => {
      const existingContent = [
        "node_modules/",
        ".vesper-complete",
        ".vesper-needs-approval",
        ".vesper-failed",
        ".vesper/.scratchpad*.md",
        "",
      ].join("\n");
      writeFileSync(join(tempDir, ".gitignore"), existingContent);

      await init({ force: false, global: false, cwd: tempDir });

      const content = readFile(".gitignore");
      // No # vesper section added
      expect(content).not.toContain("# vesper");
      // Content unchanged
      expect(content).toBe(existingContent);
    });
  });

  describe("edge case: commented-out entries treated as absent", () => {
    it("appends real entries when existing are commented out", async () => {
      const existingContent = [
        "node_modules/",
        "# .vesper-complete",
        "# .vesper-needs-approval",
        "",
      ].join("\n");
      writeFileSync(join(tempDir, ".gitignore"), existingContent);

      await init({ force: false, global: false, cwd: tempDir });

      const content = readFile(".gitignore");
      // All four entries should be added as uncommented
      expect(content).toContain("\n.vesper-complete\n");
      expect(content).toContain("\n.vesper-needs-approval\n");
      expect(content).toContain("\n.vesper-failed\n");
      expect(content).toContain("\n.vesper/.scratchpad*.md\n");
    });
  });

  describe("error path: .vesper/ is a symlink", () => {
    it("throws VesperError when .vesper is a symlink", async () => {
      const realDir = join(tempDir, "real-vesper");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, join(tempDir, ".vesper"));

      try {
        await init({ force: false, global: false, cwd: tempDir });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(VesperError);
        expect((e as VesperError).message).toContain("symlink");
      }
    });

    it("throws VesperError when a .vesper subdirectory is a symlink", async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "vesper-init-outside-"));
      try {
        mkdirSync(join(tempDir, ".vesper"), { recursive: true });
        symlinkSync(outsideDir, join(tempDir, ".vesper", "agents"));

        try {
          await init({ force: false, global: false, cwd: tempDir });
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(VesperError);
          expect((e as VesperError).message).toContain("symlink");
          expect(existsSync(join(outsideDir, "example.yml"))).toBe(false);
        }
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("error path: .gitignore is a symlink", () => {
    it("throws VesperError when .gitignore is a symlink", async () => {
      const realFile = join(tempDir, "real-gitignore");
      writeFileSync(realFile, "node_modules/\n");
      symlinkSync(realFile, join(tempDir, ".gitignore"));

      try {
        await init({ force: false, global: false, cwd: tempDir });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(VesperError);
        expect((e as VesperError).message).toContain("symlink");
        expect((e as VesperError).message).toContain(".gitignore");
      }
    });
  });

  describe("error path: target file is a symlink", () => {
    it("throws VesperError when example.yml is a symlink", async () => {
      mkdirSync(join(tempDir, ".vesper", "agents"), { recursive: true });
      const realFile = join(tempDir, "real-example.yml");
      writeFileSync(realFile, "original\n");
      symlinkSync(realFile, join(tempDir, ".vesper/agents/example.yml"));

      try {
        await init({ force: true, global: false, cwd: tempDir });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(VesperError);
        expect((e as VesperError).message).toContain("symlink");
      }
    });
  });

  describe("integration: idempotent", () => {
    it("running init twice produces same result", async () => {
      await init({ force: false, global: false, cwd: tempDir });

      // Record state after first run
      const configAfterFirst = readFile(".vesper/agents/example.yml");
      const promptAfterFirst = readFile(".vesper/system_prompts/example.md");
      const claudeAfterFirst = readFile(".vesper/CLAUDE.md");
      const gitignoreAfterFirst = readFile(".gitignore");

      // Run again
      await init({ force: false, global: false, cwd: tempDir });

      // Everything identical
      expect(readFile(".vesper/agents/example.yml")).toBe(configAfterFirst);
      expect(readFile(".vesper/system_prompts/example.md")).toBe(promptAfterFirst);
      expect(readFile(".vesper/CLAUDE.md")).toBe(claudeAfterFirst);
      expect(readFile(".gitignore")).toBe(gitignoreAfterFirst);

      // No duplicate .gitignore entries
      const gitignoreContent = readFile(".gitignore");
      const vesperCompleteCount = gitignoreContent.split(".vesper-complete").length - 1;
      expect(vesperCompleteCount).toBe(1);
    });
  });

  describe("edge case: .gitignore without trailing newline", () => {
    it("adds separator before vesper section", async () => {
      writeFileSync(join(tempDir, ".gitignore"), "node_modules/");

      await init({ force: false, global: false, cwd: tempDir });

      const content = readFile(".gitignore");
      // Should have proper separation
      expect(content).toStartWith("node_modules/");
      expect(content).toContain("\n\n# vesper\n");
    });
  });
});
