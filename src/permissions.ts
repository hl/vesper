import { resolve, relative, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
import { minimatch } from "minimatch";

function isInsideCwd(resolvedPath: string, cwd: string): boolean {
  const normalizedCwd = cwd.endsWith(sep) ? cwd : cwd + sep;
  return resolvedPath === cwd || resolvedPath.startsWith(normalizedCwd);
}

/**
 * Resolve a path to its real filesystem location, following symlinks.
 * For existing paths, uses realpathSync directly.
 * For non-existent paths (write targets), canonicalizes the parent
 * directory and appends the filename.
 * Returns null if the path cannot be resolved (e.g., parent doesn't exist).
 */
function resolveReal(inputPath: string, cwd: string): string | null {
  const lexical = resolve(cwd, inputPath);
  try {
    return realpathSync(lexical);
  } catch {
    // Path doesn't exist — canonicalize the parent for write targets
    try {
      const parent = realpathSync(dirname(lexical));
      return resolve(parent, basename(lexical));
    } catch {
      // Parent doesn't exist either — deny
      return null;
    }
  }
}

export function checkPathPermission(
  inputPath: string,
  cwd: string,
  allowList: string[],
): boolean {
  // First: lexical check to catch obvious escapes cheaply
  const lexical = resolve(cwd, inputPath);
  if (!isInsideCwd(lexical, cwd)) {
    return false;
  }

  // Second: resolve symlinks and re-check against real cwd
  const realCwd = realpathSync(cwd);
  const real = resolveReal(inputPath, cwd);
  if (real === null || !isInsideCwd(real, realCwd)) {
    return false;
  }

  const rel = relative(realCwd, real);
  // When the path resolves to cwd itself (e.g., list_files(".")),
  // relative() returns "". Match against both "" and "." since globs
  // like "**" match "." but not the empty string.
  if (rel === "") {
    return allowList.some(
      (pattern) => minimatch(".", pattern) || minimatch("", pattern),
    );
  }
  return allowList.some((pattern) => minimatch(rel, pattern));
}

export function checkCommandPermission(
  command: string,
  args: string[],
  allowList: string[],
): boolean {
  for (const entry of allowList) {
    const parts = entry.split(" ");
    if (parts.length === 1) {
      if (command === parts[0]) return true;
    } else {
      if (command === parts[0] && args.length > 0 && args[0] === parts[1]) {
        return true;
      }
    }
  }
  return false;
}

export function logDeniedCall(toolName: string, target: string): void {
  const sanitized = target.replace(/[\r\n]/g, "\\n");
  process.stderr.write(`[vesper] denied: ${toolName}(${sanitized})\n`);
}
