import { join } from "node:path";

export interface SignalPaths {
  complete: string;
  needsApproval: string;
  failed: string;
}

export function getSignalPaths(cwd: string): SignalPaths {
  const complete = process.env.VESPER_SIGNAL_COMPLETE ?? ".vesper-complete";
  const needsApproval = process.env.VESPER_SIGNAL_NEEDS_APPROVAL ?? ".vesper-needs-approval";
  const failed = process.env.VESPER_SIGNAL_FAILED ?? ".vesper-failed";

  return {
    complete: join(cwd, complete),
    needsApproval: join(cwd, needsApproval),
    failed: join(cwd, failed),
  };
}

export async function writeComplete(cwd: string): Promise<void> {
  const paths = getSignalPaths(cwd);
  await Bun.write(paths.complete, "");
}

export async function writeNeedsApproval(
  cwd: string,
  agent: string,
  budget: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const paths = getSignalPaths(cwd);
  const payload = {
    reason: "token_budget_exceeded",
    agent,
    message: `Token budget of ${budget} exhausted after ${inputTokens} input and ${outputTokens} output tokens.`,
  };
  await Bun.write(paths.needsApproval, JSON.stringify(payload, null, 2));
}

export async function writeFailed(
  cwd: string,
  agent: string,
  reason: "no_progress" | "error",
  message: string,
): Promise<void> {
  const paths = getSignalPaths(cwd);
  const payload = { reason, agent, message };
  await Bun.write(paths.failed, JSON.stringify(payload, null, 2));
}
