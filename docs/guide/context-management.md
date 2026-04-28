# Context Management

Vesper uses a three-layer system to keep conversations within the model's context window: a pre-call guard, tool result pruning, and conversation compaction.

## Configuration

```yaml
context_management:
  pruning: "off"              # "off" | "always" | "threshold"
  pruning_threshold: 0.7      # Used with "threshold" mode
  compaction_enabled: false
  compaction_threshold: 0.8
  compaction_model: null       # Defaults to agent's model
```

## Token Estimation

Vesper estimates token usage with a `ceil(characters / 3)` heuristic. This is fast but approximate — the system logs a `context_estimation_drift` event when the estimate diverges more than 30% from actual API-reported usage.

## Layer 1: Pre-Call Guard

Before each API call, Vesper estimates total context size. If it exceeds 95% of the model's context window, the call fails with a `context_guard_triggered` error and writes the `failed` signal.

If compaction is enabled, it fires first (see Layer 3). The guard only fails if compaction doesn't reduce the context enough.

## Layer 2: Tool Result Pruning

Pruning replaces old tool results with compact stubs that preserve the outcome without the full content.

### Modes

**`off`** — No pruning. Tool results accumulate until they hit the context guard.

**`always`** — After every API turn, replace all previous tool results with stubs.

**`threshold`** — Prune only when estimated tokens exceed `pruning_threshold * context_window`.

### What Stubs Look Like

A stub preserves the tool name, target, outcome, and key metadata:

```
[read_file: src/agent.ts — 150 lines, 4.2KB]
[list_files: src — 42 entries]
[write_file: src/config.ts — ok]
[patch_file: src/foo.ts — ok, 3 hunks]
[run_command: bun test — exit 0, 1KB stdout]
[read_file: missing.ts — error: not_found]
```

### Protections

- The initial task message (messages[0]) is never pruned
- The current turn's tool results are never pruned — pruning runs before new results are appended

## Layer 3: Conversation Compaction

Compaction summarizes the entire conversation into a single message via an extra API call.

### When It Fires

When `compaction_enabled: true` and estimated context exceeds `compaction_threshold * context_window`.

Compaction runs at most once per agent invocation. If it fires and the result is still too large, the pre-call guard catches it.

### What It Produces

The compacted conversation is a single user message with two sections:

```
[Original Task]
<the original task prompt>

[Conversation Summary]
<structured summary>
```

The summary covers: what was accomplished, files modified, commands run, current state, and remaining work.

### Scratchpad Integration

If a scratchpad is configured, compaction writes the summary to the scratchpad file automatically. This preserves state for the next invocation.

### Failure Modes

- If compaction is truncated (`stop_reason: "max_tokens"`), Vesper writes the `failed` signal and exits
- If compaction returns an empty response, same behavior
- Compaction tokens count against the agent's `token_budget`

## Recommended Settings

**Short tasks (under 50K tokens):**
```yaml
# No context management needed — skip it
```

**Medium tasks (50K–150K tokens):**
```yaml
context_management:
  pruning: threshold
  pruning_threshold: 0.7
```

**Long tasks with state carry-forward:**
```yaml
context_management:
  pruning: threshold
  pruning_threshold: 0.7
  compaction_enabled: true
  compaction_threshold: 0.8
scratchpad: ".vesper/.scratchpad-agent.md"
```

## Observability

Enable `log_events: true` to see context management events:

| Event | Meaning |
|-------|---------|
| `context_guard_triggered` | Estimated tokens exceed 95% of window |
| `context_pruned` | Tool results replaced with stubs |
| `context_compacted` | Conversation summarized |
| `context_estimation_drift` | Estimate diverged >30% from actual |
| `context_window_unknown` | Model not in lookup table, using 200K fallback |
