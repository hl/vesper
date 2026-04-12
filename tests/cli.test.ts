import { describe, expect, it } from "bun:test";
import yargs from "yargs";
import { VesperError } from "../src/errors.js";
import { buildParser, checkReservedName, RESERVED_NAMES } from "../src/index.js";

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
