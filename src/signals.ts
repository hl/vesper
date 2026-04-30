import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SignalConfig } from "./config.js";
import { VesperError } from "./errors.js";
import { isContained, resolveReal } from "./permissions.js";

function resolveSignalPath(cwd: string, name: string): string {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  const resolved = resolve(realCwd, name);
  // Lexical containment check
  if (!isContained(resolved, realCwd)) {
    throw new VesperError(`Signal file path "${name}" resolves outside cwd: ${resolved}`, 1);
  }
  // Symlink containment: resolve the existing portion (walking up ancestors
  // for paths that don't exist yet) and re-check against real cwd
  const real = resolveReal(name, realCwd);
  if (real !== null && !isContained(real, realCwd)) {
    throw new VesperError(`Signal file path "${name}" follows a symlink outside cwd`, 1);
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

export async function writeComplete(
  paths: SignalPaths,
  agent?: string,
  message?: string | null,
): Promise<void> {
  if (agent === undefined || message === undefined || message === null || message.length === 0) {
    await Bun.write(paths.complete, "");
    return;
  }

  const payload = {
    reason: "complete",
    agent,
    message,
    context: message,
  };
  await Bun.write(paths.complete, JSON.stringify(payload, null, 2));
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

export async function writeAgentNeedsApproval(
  paths: SignalPaths,
  agent: string,
  message?: string,
): Promise<void> {
  const payload = {
    reason: "agent_needs_approval",
    agent,
    message: message ?? "Agent requested approval",
    context: message ?? null,
  };
  await Bun.write(paths.needsApproval, JSON.stringify(payload, null, 2));
}

export async function writeFailed(
  paths: SignalPaths,
  agent: string,
  reason: "error" | "agent_failed",
  message: string,
  context?: string | null,
): Promise<void> {
  const payload = { reason, agent, message, context: context ?? null };
  await Bun.write(paths.failed, JSON.stringify(payload, null, 2));
}
