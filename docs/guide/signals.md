# Signals

Signal files are how Vesper communicates outcomes to the parent process. After each run, Vesper writes exactly one signal file.

## Signal Types

### `.vesper-complete`

Written when the agent finishes successfully. Empty file.

### `.vesper-needs-approval`

Written when the agent's token budget is exhausted or it explicitly requests approval. JSON contents:

```json
{
  "reason": "token_budget_exceeded",
  "agent": "builder",
  "message": "Token budget of 100000 exhausted after 80000 input and 20000 output tokens.",
  "context": null
}
```

The `context` field is `string | null` — it contains the scratchpad summary when available, or the agent's message for `agent_needs_approval`.

Possible `reason` values: `"token_budget_exceeded"`, `"agent_needs_approval"`.

### `.vesper-failed`

Written when the agent encounters an unrecoverable error. JSON contents:

```json
{
  "reason": "error",
  "agent": "builder",
  "message": "System prompt not found: system_prompts/builder.md",
  "context": null
}
```

Possible `reason` values: `"error"`, `"agent_failed"`.

## Custom Signal Paths

Override default paths in the agent config:

```yaml
signals:
  complete: ".vesper-complete"
  needs_approval: ".vesper-needs-approval"
  failed: ".vesper-failed"
```

Signal paths are relative to cwd and validated against symlink escapes.

## Stale Signal Check

Vesper refuses to start if any signal file already exists in the working directory. This prevents stale signals from a previous run being mistaken for current outcomes.

```
Error: Stale signal file found: .vesper-complete
```

The parent process (e.g., brr) is expected to clean up signal files before re-invoking the agent.

## Default Signal Behavior

When the agent's conversation ends naturally (model stops calling tools) without writing an explicit signal, the `default_signal` config controls what happens:

- **`"complete"`** (default) — writes the complete signal
- **`"none"`** — writes nothing

## Integration with Orchestrators

Vesper is designed for single-run invocations. The typical pattern with an orchestrator like brr:

```
1. Orchestrator cleans up signal files
2. Orchestrator pipes task to vesper via stdin
3. Vesper runs, writes a signal file, exits
4. Orchestrator reads the signal file
5. Based on signal:
   - complete → move to next task
   - needs_approval → pause for human review
   - failed → alert, retry, or escalate
6. Loop
```
