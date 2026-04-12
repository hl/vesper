import { describe, it, expect } from "bun:test";
import {
  checkPathPermission,
  checkCommandPermission,
  isInsideCwd,
} from "../src/permissions.js";

const cwd = "/project";

describe("checkPathPermission", () => {
  it("permits a path matching a glob in the read list", () => {
    expect(checkPathPermission("src/index.ts", cwd, ["src/**"])).toBe(true);
  });

  it("permits a path matching a glob in the write list", () => {
    expect(checkPathPermission("src/lib/utils.ts", cwd, ["src/**"])).toBe(true);
  });

  it("permits a path matching a glob in the delete list", () => {
    expect(checkPathPermission("tmp/cache.json", cwd, ["tmp/**"])).toBe(true);
  });

  it("denies a path not matching any glob", () => {
    expect(checkPathPermission("secrets/key.pem", cwd, ["src/**"])).toBe(false);
  });

  it("denies a path that resolves outside cwd", () => {
    expect(checkPathPermission("../../../etc/passwd", cwd, ["**"])).toBe(false);
  });

  it("denies a path outside cwd even with absolute path", () => {
    expect(checkPathPermission("/etc/passwd", cwd, ["**"])).toBe(false);
  });

  it("permits a direct file match", () => {
    expect(checkPathPermission("README.md", cwd, ["README.md"])).toBe(true);
  });

  it("permits with ** glob", () => {
    expect(checkPathPermission("deep/nested/file.ts", cwd, ["**"])).toBe(true);
  });

  it("denies when allow list is empty", () => {
    expect(checkPathPermission("src/index.ts", cwd, [])).toBe(false);
  });
});

describe("isInsideCwd", () => {
  it("returns true for cwd itself", () => {
    expect(isInsideCwd("/project", "/project")).toBe(true);
  });

  it("returns true for a path inside cwd", () => {
    expect(isInsideCwd("/project/src/file.ts", "/project")).toBe(true);
  });

  it("returns false for a path outside cwd", () => {
    expect(isInsideCwd("/other/file.ts", "/project")).toBe(false);
  });

  it("returns false for prefix-tricked path", () => {
    expect(isInsideCwd("/project-evil/file.ts", "/project")).toBe(false);
  });
});

describe("checkCommandPermission", () => {
  const allowList = ["mix test", "git commit"];

  it("permits a command matching a binary+subcommand entry", () => {
    expect(checkCommandPermission("mix", ["test"], allowList)).toBe(true);
  });

  it("permits a command with additional flags", () => {
    expect(checkCommandPermission("mix", ["test", "--only", "unit"], allowList)).toBe(true);
  });

  it("denies a command whose subcommand does not match", () => {
    expect(checkCommandPermission("mix", ["compile"], allowList)).toBe(false);
  });

  it("permits git commit", () => {
    expect(checkCommandPermission("git", ["commit"], allowList)).toBe(true);
  });

  it("permits git commit with flags", () => {
    expect(checkCommandPermission("git", ["commit", "-m", "fix"], allowList)).toBe(true);
  });

  it("denies git push", () => {
    expect(checkCommandPermission("git", ["push"], allowList)).toBe(false);
  });

  it("denies a command not in the list at all", () => {
    expect(checkCommandPermission("rm", ["-rf", "/"], allowList)).toBe(false);
  });

  it("permits a binary-only entry with any arguments", () => {
    const list = ["mix"];
    expect(checkCommandPermission("mix", ["test"], list)).toBe(true);
    expect(checkCommandPermission("mix", ["compile"], list)).toBe(true);
    expect(checkCommandPermission("mix", [], list)).toBe(true);
  });

  it("denies when allow list is empty", () => {
    expect(checkCommandPermission("mix", ["test"], [])).toBe(false);
  });
});
