import { mkdir, readdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { applyPatch } from "diff";

const DEFAULT_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"];

export function truncateResult(content: string, limit: number): string {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= limit) return content;
  const suffix = `\n[truncated: showing first ${limit} of ${bytes} bytes]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf-8");
  if (suffixBytes >= limit) {
    // Limit too small to fit suffix — hard-truncate with no metadata
    return Buffer.from(content, "utf-8").subarray(0, limit).toString("utf-8");
  }
  const contentLimit = limit - suffixBytes;
  const truncated = Buffer.from(content, "utf-8").subarray(0, contentLimit).toString("utf-8");
  return `${truncated}${suffix}`;
}

export async function readFile(
  resolvedPath: string,
  maxResultSize = 102400,
): Promise<{ content: string } | { error: "not_found" }> {
  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    return { error: "not_found" };
  }
  const content = await file.text();
  return { content: truncateResult(content, maxResultSize) };
}

export async function listFiles(
  resolvedPath: string,
  maxResultSize = 102400,
): Promise<
  { entries: string[]; truncated?: boolean; total_entries?: number } | { error: "not_found" }
> {
  try {
    const entries = await readdir(resolvedPath);
    const serialized = JSON.stringify(entries);
    if (Buffer.byteLength(serialized, "utf-8") <= maxResultSize) {
      return { entries };
    }
    // Binary search for the maximum entry count that fits within the limit
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(JSON.stringify(entries.slice(0, mid)), "utf-8") <= maxResultSize) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { entries: entries.slice(0, lo), truncated: true, total_entries: entries.length };
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
  let result: string | false;
  try {
    result = applyPatch(current, patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: "patch_failed", detail: message };
  }

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

function buildCommandEnv(extraKeys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...DEFAULT_ENV_KEYS, ...extraKeys]) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds = 30,
  commandEnv: string[] = [],
  maxResultSize = 102400,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  try {
    const env = buildCommandEnv(commandEnv);
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    let timedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(); // SIGTERM
      // If the process doesn't exit within 5s of SIGTERM, send SIGKILL
      hardKillTimer = setTimeout(() => {
        proc.kill(9); // SIGKILL
      }, 5000);
    }, timeoutSeconds * 1000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;
    clearTimeout(timer);
    if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);

    if (timedOut) {
      return {
        stdout: truncateResult(stdout, maxResultSize),
        stderr: truncateResult(
          `${stderr}\nCommand timed out after ${timeoutSeconds}s`,
          maxResultSize,
        ),
        exit_code: 124,
      };
    }

    return {
      stdout: truncateResult(stdout, maxResultSize),
      stderr: truncateResult(stderr, maxResultSize),
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
