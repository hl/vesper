---
date: 2026-04-12
topic: vesper-v02
---

# Vesper v0.2 — Observability, Cost Control, and Safety

## Problem Frame

Vesper v0.1 is functional but operationally blind. Operators cannot observe agent behavior at runtime, cannot tune cost/quality per agent, and face silent failure modes (hung commands, truncated responses, wasted tokens on permission denials). This release addresses the highest-leverage gaps identified through structured ideation (37 candidates, 7 survivors).

## Requirements

**Cost and Token Efficiency**

- R1. Agent YAML config accepts an optional `model` field. When present, used as the model parameter in API calls. When absent, defaults to `claude-sonnet-4-5-20250514`.
- R2. System prompt is sent as a structured content block with `cache_control: { type: "ephemeral" }` to enable Anthropic prompt caching. Tool definitions also carry `cache_control`.
- R3. Before each API call, tool definitions are filtered to include only tools the agent has permission to use. A tool is included if its corresponding allow-list is non-empty (`read` for `read_file`/`list_files`, `write` for `write_file`/`patch_file`, `delete` for `delete_file`, `commands` for `run_command`).

**Permission Transparency**

- R4. Agent YAML config accepts an optional `reveal_permissions` field (default `false`). When `true`, permission denial responses include structured context: the tool name, the denied path or command, and the relevant allow-list patterns.
- R5. When `reveal_permissions` is `false`, denial responses remain the opaque `{ error: "permission_denied" }` (current behavior).

**Observability**

- R6. Agent YAML config accepts an optional `log_events` field (default `false`). When `true`, the runtime emits one JSONL line to stderr per event.
- R7. Events logged: `iteration_start` (iteration number), `api_call` (model, input_tokens, output_tokens, latency_ms), `tool_call` (tool name, path or command, permitted/denied, duration_ms), `completion_check` (status), `signal_write` (signal type, path).
- R8. Each log line includes a `run_id` (generated once at agent start) and an ISO 8601 `timestamp`.

**Inter-Iteration Continuity**

- R9. Agent YAML config accepts an optional `scratchpad` field (path relative to cwd, default `null`). When set, the runtime reads the scratchpad file at the start of each iteration and prepends its contents to the user message as a `[Previous Context]` block before the task prompt.
- R10. The scratchpad file is never written by the runtime. The agent writes it via normal `write_file` tool calls. The runtime only reads and injects.

**Command Safety**

- R11. Agent YAML config accepts an optional `command_timeout` field in seconds (default `30`). Commands that exceed the timeout are killed and the tool returns `{ stdout: <partial>, stderr: <partial>, exit_code: 124 }`.

**Bug Fix**

- R12. When `stop_reason` is `"max_tokens"` (response truncated), the iteration is NOT treated as complete. The runtime writes a failed signal with reason `"error"` and a message indicating the response was truncated. This replaces the current behavior where truncation is silently treated as `end_turn`.

## Success Criteria

- All existing 93 tests continue to pass (no regressions)
- Each new feature has dedicated test coverage
- `make check` passes (typecheck + lint + test)
- `make build` produces a single binary
- Built-in agent configs (`.vesper/`) updated to demonstrate new fields where appropriate
- Token savings from prompt caching are observable in the JSONL log (cache_read_input_tokens > 0 on subsequent calls)

## Scope Boundaries

- No streaming API — remains non-streaming
- No retry logic for API errors — out of scope for v0.2
- No new tools — tool set remains the same 6
- No config inheritance or `extends` — each YAML remains standalone
- No interactive mode — stdin-only
- `reveal_permissions` does not expose the actual glob patterns in the default (`false`) mode
- The scratchpad runtime feature only reads; it does not auto-extract or auto-write scratchpad content

## Key Decisions

- **Prompt caching uses `ephemeral` type**: This is the only cache type Anthropic supports for message-level caching. The 5-minute TTL means caching primarily benefits within-iteration tool loops (multiple API calls in rapid succession). Cross-iteration benefit depends on iteration speed.
- **Tool filtering is by allow-list non-emptiness, not per-path**: A tool is either fully available or fully hidden from the LLM. Per-path filtering (e.g., showing `write_file` but only for `src/**`) would require custom tool descriptions per agent and is deferred.
- **Scratchpad is read-only at the runtime level**: The agent writes it via `write_file` (which is already permission-gated). This avoids introducing a special-case write path outside the permission system.
- **Command timeout default is 30 seconds**: Matches common CI timeout conventions. Agents needing longer commands (builds, test suites) override in their YAML config.
- **`max_tokens` truncation is treated as an error, not a retry**: The spec says no retry logic. The truncation is surfaced to the operator via the failed signal. If the operator wants to increase `max_tokens`, they can do so in a future config field.

## Config Schema Additions

Summary of new optional fields in `<agent>.yml`:

```
model: "claude-sonnet-4-5-20250514"  # optional, default: current hardcoded model
reveal_permissions: false             # optional, default: false
log_events: false                     # optional, default: false
command_timeout: 30                   # optional, default: 30 (seconds)
scratchpad: null                      # optional, default: null (path relative to cwd)
```

## Outstanding Questions

### Resolve Before Planning

None — all product decisions resolved.

### Defer to Implementation

- Exact JSONL schema for each event type (field names, nesting)
- Whether `cache_control` should be applied to each tool definition individually or to the tools array as a whole
- How to generate `run_id` (UUID vs. timestamp-based)
