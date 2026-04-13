---
title: "feat: Add signal tool for agent-controlled exit signals"
type: feat
status: active
date: 2026-04-13
origin: docs/brainstorms/2026-04-13-signal-tool-requirements.md
---

# feat: Add signal tool for agent-controlled exit signals

## Overview

Give agents runtime control over which signal file vesper writes on exit. Today, every normal exit writes `.vesper-complete`, which tells brr to stop. Agents that process work incrementally need to exit without writing a signal (so brr continues) and signal completion only when the work queue is empty.

Two changes: a `default_signal` config field that controls what happens when the agent doesn't explicitly signal, and a `signal` tool the agent can call to override the default.

## Problem Frame

Vesper's exit path unconditionally writes the complete signal (`agent.ts:499`). The three exit paths — normal completion, budget exhaustion, API error — all write a signal file, and brr stops on any of them. An agent doing one unit of work per invocation has no way to say "continue the loop." The signal tool lets the agent decide at runtime whether the loop should continue or stop. (See origin: `docs/brainstorms/2026-04-13-signal-tool-requirements.md`)

## Requirements Trace

- R1. Signal tool with `type` (`complete`, `needs_approval`, `failed`). `needs_approval` and `failed` accept optional `message`. `complete` does not.
- R2. Vesper records the signal but does not write immediately. Conversation continues.
- R3. After conversation ends, last signal call wins.
- R4. `default_signal` config: `"complete"` (default) or `"none"`.
- R5. `default_signal: complete` + no signal call → writes complete (backward-compatible).
- R6. `default_signal: none` + no signal call → no file written, brr continues.
- R7. API errors / max_tokens → `failed` unconditionally.
- R8. Budget exhaustion → `needs_approval` unconditionally.
- R9. Agent-initiated `needs_approval`/`failed` use distinct reasons: `"agent_needs_approval"`, `"agent_failed"`. Message appears in `context` field.
- R10. Agent-initiated `complete` writes empty file.
- R11. Signal tool always available, not subject to permission filtering.
- R12. Vesper-level failures take precedence over any recorded agent signal.

## Scope Boundaries

- brr is not modified. It already treats "no signal file" as "continue."
- Prompt changes to existing agents are out of scope.
- The signal tool does not terminate the conversation.
- No new permission category — the signal tool bypasses permissions entirely.

## Context & Research

### Relevant Code and Patterns

- `TOOL_DEFINITIONS` (`src/agent.ts:24-112`) — module-level array of 6 tools with `strict: true` schemas
- `filterTools` (`src/agent.ts:190-209`) — filters tools by permission, applies `cache_control` to last tool
- `executeTool` (`src/agent.ts:263-335`) — dispatches via `getPermissionList` then `switch` on tool name
- `getPermissionList` (`src/agent.ts:222-243`) — returns `null` for unknown tools (triggers denial)
- Tool loop (`src/agent.ts:464-488`) — sequential `for...of` over `tool_use` blocks, calls `executeTool`
- Exit path (`src/agent.ts:498-501`) — unconditional `writeComplete`
- Config optional field pattern: extract with `??`, type-check, include in return object (e.g., `scratchpad` at `src/config.ts:135-138`)
- `writeFailed` (`src/signals.ts:63-72`) — reason typed as literal `"error"`
- `writeNeedsApproval` (`src/signals.ts:46-61`) — hardcoded `reason: "token_budget_exceeded"`
- `makeConfig` test helper (`tests/agent.test.ts:13-40`) — spread-based override pattern
- `makeToolUseBlock` factory (`tests/agent.test.ts`) — creates tool_use blocks for stub responses

### Institutional Learnings

- **Structural permission enforcement** (`docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`): Tools are filtered from the API call entirely if the agent has no permissions. The signal tool is a deliberate, justified departure — it has no I/O and no safety surface. Document as an exception.
- **Single-invocation contract** (`docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`): The runtime is a pure function: `(config + prompt) → (signal file + exit)`. The signal tool preserves this — it changes *which* signal file (or no file), not the single-invocation model.
- **Signal file context** (`docs/solutions/best-practices/signal-file-context-agent-runtime-2026-04-13.md`): Signal payloads include a `context` field with the agent's last text output. Agent-initiated signals use their own `context` from the tool call message, not `extractLastText`.

## Key Technical Decisions

- **Intercept before `executeTool`**: The signal tool mutates `runAgent`-local state, not the filesystem. Handle it in the tool loop before calling `executeTool`, avoiding threading state through the dispatch path. (See origin: Key Decisions — "Tool, not convention")
- **Separate constant, append after filter**: Define `SIGNAL_TOOL_DEFINITION` as a standalone constant outside `TOOL_DEFINITIONS`. In `filterTools`, append it unconditionally after permission filtering, then apply `cache_control` to the new last element. This keeps the permission system untouched.
- **Widen signal writers, don't duplicate**: Expand `writeFailed`'s reason union and add a new `writeAgentNeedsApproval` function rather than overloading `writeNeedsApproval` (which takes budget-specific parameters).
- **`default_signal` as union type**: `"complete" | "none"` in `AgentConfig`, not a bare string. Validated at config load time.

## Open Questions

### Resolved During Planning

- **Where does the recorded signal live?** A mutable local variable in `runAgent`: `let recordedSignal: RecordedSignal | null = null`. Simple, no threading needed.
- **How does the signal tool bypass `filterTools`?** It's defined as a separate constant and appended unconditionally inside `filterTools` after permission filtering. The `toolPermissionMap` never references it.
- **What happens to `cache_control`?** The signal tool is always last in the tools array, so it naturally receives the marker. Existing prompt caching behavior is preserved.
- **How does the tool loop handle `signal`?** Check `toolUse.name === "signal"` before calling `executeTool`. Record the signal, push a success result, continue the loop.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
// In runAgent, before the tool loop:
let recordedSignal = null

// Inside tool execution loop (lines 469-488):
for each toolUse in toolUseBlocks:
  if toolUse.name === "signal":
    recordedSignal = { type, message } from toolUse.input
    push { tool_use_id, content: JSON.stringify({ ok: true }) }
  else:
    result = executeTool(...)
    push { tool_use_id, content: result }

// After loop breaks (replacing lines 498-501):
if recordedSignal?.type === "complete":
  writeComplete(signalPaths)
else if recordedSignal?.type === "needs_approval":
  writeAgentNeedsApproval(signalPaths, agentName, recordedSignal.message)
else if recordedSignal?.type === "failed":
  writeFailed(signalPaths, agentName, "agent_failed", recordedSignal.message)
else if config.default_signal === "complete":
  writeComplete(signalPaths)
// else: default_signal is "none", no file written → brr continues
```

Error and budget paths (lines 419-456) remain unchanged — they write their signals and return before reaching the exit path, so the recorded signal is naturally discarded (R12).

## Implementation Units

- [ ] **Unit 1: Config — add `default_signal` field**

  **Goal:** Add `default_signal` to `AgentConfig` and validate it during config loading.

  **Requirements:** R4

  **Dependencies:** None

  **Files:**
  - Modify: `src/config.ts`
  - Modify: `tests/agent.test.ts` (`makeConfig` helper — add `default_signal` with default `"complete"`)
  - Test: `tests/config.test.ts`

  **Approach:**
  - Add `default_signal: "complete" | "none"` to `AgentConfig` interface
  - In `loadConfig`, extract with `parsed.default_signal ?? "complete"`, validate against `["complete", "none"]`, throw `VesperError` for invalid values
  - Follow the `scratchpad` field pattern for extraction and validation
  - Update the `makeConfig` test helper in `tests/agent.test.ts` to include `default_signal: "complete"` (required for TypeScript compilation — all subsequent units depend on this helper)

  **Patterns to follow:**
  - `scratchpad` field handling in `src/config.ts:135-138`
  - Config validation tests in `tests/config.test.ts` (valid values, invalid values, missing = default)

  **Test scenarios:**
  - Happy path: `default_signal: "complete"` parses correctly
  - Happy path: `default_signal: "none"` parses correctly
  - Happy path: missing `default_signal` defaults to `"complete"`
  - Error path: `default_signal: "invalid"` throws VesperError
  - Error path: `default_signal: 123` (wrong type) throws VesperError

  **Verification:**
  - `bun test tests/config.test.ts` passes
  - `bunx tsc --noEmit` passes with the new union type

- [ ] **Unit 2: Signals — agent-initiated write functions**

  **Goal:** Add write functions for agent-initiated `needs_approval` and `failed` signals with distinct reason values.

  **Requirements:** R9, R10

  **Dependencies:** None

  **Files:**
  - Modify: `src/signals.ts`
  - Test: `tests/signals.test.ts`

  **Approach:**
  - Add `writeAgentNeedsApproval(paths, agent, message?)` — writes JSON with `reason: "agent_needs_approval"`, `agent`, `message` (from tool call), `context` (the message or null)
  - Widen `writeFailed`'s `reason` parameter type from `"error"` to `"error" | "agent_failed"`
  - Agent-initiated `failed` reuses `writeFailed` with reason `"agent_failed"` and message as both `message` and `context`

  **Patterns to follow:**
  - `writeNeedsApproval` in `src/signals.ts:46-61` for payload shape
  - `writeFailed` in `src/signals.ts:63-72` for the existing pattern
  - Signal write tests in `tests/signals.test.ts`

  **Test scenarios:**
  - Happy path: `writeAgentNeedsApproval` with message writes JSON with `reason: "agent_needs_approval"` and `context` containing the message
  - Happy path: `writeAgentNeedsApproval` without message writes JSON with `context: null`
  - Happy path: `writeFailed` with `reason: "agent_failed"` writes JSON with correct reason
  - Happy path: existing `writeFailed` with `reason: "error"` still works (no regression)
  - Edge case: `writeAgentNeedsApproval` with empty string message — treated as provided (not null)

  **Verification:**
  - `bun test tests/signals.test.ts` passes
  - `bunx tsc --noEmit` passes with widened type

- [ ] **Unit 3: Agent — signal tool definition and injection**

  **Goal:** Define the signal tool schema and inject it unconditionally into the tool list.

  **Requirements:** R1, R11

  **Dependencies:** None

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - Define `SIGNAL_TOOL_DEFINITION` as a separate `Anthropic.Tool` constant after `TOOL_DEFINITIONS`. Schema: `type` as enum `["complete", "needs_approval", "failed"]` (required). `message` as optional string — but use a conditional schema or keep it simple: accept `message` as optional for all types, ignore it for `complete` at the handler level. Given `strict: true` requires `additionalProperties: false`, and the API doesn't support conditional schemas, the simplest approach is: `type` (required enum) + `message` (optional string). The handler ignores `message` when type is `complete`.
  - In `filterTools`, after filtering permission-gated tools and before applying `cache_control`, append `SIGNAL_TOOL_DEFINITION`. Then apply `cache_control` to the last element (which is now the signal tool).
  - The signal tool is always present, so `filterTools` never returns an empty array. Remove the `tools: undefined` conditional at line 363 in `runAgent` — it is now dead code. Note: this means all agents now enter "tool use mode" with at least the signal tool, even agents with zero permission-gated tools. This is the intended behavior.

  **Patterns to follow:**
  - `TOOL_DEFINITIONS` entries for schema format (`strict: true`, `additionalProperties: false`, `type: "object" as const`)
  - `filterTools` for cache_control application

  **Test scenarios:**
  - Happy path: `filterTools` returns the signal tool even when config has no permissions (empty `tools.read/write/delete/commands`)
  - Happy path: signal tool is always the last tool in the returned array
  - Happy path: `cache_control` is on the signal tool (last element)
  - Happy path: permission-gated tools still filtered correctly alongside signal tool
  - Integration: `runAgent` sends signal tool to the API (verify via `stubClient` params capture)

  **Verification:**
  - `bun test tests/agent.test.ts` passes
  - `bunx tsc --noEmit` passes

- [ ] **Unit 4: Agent — signal interception and exit logic**

  **Goal:** Handle signal tool calls in the conversation loop and use the recorded signal (or `default_signal`) to determine exit behavior.

  **Requirements:** R2, R3, R5, R6, R7, R8, R12

  **Dependencies:** Unit 1, Unit 2, Unit 3

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - Define a `RecordedSignal` type: `{ type: "complete" | "needs_approval" | "failed"; message?: string }`
  - Add `let recordedSignal: RecordedSignal | null = null` in `runAgent` before the loop
  - In the tool execution loop (lines 469-488), before calling `executeTool`, check `toolUse.name === "signal"`. If so: parse `type` and `message` from input, set `recordedSignal`, emit `logger.toolCall("signal", type, true, 0)` to preserve the JSONL event stream contract (every tool invocation is logged), push a `{ ok: true }` tool result, and `continue`
  - Replace exit path (lines 498-501) with signal resolution logic: check `recordedSignal` first, then fall back to `config.default_signal`
  - Error paths (lines 419-422) and budget path (lines 446-455) remain unchanged — they return before the exit path, so `recordedSignal` is naturally discarded (R12)
  - Log the signal file write with appropriate `logger.signalWrite` call (or skip when no file is written under `default_signal: none`)

  **Patterns to follow:**
  - Tool result construction at `src/agent.ts:483-487`
  - `extractLastText` for existing context extraction (not used here — agent provides its own context via message)
  - `logger.signalWrite` calls at existing signal write sites

  **Test scenarios:**
  - Happy path: agent calls `signal("complete")` → complete signal written
  - Happy path: agent calls `signal("needs_approval", "reason")` → needs_approval signal with `reason: "agent_needs_approval"` and context
  - Happy path: agent calls `signal("failed", "reason")` → failed signal with `reason: "agent_failed"` and context
  - Happy path: `default_signal: "complete"`, no signal call → complete signal written (backward-compatible)
  - Happy path: `default_signal: "none"`, no signal call → no signal file written
  - Happy path: agent calls `signal("complete")`, conversation continues with more tool calls after
  - Edge case: agent calls signal twice (last wins) — first `signal("complete")`, then `signal("needs_approval")` → needs_approval written
  - Edge case: agent calls `signal("complete")` then API error on next call → failed signal written (R12, vesper failure wins)
  - Edge case: agent calls `signal("complete")` then budget exceeded → needs_approval written (R12)
  - Edge case: `default_signal: "none"`, agent calls `signal("complete")` → complete signal written (explicit signal overrides default)
  - Error path: signal tool called with invalid type — API rejects before reaching vesper (strict schema), but handler should be defensive
  - Integration: `default_signal: "none"` agent completes without signal → exit code 0, no signal files exist in temp dir
  - Integration: agent with zero permission-gated tools (`read: [], write: [], delete: [], commands: []`) receives signal tool call and exits with correct signal — verifies the tool-use-mode behavioral change for previously tool-less agents

  **Verification:**
  - `bun test tests/agent.test.ts` passes
  - `make check` passes (all gates)
  - Signal files are verified by checking file existence and contents in temp dirs

## System-Wide Impact

- **Interaction graph:** `filterTools` now always returns at least one tool (the signal tool). The `tools: undefined` conditional in `runAgent` (line 363) is dead code and should be removed. All agents now enter tool-use mode, even those with zero permission-gated tools.
- **Error propagation:** Error and budget paths are unchanged. They write their signals and return before the new exit logic runs.
- **State lifecycle risks:** `recordedSignal` is a local variable — no persistence, no cleanup needed. If the process crashes between recording and writing, no signal file is written, which is the same as `default_signal: none` (brr continues). Acceptable.
- **API surface parity:** The signal tool is a new tool visible to all agents. Agents that don't use it are unaffected (backward-compatible default).
- **Unchanged invariants:** The six existing tools (`read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`) are unchanged. Permission filtering for those tools is unchanged. Signal file format is unchanged (JSON payload with `reason`, `agent`, `message`, `context`). The `complete` signal remains an empty file.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Signal tool changes `cache_control` placement — could break prompt caching for existing agents | Signal tool is always last; `cache_control` on last tool is the existing pattern. Verify in tests by checking the tools array sent to the API. |
| `strict: true` schema can't express "message required for some types but not others" | Accept `message` as optional for all types. Handler ignores it for `complete`. Simple and forward-compatible. |
| Agent calls signal in a multi-tool batch alongside other tools | Works correctly — signal is recorded, other tools execute normally, loop continues. Last signal call wins if signal appears multiple times in a batch. |
| All agents now enter tool-use mode (previously, zero-permission agents had `tools: undefined`) | Harmless — the signal tool is the only tool available, and agents with `default_signal: complete` behave identically. Agents with no tools were already non-functional for practical purposes. |
| brr might parse the `reason` field in signal files | brr checks for file existence only, not payload contents. New reason values (`"agent_needs_approval"`, `"agent_failed"`) do not affect brr behavior. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-13-signal-tool-requirements.md](docs/brainstorms/2026-04-13-signal-tool-requirements.md)
- Structural permission enforcement: `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`
- Single-invocation contract: `docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`
- Signal file context: `docs/solutions/best-practices/signal-file-context-agent-runtime-2026-04-13.md`
