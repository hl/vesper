import { mkdir, readdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { applyPatch } from "diff";

export async function readFile(
  resolvedPath: string,
): Promise<{ content: string } | { error: "not_found" }> {
  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    return { error: "not_found" };
  }
  const content = await file.text();
  return { content };
}

export async function listFiles(
  resolvedPath: string,
): Promise<{ entries: string[] } | { error: "not_found" }> {
  try {
    const entries = await readdir(resolvedPath);
    return { entries };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err.code === "ENOENT" || err.code === "ENOTDIR")
    ) {
      return { error: "not_found" };
    }
    throw err;
  }
}

export async function writeFile(resolvedPath: string, content: string): Promise<{ ok: true }> {
  await mkdir(dirname(resolvedPath), { recursive: true });
  await Bun.write(resolvedPath, content);
  return { ok: true };
}

export async function patchFile(
  resolvedPath: string,
  patch: string,
): Promise<{ ok: true } | { error: "not_found" } | { error: "patch_failed"; detail: string }> {
  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    return { error: "not_found" };
  }

  const current = await file.text();
  const result = applyPatch(current, patch);

  if (result === false) {
    return { error: "patch_failed", detail: "Patch hunks did not match file content" };
  }

  await Bun.write(resolvedPath, result);
  return { ok: true };
}

export async function deleteFile(
  resolvedPath: string,
): Promise<{ ok: true } | { error: "not_found" }> {
  try {
    await unlink(resolvedPath);
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { error: "not_found" };
    }
    throw err;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds = 30,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  try {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutSeconds * 1000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      return {
        stdout,
        stderr: `${stderr}\nCommand timed out after ${timeoutSeconds}s`,
        exit_code: 124,
      };
    }

    return {
      stdout,
      stderr,
      exit_code: proc.exitCode ?? 1,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: message,
      exit_code: 127,
    };
  }
}
