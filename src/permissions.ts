import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

/** Check if an absolute path is inside a container directory. */
export function isContained(realPath: string, realContainer: string): boolean {
  const normalized = realContainer.endsWith(sep) ? realContainer : realContainer + sep;
  return realPath === realContainer || realPath.startsWith(normalized);
}

/**
 * Resolve a path to its real filesystem location, following symlinks.
 * For existing paths, uses realpathSync directly.
 * For non-existent paths (write targets), walks up to the nearest existing
 * ancestor, resolves it, then reconstructs the remaining segments.
 * Returns null if no existing ancestor can be found.
 */
export function resolveReal(inputPath: string, cwd: string): string | null {
  const lexical = resolve(cwd, inputPath);
  try {
    return realpathSync(lexical);
  } catch {
    // Path doesn't exist — walk up to find the nearest existing ancestor,
    // resolve it, then reconstruct the remaining segments.
    // This supports writes to new nested directories (e.g., new-dir/sub/file.txt)
    // where writeFile will create intermediates via mkdir -p.
    const segments: string[] = [];
    let current = lexical;
    while (true) {
      segments.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing ancestor
        return null;
      }
      try {
        const realParent = realpathSync(parent);
        return resolve(realParent, ...segments);
      } catch {
        current = parent;
      }
    }
  }
}

export function checkPathPermission(inputPath: string, cwd: string, allowList: string[]): boolean {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return false;
  }

  // First: lexical check to catch obvious escapes cheaply
  const lexical = resolve(realCwd, inputPath);
  if (!isContained(lexical, realCwd)) {
    return false;
  }

  // Second: resolve symlinks and re-check against real cwd
  const real = resolveReal(inputPath, realCwd);
  if (real === null || !isContained(real, realCwd)) {
    return false;
  }

  const rel = relative(realCwd, real);
  return allowList.some((pattern) => minimatch(rel, pattern));
}

export function checkCommandPermission(
  command: string,
  args: string[],
  allowList: string[],
): boolean {
  for (const entry of allowList) {
    const parts = entry.trim().split(/\s+/);
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
