---
title: "feat: Vesper v0.2 — observability, cost control, and safety"
type: feat
status: active
date: 2026-04-12
origin: docs/brainstorms/2026-04-12-vesper-v02-requirements.md
---

# feat: Vesper v0.2 — observability, cost control, and safety

## Overview

Add 7 features and fix 1 bug across the existing Vesper codebase. All changes modify existing files — no new source modules. The features address the highest-leverage gaps from structured ideation: cost/token efficiency (configurable model, prompt caching, tool filtering), permission transparency, observability, inter-iteration continuity, and command safety.

## Problem Frame

Vesper v0.1 is functional but operationally blind. Operators cannot observe agent behavior, cannot tune cost/quality per agent, and face silent failure modes (hung commands, truncated responses, wasted tokens on permission denials). (see origin: `docs/brainstorms/2026-04-12-vesper-v02-requirements.md`)

## Requirements Trace

- R1. Optional `model` field in agent YAML config
- R2. Prompt caching via `cache_control: { type: "ephemeral" }`
- R3. Filter tool definitions to match agent permissions
- R4. Optional `reveal_permissions` field for structured denial messages
- R5. Opaque denial remains the default when `reveal_permissions` is false
- R6. Optional `log_events` field enables JSONL event logging
- R7. Events: iteration_start, api_call, tool_call, completion_check, signal_write
- R8. Each log line includes run_id and ISO 8601 timestamp
- R9. Optional `scratchpad` field; runtime injects contents before task prompt
- R10. Scratchpad is read-only at runtime level
- R11. Optional `command_timeout` field (default 30s); kill + exit_code 124
- R12. `stop_reason: "max_tokens"` writes failed signal instead of silent completion

## Scope Boundaries

- No streaming API
- No retry logic for API errors
- No new tools
- No config inheritance
- No interactive mode
- `reveal_permissions` does not expose glob patterns in default (false) mode
- Scratchpad runtime only reads; never auto-writes

## Context & Research

### Relevant Code and Patterns

- `src/config.ts` — `AgentConfig` interface and `loadConfig` validator. New fields follow the existing pattern of optional keys with defaults.
- `src/agent.ts` — `runAgent` function, `TOOL_DEFINITIONS` array, `executeTool` function, `MessageClient` interface. All 7 features touch this file.
- `src/tools.ts` — `runCommand` function. Command timeout modifies only this function.
- `src/permissions.ts` — `checkPathPermission`, `checkCommandPermission`. Permission transparency extends the denial return path.
- `tests/agent.test.ts` — `makeConfig`, `makeMessage`, `makeToolUseBlock` helpers and stub `MessageClient`. All new tests follow this pattern.

### Institutional Learnings

No `docs/solutions/` exists. No prior learnings to draw from.

## Key Technical Decisions

- **Prompt caching: system prompt as content block array**: The Anthropic SDK accepts `system` as either a string or `TextBlockParam[]`. Switching to the array form with `cache_control` requires no behavioral change — just a different encoding of the same content. Tool definitions also support `cache_control` per-tool.
- **Tool filtering at the config level, not per-call**: Tools are filtered once when building the definitions array at agent start, not on every API call. This is simpler and means the tool list is stable for the entire run.
- **Event logger as a standalone module**: Rather than littering `agent.ts` with inline log calls, a small `logger.ts` module provides typed emit functions. This keeps the agent loop clean and makes log format changes localized.
- **Command timeout via AbortSignal**: Bun's `Bun.spawn` does not have a native timeout option. Use `setTimeout` + `proc.kill()` with cleanup. The try/catch in `runCommand` already handles spawn failures.
- **`max_tokens` truncation is a hard error**: The spec says no retry. Truncation writes a failed signal. If the operator needs more output tokens, that becomes a future `max_output_tokens` config field.

## Open Questions

### Resolved During Planning

- **JSONL event schema**: Use flat objects with `event` discriminator field. No nesting. Fields: `event`, `run_id`, `timestamp`, plus event-specific fields.
- **run_id format**: Use `crypto.randomUUID()` — simple, unique, no collision risk.
- **cache_control on tools**: Apply to the last tool definition in the array (Anthropic caching caches everything up to and including the block with `cache_control`).

### Deferred to Implementation

- Exact `AbortSignal` or timer pattern for command timeout in Bun
- Whether `Bun.spawn` proc.kill() requires SIGTERM vs SIGKILL

## Implementation Units

- [ ] **Unit 1: Extend AgentConfig with new fields**

  **Goal:** Add all new optional config fields and update the validator.

  **Requirements:** R1, R4, R6, R9, R11

  **Dependencies:** None

  **Files:**
  - Modify: `src/config.ts`
  - Test: `tests/config.test.ts`

  **Approach:**
  - Add to `AgentConfig`: `model?: string`, `reveal_permissions: boolean`, `log_events: boolean`, `command_timeout: number`, `scratchpad: string | null`
  - Apply defaults in `loadConfig`: `model` → undefined (use hardcoded default), `reveal_permissions` → false, `log_events` → false, `command_timeout` → 30, `scratchpad` → null
  - Validate types for each new field

  **Patterns to follow:**
  - Existing optional field handling in `loadConfig` (e.g., `log_denied_calls`, `no_progress_limit`)

  **Test scenarios:**
  - Happy path: config with all new fields set parses correctly
  - Happy path: config with no new fields gets correct defaults (model undefined, reveal_permissions false, log_events false, command_timeout 30, scratchpad null)
  - Edge case: command_timeout of 0 → should throw VesperError (must be positive)
  - Edge case: scratchpad as non-string → should throw VesperError
  - Edge case: model as non-string → should throw VesperError

  **Verification:**
  - Existing config tests still pass
  - New fields are available in `AgentConfig` type without `any` casts

- [ ] **Unit 2: Configurable model per agent**

  **Goal:** Use `config.model` instead of the hardcoded `MODEL` constant when making API calls.

  **Requirements:** R1

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - Keep `MODEL` constant as the default
  - In `runAgent`, resolve model: `const model = config.model ?? MODEL`
  - Pass `model` to `messagesClient.create`

  **Test scenarios:**
  - Happy path: when `config.model` is set, stub client receives that model in params
  - Happy path: when `config.model` is undefined, stub client receives the default model

  **Verification:**
  - Stub client's `create` call receives the configured model

- [ ] **Unit 3: Prompt caching**

  **Goal:** Enable Anthropic prompt caching on system prompt and tool definitions.

  **Requirements:** R2

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - Convert `system: systemPrompt` string to `system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]`
  - Add `cache_control: { type: "ephemeral" }` to the last tool definition in the filtered array
  - Verify the Anthropic SDK types accept this shape

  **Test scenarios:**
  - Happy path: stub client receives system as an array with cache_control, not a plain string
  - Happy path: last tool in the array has cache_control set

  **Verification:**
  - API call params include structured system prompt with cache_control

- [ ] **Unit 4: Filter tool definitions by permissions**

  **Goal:** Send only tools the agent can actually use, reducing context window waste and model confusion.

  **Requirements:** R3

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - Build a `filterTools(config: AgentConfig)` function that returns the subset of `TOOL_DEFINITIONS` where the corresponding allow-list is non-empty
  - Mapping: `read_file`/`list_files` → `tools.read`, `write_file`/`patch_file` → `tools.write`, `delete_file` → `tools.delete`, `run_command` → `tools.commands`
  - Call `filterTools` once at agent start, use the result for all API calls

  **Test scenarios:**
  - Happy path: reviewer config (delete: [], commands: []) → only read_file, list_files, write_file, patch_file sent
  - Happy path: all-permissive config → all 6 tools sent
  - Edge case: all empty lists → no tools sent (empty array)

  **Verification:**
  - Stub client receives only the expected tool names in params.tools

- [ ] **Unit 5: Permission transparency**

  **Goal:** Return structured denial context when `reveal_permissions` is true.

  **Requirements:** R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - In `executeTool`, when a denial occurs and `config.reveal_permissions` is true, return a richer JSON: `{ error: "permission_denied", tool: toolName, target: path_or_command, allowed_patterns: [...] }`
  - When `reveal_permissions` is false, return the current opaque error (no change)
  - The `allowed_patterns` come from the relevant `config.tools.*` array

  **Test scenarios:**
  - Happy path: reveal_permissions true + path denied → response includes tool, target, allowed_patterns
  - Happy path: reveal_permissions false + path denied → response is opaque `{ error: "permission_denied" }`
  - Happy path: reveal_permissions true + command denied → response includes command and allowed commands
  - Edge case: reveal_permissions true + unknown tool → response includes tool name but no patterns

  **Verification:**
  - JSON structure of denial messages matches spec for both modes

- [ ] **Unit 6: Structured event log**

  **Goal:** Add JSONL event logging to stderr, gated behind `log_events` config flag.

  **Requirements:** R6, R7, R8

  **Dependencies:** Unit 1

  **Files:**
  - Create: `src/logger.ts`
  - Modify: `src/agent.ts`
  - Test: `tests/logger.test.ts`

  **Approach:**
  - New `src/logger.ts` module: `Logger` class with `run_id` (UUID) and methods for each event type
  - Each method writes one JSONL line to stderr via `process.stderr.write`
  - `Logger` is constructed with `enabled: boolean` — when disabled, all methods are no-ops
  - In `agent.ts`, create logger at start of `runAgent`, call event methods at appropriate points in the loop

  **Patterns to follow:**
  - `logDeniedCall` in `src/permissions.ts` for stderr writing pattern

  **Test scenarios:**
  - Happy path: enabled logger emits valid JSONL for iteration_start, api_call, tool_call, completion_check, signal_write
  - Happy path: each line has run_id and ISO 8601 timestamp
  - Happy path: api_call event includes input_tokens, output_tokens, latency_ms
  - Happy path: tool_call event includes tool name, permitted/denied, duration_ms
  - Edge case: disabled logger emits nothing

  **Verification:**
  - Parse emitted JSONL lines, validate structure and required fields
  - Disabled logger produces zero output

- [ ] **Unit 7: Runtime-enforced scratchpad**

  **Goal:** Automatically inject scratchpad file contents into each iteration's user message.

  **Requirements:** R9, R10

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - At the top of each iteration, if `config.scratchpad` is set, read the file (relative to cwd)
  - If it exists and has content, prepend to the user message: `[Previous Context]\n{scratchpad_content}\n\n[Task]\n{taskPrompt}`
  - If it doesn't exist or is empty, use just `taskPrompt` as before
  - The runtime never writes to the scratchpad — only reads

  **Test scenarios:**
  - Happy path: scratchpad file exists with content → stub client receives message with "[Previous Context]" prefix
  - Happy path: scratchpad file doesn't exist → stub client receives plain taskPrompt
  - Happy path: scratchpad null in config → stub client receives plain taskPrompt
  - Edge case: scratchpad file is empty → stub client receives plain taskPrompt (no empty prefix block)

  **Verification:**
  - First user message in stub client params contains scratchpad content when configured

- [ ] **Unit 8: Command execution timeout**

  **Goal:** Kill commands that exceed the configured timeout.

  **Requirements:** R11

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/tools.ts`
  - Modify: `src/agent.ts` (pass timeout to runCommand)
  - Test: `tests/tools.test.ts`

  **Approach:**
  - Add `timeout` parameter to `runCommand(command, args, cwd, timeout)`
  - Start a timer after `Bun.spawn`. If timer fires before `proc.exited`, call `proc.kill()`, collect partial output, return exit_code 124
  - Clean up timer on normal completion
  - In `agent.ts`, pass `config.command_timeout` to `runCommand` calls

  **Test scenarios:**
  - Happy path: fast command completes within timeout → normal stdout/stderr/exit_code
  - Happy path: slow command exceeds timeout → killed, exit_code 124, stderr contains timeout info
  - Edge case: timeout of 1 second with `sleep 10` command → killed promptly

  **Verification:**
  - Slow command returns exit_code 124 within a reasonable margin of the timeout

- [ ] **Unit 9: Fix stop_reason max_tokens bug**

  **Goal:** Treat truncated responses as errors instead of silently completing the iteration.

  **Requirements:** R12

  **Dependencies:** None

  **Files:**
  - Modify: `src/agent.ts`
  - Test: `tests/agent.test.ts`

  **Approach:**
  - After the budget check, before the `!== "tool_use"` break, check for `stop_reason === "max_tokens"`
  - If detected, write failed signal with reason "error" and message about response truncation, return exitCode 1
  - `end_turn` and other stop reasons continue current behavior

  **Test scenarios:**
  - Happy path: stop_reason "end_turn" → iteration completes normally
  - Error path: stop_reason "max_tokens" → writes failed signal with "error" reason, message mentions truncation, exit 1
  - Happy path: stop_reason "tool_use" → continues tool loop (existing behavior)

  **Verification:**
  - Stub client returning max_tokens stop_reason triggers failed signal with correct content

- [ ] **Unit 10: Update built-in agent configs**

  **Goal:** Demonstrate new v0.2 fields in the reference agent configs.

  **Requirements:** Success criteria

  **Dependencies:** Units 1-9

  **Files:**
  - Modify: `.vesper/planner.yml`
  - Modify: `.vesper/builder.yml`
  - Modify: `.vesper/reviewer.yml`
  - Modify: `.vesper/planner.md`
  - Modify: `.vesper/builder.md`

  **Approach:**
  - Add `scratchpad` field to planner and builder configs (pointing to their existing scratchpad paths)
  - Remove scratchpad read/write instructions from planner.md and builder.md (runtime handles it now)
  - Keep scratchpad write instructions (agent still writes via write_file)
  - Optionally set different `model` values to demonstrate the feature
  - Add `command_timeout: 60` to builder (git commit can be slow with hooks)

  **Test expectation:** none — static config files validated by loading them

  **Verification:**
  - `echo "test" | ./vesper planner` still loads without config errors
  - `echo "test" | ./vesper builder` still loads without config errors
  - `echo "test" | ./vesper reviewer` still loads without config errors

## System-Wide Impact

- **Interaction graph:** All changes flow through `agent.ts` → API call. The logger observes but does not modify the flow. Tool filtering happens once at startup.
- **Error propagation:** `max_tokens` truncation now writes a failed signal (new error path). Command timeout adds a new structured error return (exit_code 124).
- **State lifecycle risks:** Prompt caching is stateless (SDK-managed). Scratchpad is read-only at the runtime level. Logger is append-only to stderr.
- **API surface parity:** The `executeTool` function and `runCommand` gain new parameters. `MessageClient` interface is unchanged. The tool definitions sent to the API may vary per agent (tool filtering).
- **Unchanged invariants:** Permission enforcement logic is unchanged — tool filtering is additive (hides tools) not reductive (never adds tools). Signal file contract is unchanged. Watch file completion model is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Prompt caching `cache_control` type may not be accepted by all Anthropic API plans | Feature is additive — if caching is unavailable, the API ignores the field |
| Command timeout `proc.kill()` may leave zombie processes on some platforms | Use SIGKILL after a grace period if SIGTERM doesn't work |
| Tool filtering with all-empty lists sends no tools to the API | Verify the API accepts an empty tools array; if not, omit the parameter |
| Scratchpad injection increases context size each iteration | Scratchpad content is bounded by what the agent wrote in the prior iteration |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-12-vesper-v02-requirements.md`
- **Ideation source:** `docs/ideation/2026-04-12-open-ideation.md`
- Anthropic prompt caching docs: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Existing code: `src/agent.ts`, `src/config.ts`, `src/tools.ts`, `src/permissions.ts`
