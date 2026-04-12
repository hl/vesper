import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile as fsWriteFile, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, listFiles, writeFile, patchFile, deleteFile, runCommand } from "../src/tools.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vesper-tools-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readFile", () => {
  it("returns file contents for a valid path", async () => {
    const filePath = join(tempDir, "hello.txt");
    await fsWriteFile(filePath, "hello world");

    const result = await readFile(filePath);
    expect(result).toEqual({ content: "hello world" });
  });

  it("returns not_found for a missing file", async () => {
    const result = await readFile(join(tempDir, "does-not-exist.txt"));
    expect(result).toEqual({ error: "not_found" });
  });
});

describe("listFiles", () => {
  it("returns directory entries for a valid directory", async () => {
    await fsWriteFile(join(tempDir, "a.txt"), "a");
    await fsWriteFile(join(tempDir, "b.txt"), "b");

    const result = await listFiles(tempDir);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries.sort()).toEqual(["a.txt", "b.txt"]);
    }
  });

  it("returns not_found for a missing directory", async () => {
    const result = await listFiles(join(tempDir, "no-such-dir"));
    expect(result).toEqual({ error: "not_found" });
  });

  it("returns not_found when called on a regular file", async () => {
    const filePath = join(tempDir, "regular-file.txt");
    await fsWriteFile(filePath, "content");

    const result = await listFiles(filePath);
    expect(result).toEqual({ error: "not_found" });
  });
});

describe("writeFile", () => {
  it("creates intermediate directories as needed", async () => {
    const filePath = join(tempDir, "deep", "nested", "dir", "file.txt");
    const result = await writeFile(filePath, "deep content");

    expect(result).toEqual({ ok: true });
    const written = await fsReadFile(filePath, "utf-8");
    expect(written).toBe("deep content");
  });

  it("overwrites an existing file", async () => {
    const filePath = join(tempDir, "overwrite.txt");
    await fsWriteFile(filePath, "original");

    const result = await writeFile(filePath, "replaced");
    expect(result).toEqual({ ok: true });

    const written = await fsReadFile(filePath, "utf-8");
    expect(written).toBe("replaced");
  });
});

describe("patchFile", () => {
  it("applies a valid unified diff correctly", async () => {
    const filePath = join(tempDir, "test.txt");
    await fsWriteFile(filePath, "line one\nline two\nline three\n");

    const patch = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "",
    ].join("\n");

    const result = await patchFile(filePath, patch);
    expect(result).toEqual({ ok: true });

    const content = await fsReadFile(filePath, "utf-8");
    expect(content).toBe("line one\nline TWO\nline three\n");
  });

  it("returns patch_failed without modifying the file on invalid patch", async () => {
    const filePath = join(tempDir, "test.txt");
    const originalContent = "alpha\nbeta\ngamma\n";
    await fsWriteFile(filePath, originalContent);

    const patch = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "",
    ].join("\n");

    const result = await patchFile(filePath, patch);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("patch_failed");
      expect("detail" in result && typeof result.detail === "string" && result.detail.length > 0).toBe(true);
    }

    const content = await fsReadFile(filePath, "utf-8");
    expect(content).toBe(originalContent);
  });

  it("applies a multi-hunk diff correctly", async () => {
    const filePath = join(tempDir, "multi.txt");
    await fsWriteFile(
      filePath,
      "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n",
    );

    const patch = [
      "--- a/multi.txt",
      "+++ b/multi.txt",
      "@@ -1,3 +1,3 @@",
      "-line 1",
      "+LINE ONE",
      " line 2",
      " line 3",
      "@@ -5,2 +5,2 @@",
      "-line 5",
      "+LINE FIVE",
      " line 6",
      "",
    ].join("\n");

    const result = await patchFile(filePath, patch);
    expect(result).toEqual({ ok: true });

    const content = await fsReadFile(filePath, "utf-8");
    expect(content).toBe("LINE ONE\nline 2\nline 3\nline 4\nLINE FIVE\nline 6\n");
  });

  it("returns not_found for a missing file", async () => {
    const result = await patchFile(join(tempDir, "nope.txt"), "some patch");
    expect(result).toEqual({ error: "not_found" });
  });
});

describe("deleteFile", () => {
  it("removes the file", async () => {
    const filePath = join(tempDir, "to-delete.txt");
    await fsWriteFile(filePath, "bye");

    const result = await deleteFile(filePath);
    expect(result).toEqual({ ok: true });

    const exists = await Bun.file(filePath).exists();
    expect(exists).toBe(false);
  });

  it("returns not_found for a missing file", async () => {
    const result = await deleteFile(join(tempDir, "ghost.txt"));
    expect(result).toEqual({ error: "not_found" });
  });
});

describe("runCommand", () => {
  it("returns stdout, stderr, and exit code 0 for a successful command", async () => {
    const result = await runCommand("echo", ["hello"], tempDir);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("returns stdout, stderr, and non-zero exit code for a failing command", async () => {
    const result = await runCommand("sh", ["-c", "echo err >&2; exit 42"], tempDir);
    expect(result.stderr.trim()).toBe("err");
    expect(result.exit_code).toBe(42);
  });

  it("returns exit_code 127 and non-empty stderr for a non-existent binary", async () => {
    const result = await runCommand("nonexistent_binary_xyz", [], tempDir);
    expect(result.exit_code).toBe(127);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("completes normally when the command finishes within the timeout", async () => {
    const result = await runCommand("echo", ["hello"], tempDir, 5);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("returns exit_code 124 and stderr containing 'timed out' when the command exceeds the timeout", async () => {
    const result = await runCommand("sleep", ["10"], tempDir, 1);
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toContain("timed out");
  }, 10_000);
});
