import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { VesperError } from "../src/errors.js";
import { buildParser, checkReservedName, loadContextFiles, RESERVED_NAMES } from "../src/index.js";

/**
 * Parse CLI args through the yargs config without executing handlers.
 * buildParser sets up commands/options but no handler callbacks.
 */
async function parseArgs(args: string[]): Promise<Record<string, unknown>> {
  const parser = buildParser(yargs(args));
  return (await parser.parse()) as unknown as Record<string, unknown>;
}

describe("CLI subcommand routing", () => {
  it("vesper run <agent> parses agent name and command", async () => {
    const argv = await parseArgs(["run", "builder"]);
    expect(argv.agent).toBe("builder");
    expect((argv._ as string[])[0]).toBe("run");
  });

  it("vesper <agent> (default command) resolves agent via positional", async () => {
    const argv = await parseArgs(["builder"]);
    expect(argv.agent).toBe("builder");
  });

  it("vesper init parses as init command", async () => {
    const argv = await parseArgs(["init"]);
    expect((argv._ as string[])[0]).toBe("init");
  });

  it("vesper with no arguments has no agent and no command", async () => {
    const argv = await parseArgs([]);
    expect(argv.agent).toBeUndefined();
    expect((argv._ as string[]).length).toBe(0);
  });
});

describe("reserved name check", () => {
  it("rejects 'init' as agent name", () => {
    expect(() => checkReservedName("init")).toThrow(VesperError);
    try {
      checkReservedName("init");
    } catch (e) {
      expect((e as VesperError).message).toContain("reserved command name");
      expect((e as VesperError).message).toContain("init");
    }
  });

  it("rejects 'run' as agent name", () => {
    expect(() => checkReservedName("run")).toThrow(VesperError);
    try {
      checkReservedName("run");
    } catch (e) {
      expect((e as VesperError).message).toContain("reserved command name");
      expect((e as VesperError).message).toContain('"run"');
    }
  });

  it("rejects 'version' as agent name", () => {
    expect(() => checkReservedName("version")).toThrow(VesperError);
    try {
      checkReservedName("version");
    } catch (e) {
      expect((e as VesperError).message).toContain("reserved command name");
      expect((e as VesperError).message).toContain("version");
    }
  });

  it("rejects 'help' as agent name", () => {
    expect(() => checkReservedName("help")).toThrow(VesperError);
    try {
      checkReservedName("help");
    } catch (e) {
      expect((e as VesperError).message).toContain("reserved command name");
      expect((e as VesperError).message).toContain("help");
    }
  });

  it("allows non-reserved names", () => {
    expect(() => checkReservedName("builder")).not.toThrow();
    expect(() => checkReservedName("planner")).not.toThrow();
    expect(() => checkReservedName("myagent")).not.toThrow();
  });

  it("RESERVED_NAMES contains all expected names", () => {
    expect(RESERVED_NAMES).toEqual(["init", "run", "help", "version"]);
  });
});

describe("loadContextFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads existing files and appends them with headers", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "Be helpful.");
    writeFileSync(join(tempDir, ".cursorrules"), "Use TypeScript.");

    const result = loadContextFiles(["CLAUDE.md", ".cursorrules"], tempDir);

    expect(result.loaded).toEqual(["CLAUDE.md", ".cursorrules"]);
    expect(result.skipped).toEqual([]);
    expect(result.content).toContain("# CLAUDE.md");
    expect(result.content).toContain("Be helpful.");
    expect(result.content).toContain("# .cursorrules");
    expect(result.content).toContain("Use TypeScript.");
  });

  it("skips files that do not exist", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "Be helpful.");

    const result = loadContextFiles(["CLAUDE.md", "missing.md"], tempDir);

    expect(result.loaded).toEqual(["CLAUDE.md"]);
    expect(result.skipped).toEqual(["missing.md"]);
    expect(result.content).toContain("Be helpful.");
    expect(result.content).not.toContain("missing.md");
  });

  it("skips empty files", () => {
    writeFileSync(join(tempDir, "empty.md"), "   \n  ");

    const result = loadContextFiles(["empty.md"], tempDir);

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual(["empty.md"]);
    expect(result.content).toBe("");
  });

  it("returns empty result for empty file list", () => {
    const result = loadContextFiles([], tempDir);

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.content).toBe("");
  });

  it("resolves paths relative to cwd", () => {
    const subdir = join(tempDir, "docs");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "rules.md"), "Some rules.");

    const result = loadContextFiles(["docs/rules.md"], tempDir);

    expect(result.loaded).toEqual(["docs/rules.md"]);
    expect(result.content).toContain("# docs/rules.md");
    expect(result.content).toContain("Some rules.");
  });

  it("skips context files that traverse outside cwd via ..", () => {
    // Create a file outside the temp dir to simulate escape
    const outsideDir = mkdtempSync(join(tmpdir(), "vesper-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");

      const result = loadContextFiles([`../../${outsideDir.split("/").pop()}/secret.txt`], tempDir);

      expect(result.loaded).toEqual([]);
      expect(result.skipped.length).toBe(1);
      expect(result.content).toBe("");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips context files that are symlinks pointing outside cwd", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "vesper-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");
      symlinkSync(join(outsideDir, "secret.txt"), join(tempDir, "sneaky-link.txt"));

      const result = loadContextFiles(["sneaky-link.txt"], tempDir);

      expect(result.loaded).toEqual([]);
      expect(result.skipped.length).toBe(1);
      expect(result.content).toBe("");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
