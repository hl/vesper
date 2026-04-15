import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommandPermission, checkPathPermission } from "../src/permissions.js";

describe("checkPathPermission", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vesper-perm-cwd-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "tmp"), { recursive: true });
    mkdirSync(join(cwd, "secrets"), { recursive: true });
    mkdirSync(join(cwd, "deep", "nested"), { recursive: true });
    writeFileSync(join(cwd, "src", "index.ts"), "");
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    writeFileSync(join(cwd, "src", "lib", "utils.ts"), "");
    writeFileSync(join(cwd, "tmp", "cache.json"), "");
    writeFileSync(join(cwd, "secrets", "key.pem"), "");
    writeFileSync(join(cwd, "README.md"), "");
    writeFileSync(join(cwd, "deep", "nested", "file.ts"), "");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

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

  it("permits listing cwd root with ** glob", () => {
    expect(checkPathPermission(".", cwd, ["**"])).toBe(true);
  });

  it("denies listing cwd root when glob does not match", () => {
    expect(checkPathPermission(".", cwd, ["src/**"])).toBe(false);
  });

  it("permits write to new nested directories that do not exist yet", () => {
    // new-dir/sub/ doesn't exist, but writeFile will create it with mkdir -p.
    // The permission check should still pass if the pattern allows it.
    expect(checkPathPermission("new-dir/sub/file.txt", cwd, ["**"])).toBe(true);
  });

  it("permits write to single new directory that does not exist yet", () => {
    expect(checkPathPermission("brand-new/file.txt", cwd, ["brand-new/**"])).toBe(true);
  });

  it("denies write to new nested directory when pattern does not match", () => {
    expect(checkPathPermission("new-dir/sub/file.txt", cwd, ["src/**"])).toBe(false);
  });
});

describe("checkPathPermission — symlink escape", () => {
  let cwd: string;
  let outsideDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "vesper-perm-"));
    outsideDir = mkdtempSync(join(tmpdir(), "vesper-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "sensitive data");
    mkdirSync(join(cwd, "src"), { recursive: true });
    symlinkSync(outsideDir, join(cwd, "src", "escape-link"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("denies a symlink inside cwd that points outside cwd", () => {
    expect(checkPathPermission("src/escape-link/secret.txt", cwd, ["**"])).toBe(false);
  });

  it("permits a regular file inside cwd", () => {
    writeFileSync(join(cwd, "src", "real.txt"), "ok");
    expect(checkPathPermission("src/real.txt", cwd, ["**"])).toBe(true);
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
