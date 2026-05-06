---
title: Bounded Parallel Sub-Agent Scheduling in Agent Runtimes
date: 2026-05-06
track: knowledge
category: best-practices
tags: [agent-runtime, subagents, parallelism, scheduler, token-budget, permissions]
spec: docs/specs/parallel-same-turn-subagents.md
module: src/agent.ts
---

# Bounded Parallel Sub-Agent Scheduling in Agent Runtimes

## Context

Review-style orchestrators often ask a parent agent to fan out several independent child agents
from one model response. Running those child calls sequentially preserves safety but makes latency
the sum of every child. Vesper's solution keeps the existing single-invocation tool loop and adds
opt-in scheduling only for consecutive same-turn `subagent` and `Task` calls.

This extends the structural permission model instead of replacing it. The parent still grants child
agent names through `tools.subagents`; the new top-level `subagents` config only controls dispatch
behavior.

## Guidance

Use a bounded segment scheduler inside the parent tool loop:

- Keep existing behavior as the default with `subagents.parallel_same_turn: false`.
- Group only consecutive same-turn `subagent` / `Task` tool uses into scheduling segments.
- Execute built-in tools, MCP tools, and `signal` sequentially.
- Preserve model-facing result order by storing each result by original tool-use index and appending
  after execution in the original order.
- Treat a child as parallel-eligible only after permission checks, depth checks, and child config
  loading.
- Default writable or command-capable child agents to serialized execution unless the child config
  explicitly sets `parallel_safe: true`.
- Use a fresh message client per concurrent child through `clientFactory` so provider adapters are
  not assumed to be concurrency-safe.
- Track child token usage separately from the parent's own token budget and expose it in child
  result JSON and structured logs.

The concrete implementation is in `src/agent.ts`: `executeSubagentTool`,
`isParallelEligibleSubagent`, `runParallelSubagentSegment`, and the parent tool-result assembly.

## Why This Matters

The main risk in parallel agent execution is not starting work concurrently; it is losing the
runtime invariants that made sequential execution safe. This pattern keeps those invariants:

- Parent budgets still account for the parent conversation and returned child result text.
- Aggregate child usage can be capped with `subagents.aggregate_token_budget`.
- Permission-denied, depth-denied, failed, and successful children all produce exactly one result
  for their original `tool_use_id`.
- Unsafe children create an observable barrier: finish earlier parallel siblings, run the unsafe
  child alone, then continue with the next safe segment.

## When to Apply

Apply this pattern when:

- A model can emit multiple independent child-agent tool calls in one turn.
- Child work is read-only or explicitly marked as safe to overlap.
- The runtime needs deterministic tool-result ordering even when child completions race.
- API cost needs an aggregate child budget in addition to per-agent budgets.

Avoid it when tool calls mutate shared state and the child configs cannot declare disjoint or
otherwise safe write surfaces.

## Examples

Parent config:

```yaml
subagents:
  parallel_same_turn: true
  max_concurrency: 4
  aggregate_token_budget: 200000

tools:
  subagents: ["lens-bugs", "lens-tests", "lens-security"]
```

Writable child opt-in:

```yaml
parallel_safe: true
tools:
  write: ["reports/review/**"]
  commands: []
```

Mixed scheduling rule:

```text
safe A, unsafe B, safe C
  -> run A
  -> wait
  -> run B alone
  -> run C
```

## Related

- `docs/specs/parallel-same-turn-subagents.md`
- `src/agent.ts`
- `tests/agent.test.ts`
- `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`
- `docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`
