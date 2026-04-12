import { resolve, relative, sep } from "node:path";
import { minimatch } from "minimatch";

export function isInsideCwd(resolvedPath: string, cwd: string): boolean {
  const normalizedCwd = cwd.endsWith(sep) ? cwd : cwd + sep;
  return resolvedPath === cwd || resolvedPath.startsWith(normalizedCwd);
}

export function resolvePath(inputPath: string, cwd: string): string {
  return resolve(cwd, inputPath);
}

export function checkPathPermission(
  inputPath: string,
  cwd: string,
  allowList: string[],
): boolean {
  const resolved = resolvePath(inputPath, cwd);
  if (!isInsideCwd(resolved, cwd)) {
    return false;
  }
  const rel = relative(cwd, resolved);
  if (rel === "") {
    return allowList.some((pattern) => minimatch(".", pattern));
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
  process.stderr.write(`[vesper] denied: ${toolName}(${target})\n`);
}
