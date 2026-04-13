import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { SignalConfig } from "./config.js";
import { VesperError } from "./errors.js";

function resolveSignalPath(cwd: string, name: string): string {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  const resolved = resolve(realCwd, name);
  const normalizedCwd = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
  if (resolved !== realCwd && !resolved.startsWith(normalizedCwd)) {
    throw new VesperError(`Signal file path "${name}" resolves outside cwd: ${resolved}`, 1);
  }
  return resolved;
}

export interface SignalPaths {
  complete: string;
  needsApproval: string;
  failed: string;
}

export function getSignalPaths(cwd: string, signals: SignalConfig): SignalPaths {
  return {
    complete: resolveSignalPath(cwd, signals.complete),
    needsApproval: resolveSignalPath(cwd, signals.needs_approval),
    failed: resolveSignalPath(cwd, signals.failed),
  };
}

export function checkStaleSignals(paths: SignalPaths): string | null {
  if (existsSync(paths.complete)) return paths.complete;
  if (existsSync(paths.needsApproval)) return paths.needsApproval;
  if (existsSync(paths.failed)) return paths.failed;
  return null;
}

export async function writeComplete(paths: SignalPaths): Promise<void> {
  await Bun.write(paths.complete, "");
}

export async function writeNeedsApproval(
  paths: SignalPaths,
  agent: string,
  budget: number,
  inputTokens: number,
  outputTokens: number,
  context: string | null,
): Promise<void> {
  const payload = {
    reason: "token_budget_exceeded",
    agent,
    message: `Token budget of ${budget} exhausted after ${inputTokens} input and ${outputTokens} output tokens.`,
    context,
  };
  await Bun.write(paths.needsApproval, JSON.stringify(payload, null, 2));
}

export async function writeFailed(
  paths: SignalPaths,
  agent: string,
  reason: "error",
  message: string,
  context?: string | null,
): Promise<void> {
  const payload = { reason, agent, message, context: context ?? null };
  await Bun.write(paths.failed, JSON.stringify(payload, null, 2));
}
