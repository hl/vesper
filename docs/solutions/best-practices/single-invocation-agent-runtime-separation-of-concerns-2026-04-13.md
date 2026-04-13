---
title: "Single-Invocation Agent Runtime: Separating Iteration from Execution"
date: 2026-04-13
category: best-practices
module: agent-runtime
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "An agent runtime is invoked by an external orchestrator that manages iteration"
  - "The runtime contains its own re-invocation loop duplicating orchestrator responsibilities"
  - "Watch-file-based completion tracking adds complexity without clear ownership boundaries"
  - "Building a composable agent runtime that should be a pure function of (config + prompt) to (signal file + exit)"
tags:
  - agent-runtime
  - separation-of-concerns
  - single-responsibility
  - orchestrator
  - brr-integration
  - iteration-loop
  - architectural-simplification
---

# Single-Invocation Agent Runtime: Separating Iteration from Execution

## Context

When building a multi-layer agent system -- an inner runtime (vesper) invoked as a subprocess by an outer orchestrator (brr) -- iteration control, progress detection, and completion checking were implemented in both layers. Vesper had a `while (iterationCount < MAX_ITERATIONS)` loop that created fresh API conversations each iteration, a `CompletionTracker` that monitored a watch file for line-count changes, and no-progress detection that wrote failure signals after stagnation. Brr, the Go orchestrator in `internal/engine/engine.go`, had its own iteration loop, signal file checking, fail-streak tracking, and progress detection. The two layers were doing the same job.

The iteration loop was designed in from the very beginning of vesper's development (session history). The initial spec called for "fresh API call per iteration -- context does not accumulate across iterations," and the scratchpad was chosen as the state-persistence mechanism across iterations. The iteration loop and scratchpad were treated as coupled features, but they are not -- the scratchpad persists state across *invocations* (orchestrator-owned), not iterations (runtime-owned).

The architectural intent was always `brr (orchestrator, loops + workflows) -> vesper (agent runtime, permission-gated execution)`, but the implementation did not enforce this separation until this refactor.

## Guidance

**An agent runtime should do exactly one thing per invocation: run a single conversation to completion and report its outcome. Iteration, retry, and progress-tracking belong exclusively to the orchestrator.**

The runtime's responsibility is:

1. Receive a prompt (stdin, args, whatever the contract is)
2. Run one API conversation -- the model calls tools in a loop until it stops
3. Write a signal file reporting the outcome (complete, needs-approval, failed)
4. Exit

The orchestrator's responsibility is:

1. Decide when to invoke the runtime
2. Read the signal file after the runtime exits
3. Track progress across invocations (fail streaks, stagnation, iteration caps)
4. Decide whether to re-invoke, escalate, or stop

**The key distinction: intra-conversation tool loops belong to the runtime; inter-conversation iteration loops belong to the orchestrator.**

## Why This Matters

**Following this pattern:**

- The runtime becomes simple and predictable -- one input, one conversation, one signal file, one exit. Easy to test, easy to reason about.
- The orchestrator has full visibility into the iteration history because each invocation is a discrete event it controls.
- Configuration is centralized -- retry policy, progress detection, and iteration caps live in one place (the orchestrator).
- The net effect in vesper was -633 lines removed, an entire module (`completion.ts`) and its tests deleted, and 4 agent YAMLs simplified.

**Not following this pattern:**

- Two competing control loops make the system's actual behavior an emergent property of their interaction rather than something either layer explicitly defines.
- Confusing multiplied iteration counts -- if brr allows 10 iterations and vesper internally runs 5 per invocation, you can get up to 50 API calls, and neither layer's config tells you that.
- Contradictory completion signals -- vesper's CompletionTracker might decide "no progress" while brr's fail-streak counter is still under threshold, or vice versa.
- Redundant configuration surface -- every agent YAML needed a `completion:` block, duplicating what the orchestrator already manages.
- Debugging "why did it stop?" requires understanding both loop termination conditions and how they compose.

## When to Apply

This guidance applies when:

- You have a subprocess-based architecture where an orchestrator invokes a runtime via exec/spawn
- The runtime and orchestrator communicate through signal files, exit codes, or other inter-process mechanisms
- You are tempted to add iteration, retry, or progress-tracking logic to the inner runtime "just in case" or "for standalone use"
- You notice configuration for the same concern (completion detection, max retries) appearing at multiple layers

It does **not** apply when:

- The runtime genuinely runs standalone with no orchestrator -- then it needs its own iteration loop
- The "inner loop" is the tool-call loop within a single API conversation (model calls tools until `stop_reason !== "tool_use"`) -- that belongs in the runtime, always

## Examples

**Before -- runtime with duplicated iteration loop (`agent.ts`):**

```typescript
const tracker = new CompletionTracker(config.completion.watch_file, ...);
let iterationCount = 0;

while (iterationCount < MAX_ITERATIONS) {
  iterationCount++;
  logger.iterationStart(iterationCount);

  // Fresh API conversation each iteration
  const messages = buildMessages(config, task);

  // Inner tool-call loop (this part is correct)
  while (response.stop_reason === "tool_use") {
    const toolResults = await executeTools(response, config);
    messages.push(...toolResults);
    response = await client.createMessage(messages);
  }

  // Completion check -- DUPLICATES orchestrator's job
  const status = tracker.check();
  if (status === "complete") { await writeComplete(cwd); return; }
  if (status === "no_progress") { await writeFailed(cwd, "no_progress"); return; }
}
```

**After -- single-shot runtime:**

```typescript
const messages = buildMessages(config, task);

// Tool-call loop -- runs until model stops requesting tools
while (response.stop_reason === "tool_use") {
  const toolResults = await executeTools(response, config);
  messages.push(...toolResults);
  response = await client.createMessage(messages);
}

await writeComplete(cwd);
```

**Before -- agent YAML with completion config:**

```yaml
completion:
  watch_file: todos.md
  no_progress_limit: 3

signals:
  complete: .vesper-complete
  needs_approval: .vesper-needs-approval
  failed: .vesper-failed
```

**After -- completion block removed, signals unchanged:**

```yaml
signals:
  complete: .vesper-complete
  needs_approval: .vesper-needs-approval
  failed: .vesper-failed
```

The `completion:` field is silently ignored if present in old YAML files, since `loadConfig` only validates fields it explicitly checks -- no migration required for existing configurations.

## Related

- [Signal File Context for Agent-Orchestrator Communication](../best-practices/signal-file-context-agent-runtime-2026-04-13.md) -- sibling: both touch the vesper-brr boundary from different angles
- [Structural Permission Enforcement in Agent Runtimes](../best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md) -- the scratchpad/fresh-context pattern that survives this refactor
- [Skill Injection in Agent Runtimes](../best-practices/skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md) -- skill injection pattern that survives but whose "iteration loop" framing was updated
- [Implementation plan](../../plans/2026-04-13-002-refactor-remove-iteration-loop-plan.md)
