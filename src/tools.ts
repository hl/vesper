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

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

function capStringFieldsForJson<T extends Record<string, unknown>>(
  result: T,
  limit: number,
  fields: string[],
): T {
  if (jsonByteLength(result) <= limit) return result;

  const originals = fields
    .map((field) => ({ field, value: result[field] }))
    .filter((entry): entry is { field: string; value: string } => typeof entry.value === "string");

  if (originals.length === 0) return result;

  const originalBytes = originals.map((entry) => Buffer.byteLength(entry.value, "utf-8"));
  const totalOriginalBytes = originalBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (totalOriginalBytes === 0) return result;

  let low = 0;
  let high = totalOriginalBytes;
  let best: Record<string, unknown> = { ...result };
  for (const entry of originals) {
    best[entry.field] = "";
  }

  while (low <= high) {
    const budget = Math.floor((low + high) / 2);
    const candidate: Record<string, unknown> = { ...result };
    let allocated = 0;

    for (let i = 0; i < originals.length; i++) {
      const entry = originals[i];
      const allocation =
        i === originals.length - 1
          ? budget - allocated
          : Math.floor((budget * originalBytes[i]) / totalOriginalBytes);
      allocated += allocation;
      candidate[entry.field] = truncateResult(entry.value, Math.max(0, allocation));
    }

    if (jsonByteLength(candidate) <= limit) {
      best = candidate;
      low = budget + 1;
    } else {
      high = budget - 1;
    }
  }

  return best as T;
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
  return capStringFieldsForJson({ content }, maxResultSize, ["content"]);
}

export async function listFiles(
  resolvedPath: string,
  maxResultSize = 102400,
): Promise<
  { entries: string[]; truncated?: boolean; total_entries?: number } | { error: "not_found" }
> {
  try {
    const entries = await readdir(resolvedPath);
    const serialized = JSON.stringify({ entries });
    if (Buffer.byteLength(serialized, "utf-8") <= maxResultSize) {
      return { entries };
    }
    // Binary search for the maximum entry count that fits within the limit
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = {
        entries: entries.slice(0, mid),
        truncated: true,
        total_entries: entries.length,
      };
      if (jsonByteLength(candidate) <= maxResultSize) {
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

function truncateBufferResult(buffer: Buffer, totalBytes: number, limit: number): string {
  if (totalBytes <= limit) return buffer.toString("utf-8");

  const suffix = `\n[truncated: showing first ${limit} of ${totalBytes} bytes]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf-8");
  if (suffixBytes >= limit) {
    return buffer.subarray(0, limit).toString("utf-8");
  }

  const contentLimit = limit - suffixBytes;
  return `${buffer.subarray(0, contentLimit).toString("utf-8")}${suffix}`;
}

async function readStreamPrefix(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    const remaining = limit - storedBytes;
    if (remaining > 0) {
      const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(kept));
      storedBytes += kept.byteLength;
    }
  }

  return truncateBufferResult(Buffer.concat(chunks, storedBytes), totalBytes, limit);
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
      readStreamPrefix(proc.stdout, maxResultSize),
      readStreamPrefix(proc.stderr, maxResultSize),
    ]);

    await proc.exited;
    clearTimeout(timer);
    if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);

    if (timedOut) {
      return capStringFieldsForJson(
        {
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutSeconds}s`,
          exit_code: 124,
        },
        maxResultSize,
        ["stdout", "stderr"],
      );
    }

    return capStringFieldsForJson(
      {
        stdout: truncateResult(stdout, maxResultSize),
        stderr: truncateResult(stderr, maxResultSize),
        exit_code: proc.exitCode ?? 1,
      },
      maxResultSize,
      ["stdout", "stderr"],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return capStringFieldsForJson({ stdout: "", stderr: message, exit_code: 127 }, maxResultSize, [
      "stdout",
      "stderr",
    ]);
  }
}
