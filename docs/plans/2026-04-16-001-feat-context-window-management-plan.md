---
title: "feat: Add context window management (pruning, compaction, estimation)"
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/2026-04-15-context-management-requirements.md
---

# feat: Add context window management

## Overview

Add context window management to Vesper's conversation loop so agents can do more iterative work within a single invocation without hitting the context ceiling. Three layers of defense: (1) tool result pruning replaces old tool results with compact stubs, (2) conversation compaction summarizes history via an extra API call, (3) a pre-call guard fails gracefully before sending an oversized request. All opt-in with backward-compatible defaults.

## Problem Frame

Vesper's tool loop accumulates the full conversation (assistant responses + tool results) in a messages array that grows unbounded. Tool results — especially `read_file` — are the dominant source of context bloat. When messages exceed the model's context window, the API call fails with a generic "API error" signal. The existing `token_budget` is a cost guard, not a context guard. (See origin: `docs/brainstorms/2026-04-15-context-management-requirements.md`)

## Requirements Trace

- R1. Prune prior turn tool results with outcome-preserving stubs, keeping `tool_use_id` linkage
- R2. Configurable pruning strategy: `always` / `threshold` / `off` (default: `off`)
- R3. Never prune the most recent turn's tool results
- R4. Compaction triggers at configurable threshold, fires after pruning
- R5. Compaction produces system block + single user message (original task + summary)
- R6. Compaction model overridable via config
- R7. Compaction opt-in, disabled by default
- R8. Compaction tokens count against `token_budget`
- R9. Compaction API failure writes `failed` signal, no retry
- R10. Context estimation via chars/3 heuristic covering full API payload
- R11. Model window lookup via prefix matching on SDK model IDs
- R12. Pre-call guard at 95% of model window
- R13. Detect context-length API errors with specific `BadRequestError` matching
- R14. Post-compaction overflow writes summary to scratchpad + `needs_approval` signal
- R15. Backward compatible — default is `off` for everything

## Scope Boundaries

- No changes to the single-conversation-per-invocation model
- No changes to signal file paths or scratchpad read mechanism
- No streaming support
- No external tokenizer dependency

### Deferred to Separate Tasks

- Empirical validation of threshold defaults (70% pruning, 80% compaction) on representative workloads
- Measurement of prompt caching impact from pruning message mutations

## Context & Research

### Relevant Code and Patterns

- `src/agent.ts:462-584` — tool loop; messages grow at line 579-583 via array spread
- `src/agent.ts:579-583` — pruning insertion point: after tool results collected, before messages rebuilt
- `src/agent.ts:466-479` — API call + error catch block (R13 target)
- `src/config.ts:86-233` — `loadConfig()` with nested-object validation pattern (see `signals` at line 185)
- `src/config.ts:7-11` — `SignalConfig` interface pattern for nested config types
- `src/logger.ts` — `emit(event, data)` pattern for new events
- `src/signals.ts:84-93` — `writeFailed()` pattern with reason enum
- `src/signals.ts:70-82` — `writeAgentNeedsApproval()` pattern for R14
- `src/tools.ts:7-19` — `truncateResult()` with byte-based size computation; closest existing pattern to size estimation
- `src/agent.ts:36-155` — `TOOL_DEFINITIONS` and `SIGNAL_TOOL_DEFINITION`; tool definitions that go into API payload
- `src/agent.ts:240-258` — `filterTools()` returns the actual tools sent to API (use for estimation, not full set)
- `src/agent.ts:26-35` — `extractLastText()` for failure signal context (use in R9, R12, R13)

### Institutional Learnings

- **Single-invocation runtime** (`docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`): Context management operates within the single-conversation loop; cross-invocation state goes through signal files/scratchpad
- **Skill injection** (`docs/solutions/best-practices/skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md`): Skills are in the user message, not system prompt. System prompt is fixed cost; skills are part of messages and must be estimated + preserved in compaction
- **Structural permissions** (`docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`): Tool results already bounded by `max_tool_result_size` (default 100KB); use filtered tool definitions for estimation
- **Signal file content** (`docs/solutions/best-practices/signal-file-context-agent-runtime-2026-04-13.md`): Use `extractLastText` for context in all failure signals

## Key Technical Decisions

- **New `src/context.ts` module**: Context estimation, model window lookup, and pruning/compaction logic live in a dedicated module — keeps `agent.ts` focused on the conversation loop (see origin: Key Decisions)
- **Metadata map for stub generation**: A `Map<string, StubMetadata>` keyed by `tool_use_id` is built during tool execution. Each entry stores tool name, target path/command, outcome status, line count, and byte size. This is read during pruning to generate stubs without re-parsing the JSON result string
- **Compaction prompt**: Ask the model to summarize accomplishments, current state, key decisions, and remaining work. The summary is injected into a single user message alongside the original `userContent` with `[Original Task]` and `[Conversation Summary]` delimiters
- **Estimation includes fixed costs once**: System blocks and tool definitions are estimated once before the loop. Per-turn estimation adds only the messages delta. This avoids recomputing fixed costs every iteration (scope-guardian review finding)
- **Pruning at message rebuild**: Pruning happens at the message append step (`agent.ts:579-583`). When building the new messages array, prior user messages (tool results) have their content replaced with stubs. The current turn's results are appended verbatim
- **Failure mode precedence**: Compaction fails (R9) → write `failed`, exit. Compaction succeeds but still over threshold (R14) → write scratchpad + `needs_approval`, exit. Pre-call guard (R12) fires only when compaction is not enabled or has already been attempted

## Open Questions

### Resolved During Planning

- **Where does pruning happen?** At the message rebuild step (line 579-583). When constructing the new messages array, iterate prior user messages and replace tool_result content with stubs. This is cleaner than a separate mutation pass
- **How does stub generation get tool metadata?** A `Map<string, StubMetadata>` built during tool execution (lines 525-576). Each tool call records its name, target, and outcome before the result is stringified
- **What does the compaction prompt look like?** A system message instructing the model to produce a structured summary: what was accomplished, what files were modified, what commands were run and their outcomes, what remains to be done. Framed for agentic continuity, not human readability
- **Does pruning affect prompt caching?** `cache_control: ephemeral` is on system blocks and the last tool definition — both are static across turns. Pruning modifies message content in earlier user turns, which would invalidate per-message cache breakpoints if they existed, but Vesper doesn't set cache control on individual messages. No impact on current caching strategy
- **How does the pre-call guard interact with compaction?** The pre-call guard fires before every API call. If compaction is enabled and hasn't fired yet this cycle, the guard defers to compaction instead of failing. A `compactionAttempted` boolean tracks this

### Deferred to Implementation

- Exact wording of the compaction prompt — needs iteration based on actual output quality
- Whether `threshold` pruning mode's default of 70% is well-calibrated — the implementation should log estimated vs. actual token counts to enable future tuning
- Exact prefix-matching behavior for model IDs with dated suffixes (e.g., `claude-sonnet-4-5-20250929`)

## Implementation Units

- [ ] **Unit 1: Context estimation module**

**Goal:** Create `src/context.ts` with pure functions for token estimation and model window lookup.

**Requirements:** R10, R11

**Dependencies:** None

**Files:**
- Create: `src/context.ts`
- Test: `tests/context.test.ts`

**Approach:**
- `estimateTokens(text: string): number` — returns `Math.ceil(text.length / 3)`
- `estimatePayloadTokens(system: Anthropic.TextBlockParam[], tools: Anthropic.Tool[], messages: Anthropic.MessageParam[]): number` — serializes each component with `JSON.stringify`, sums `estimateTokens` on each. System + tools are fixed per invocation; the caller can cache these
- `getModelContextWindow(model: string): number` — prefix-match lookup against known models. Returns window size in tokens. Longest prefix wins
- `MODEL_CONTEXT_WINDOWS: Record<string, number>` — flat map: `{ "claude-sonnet-4": 200_000, "claude-opus-4": 200_000, "claude-haiku-4": 200_000, "claude-haiku-3": 200_000 }`
- When no prefix matches, return 200_000 (conservative default)
- Accept a `Logger` parameter in `getModelContextWindow` to emit `context_window_unknown` when falling back

**Patterns to follow:**
- Pure functions with named exports (consistent with `src/permissions.ts`, `src/tools.ts`)
- `Logger.emit` pattern for the unknown-model warning event

**Test scenarios:**
- Happy path: `estimateTokens("hello world")` returns `Math.ceil(11/3)` = 4
- Happy path: `getModelContextWindow("claude-sonnet-4-6")` matches `claude-sonnet-4` prefix, returns 200_000
- Happy path: `estimatePayloadTokens` with known system/tools/messages returns a positive number
- Edge case: `getModelContextWindow("unknown-model-v1")` returns 200_000 default and emits logger warning
- Edge case: `getModelContextWindow("claude-opus-4-5-20251101")` matches longest prefix `claude-opus-4`
- Edge case: `estimateTokens("")` returns 0
- Edge case: `estimatePayloadTokens` with empty messages array returns system + tools cost only

**Verification:**
- `bun test tests/context.test.ts` passes
- `make check` passes

---

- [ ] **Unit 2: Config extension for context management**

**Goal:** Add `context_management` config section to `AgentConfig` with all fields from R2, R4, R6.

**Requirements:** R2, R4, R6, R7, R15

**Dependencies:** None (parallel with Unit 1)

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/agent.test.ts` (update `makeConfig()` helper with `context_management` defaults)

**Approach:**
- Define `ContextManagementConfig` interface:
  ```
  pruning: "always" | "threshold" | "off"
  pruning_threshold: number (0-1, default 0.7)
  compaction_enabled: boolean (default false)
  compaction_threshold: number (0-1, default 0.8)
  compaction_model: string | null (default null — use agent's model)
  ```
- Add `context_management: ContextManagementConfig` to `AgentConfig`
- Parse `context_management` in `loadConfig()` following the `signals` nested-object pattern: check undefined/null → defaults, check `isPlainObject` → validate fields, else throw
- Validate: pruning must be one of the three values, thresholds must be 0 < x ≤ 1, compaction_model must be string or null
- Default everything to off/disabled so R15 is satisfied

**Patterns to follow:**
- `SignalConfig` interface + parsing pattern at `config.ts:185-207`
- `assertStringArray` style validation helpers

**Test scenarios:**
- Happy path: config with no `context_management` key loads with defaults (pruning `off`, compaction disabled)
- Happy path: config with `context_management: { pruning: "always" }` loads correctly, other fields default
- Happy path: full config with all fields set loads and validates
- Error path: `pruning: "invalid"` throws VesperError
- Error path: `pruning_threshold: 0` throws (must be positive)
- Error path: `pruning_threshold: 1.5` throws (must be ≤ 1)
- Error path: `compaction_model: 123` throws (must be string or null)
- Edge case: `context_management: null` treated as all-defaults

**Verification:**
- All existing config tests still pass (backward compat)
- `make check` passes

---

- [ ] **Unit 3: Context-length error detection (R13)**

**Goal:** Detect context-length API errors and write a specific `failed` signal instead of the generic "API error" message.

**Requirements:** R13

**Dependencies:** None (can ship independently)

**Files:**
- Modify: `src/agent.ts`
- Modify: `tests/agent.test.ts`

**Approach:**
- In the `catch` block at `agent.ts:474-479`, check if the error is an Anthropic SDK `BadRequestError` with status 400
- Check `err.type === "invalid_request_error"` and `err.message` containing context-related language (e.g., "prompt is too long", "maximum context length")
- If matched, write `failed` signal with reason `"error"` and a specific message like `"Context window overflow: ${err.message}"`
- If not matched, fall through to the existing generic handler
- Import `BadRequestError` from `@anthropic-ai/sdk` or use `Anthropic.BadRequestError`

**Patterns to follow:**
- Existing error catch at `agent.ts:474-479`
- `writeFailed()` pattern with `extractLastText()` for context

**Test scenarios:**
- Happy path: API throws BadRequestError with "prompt is too long" → writes failed signal with "Context window overflow" message
- Happy path: API throws generic Error → writes generic "API error" message (unchanged behavior)
- Edge case: API throws BadRequestError with unrelated message (e.g., "invalid model") → writes generic "API error" (not misclassified as context overflow)
- Integration: verify the signal file JSON includes the specific error message

**Verification:**
- `bun test tests/agent.test.ts` passes
- Signal file contains "Context window overflow" for context errors
- `make check` passes

---

- [ ] **Unit 4: Tool result pruning**

**Goal:** Implement tool result pruning with outcome-preserving stubs.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1 (context estimation for threshold mode), Unit 2 (config)

**Files:**
- Modify: `src/agent.ts`
- Create or extend: `src/context.ts` (add `pruneMessages` and `StubMetadata` type)
- Modify: `tests/agent.test.ts`
- Modify: `tests/context.test.ts`

**Approach:**

*Metadata capture:* During tool execution (lines 525-576), before pushing to `toolResults`, build a `StubMetadata` entry for each tool call. Note: metadata is captured from the post-truncation tool result (what the model actually saw), not the original file. For truncated files, the stub will show truncated stats, which is correct — the stub summarizes what was in the conversation, not the original file:
  - For `read_file` / `list_files`: tool name, path, line count (count `\n` in result content), byte size of result
  - For `write_file` / `delete_file`: tool name, path, ok/error status
  - For `patch_file`: tool name, path, ok/error status, hunk count (parsed from result JSON before metadata is stored)
  - For `run_command`: command + args, exit code, stdout byte size
  - Store in `Map<string, StubMetadata>` keyed by `tool_use_id`

*Pruning function:* `pruneMessages(messages: Anthropic.MessageParam[], metadata: Map<string, StubMetadata>, strategy: "always" | "threshold" | "off", estimatedTokens: number, threshold: number, modelWindow: number): Anthropic.MessageParam[]`
  - `off` → return messages unchanged
  - `always` → replace content of all tool_result blocks except those in the last user message
  - `threshold` → same as `always` but only when `estimatedTokens > threshold * modelWindow`
  - Replacement: for each `ToolResultBlockParam` in prior user messages, replace `.content` with the stub string from metadata. Preserve `.tool_use_id` and `.type`. Note: `ToolResultBlockParam.content` can be `string | Array<...>` per the SDK types. Vesper always generates string content, but if content is unexpectedly an array, skip that block rather than crash
  - The stub format: `[tool_name: target — outcome, size]` per the examples in R1

*Integration:* At the message append step (line 579-583), instead of spreading all prior messages as-is, call `pruneMessages` on the accumulated messages before appending the new turn.

**Patterns to follow:**
- `truncateResult()` in `tools.ts` for size computation pattern
- Existing `toolResults` construction at `agent.ts:524-576`

**Test scenarios:**
- Happy path: pruning `always` — after 3 tool loop turns, first turn's read_file result is replaced with `[read_file: path — N lines, NKB]` stub
- Happy path: pruning `always` — write_file result becomes `[write_file: path — ok]`
- Happy path: pruning `always` — run_command result becomes `[run_command: cmd — exit 0, NKB stdout]`
- Happy path: pruning `off` — messages are unchanged
- Happy path: pruning `threshold` at 70% — messages below threshold are not pruned
- Happy path: pruning `threshold` at 70% — messages above threshold are pruned
- Edge case: most recent turn's tool results are never pruned regardless of strategy
- Edge case: messages[0] (initial user task) is never modified
- Edge case: signal tool results (`{ ok: true }`) are pruned like any other tool result
- Edge case: tool_use_id linkage preserved — each pruned tool_result still has matching id
- Integration: stub client verifying that pruned messages are sent to the API on the next call

**Verification:**
- Messages sent to API on subsequent calls contain stubs for prior turns
- Most recent turn always has full content
- `tool_use_id` linkage intact across all messages
- `make check` passes

---

- [ ] **Unit 5: Pre-call context guard**

**Goal:** Estimate context before each API call and fail gracefully at 95% of the model window.

**Requirements:** R12

**Dependencies:** Unit 1 (estimation), Unit 2 (config). Note: the compaction deferral path (checking `compactionAttempted`) is wired in Unit 6. Unit 5 ships as a standalone guard — if context exceeds 95%, write `failed`. Unit 6 adds the deferral behavior.

**Files:**
- Modify: `src/agent.ts`
- Modify: `tests/agent.test.ts`

**Approach:**
- Before the `while` loop, compute `const fixedCostTokens = estimatePayloadTokens(systemBlocks, tools, [])` once. Inside the loop before `messagesClient.create()`, compute `fixedCostTokens + estimatePayloadTokens([], [], messages)` and compare against `0.95 * getModelContextWindow(model)`
- If over threshold, write `failed` signal with `"Estimated context size (N tokens) exceeds 95% of model window (M tokens)"` and `extractLastText` for context. (Unit 6 later adds deferral to compaction before failing.)
- Add logger event: `context_guard_triggered` with estimated tokens and model window
- After each successful API call, compare the estimate against `response.usage.input_tokens`. If the ratio diverges beyond 30%, emit a `context_estimation_drift` logger warning. This gives operators visibility into heuristic accuracy without requiring a tokenizer

**Patterns to follow:**
- Existing budget check at `agent.ts:500-512`
- `writeFailed()` + `logger.signalWrite()` pattern

**Test scenarios:**
- Happy path: estimated context at 50% → API call proceeds normally
- Happy path: estimated context at 96% → writes failed signal with descriptive message
- Edge case: estimated context at 94.9% → API call proceeds (just under threshold)
- Edge case: guard fires on the very first API call (e.g., massive system prompt + initial task)
- Integration: verify logger emits `context_guard_triggered` event
- Integration: verify `context_estimation_drift` emitted when estimate diverges >30% from actual

**Verification:**
- Agent stops before sending oversized request
- Signal file message includes estimated and maximum token counts
- `make check` passes

---

- [ ] **Unit 6: Conversation compaction**

**Goal:** Implement conversation compaction — summarize history via an extra API call when context exceeds the compaction threshold.

**Requirements:** R4, R5, R6, R7, R8, R9, R14

**Dependencies:** Unit 1, Unit 2, Unit 4 (pruning fires first), Unit 5 (guard defers to compaction)

**Files:**
- Extend: `src/context.ts` (add `compactConversation` function)
- Modify: `src/agent.ts`
- Modify: `tests/agent.test.ts`
- Modify: `tests/context.test.ts`

**Approach:**

*Compaction function:* `compactConversation(client: MessageClient, model: string, messages: Anthropic.MessageParam[], userContent: string, maxTokens?: number): Promise<{ summary: string; usage: Anthropic.Usage }>`
  - Builds a compaction prompt asking the model to summarize: what was accomplished, files modified, commands run and outcomes, current state, what remains
  - Sends via `client.create()` with the compaction model (or agent's model), `max_tokens` of 8192 (2x the normal 4096, since the summary must capture a full conversation), no tools, and a compaction-specific system prompt
  - Returns the summary text and usage for budget tracking

*Integration into tool loop:*
  - Hoist `userContent` variable (currently local at line 429) to remain accessible throughout the loop
  - After pruning and before the API call, if compaction is enabled and estimated context exceeds `compaction_threshold * modelWindow` and `compactionAttempted` is false:
    1. Call `compactConversation()`
    2. Add compaction usage to `totalInputTokens` / `totalOutputTokens` (R8)
    3. Check token budget after compaction (may trigger `needs_approval`)
    4. Replace messages array: `[{ role: "user", content: "[Original Task]\n{userContent}\n\n[Conversation Summary]\n{summary}" }]`
    5. Set `compactionAttempted = true` — **compaction fires at most once per Vesper invocation**. If context grows back above threshold after compaction, the pre-call guard (R12) will fire and write a `failed` signal. This is a deliberate design choice: repeated compaction compounds summary degradation
    6. Log `context_compacted` event with before/after size estimates
    7. Re-estimate context. If still over compaction threshold, execute R14: write summary to scratchpad (if configured) + `writeAgentNeedsApproval`
  - Unit 6 also modifies Unit 5's pre-call guard to add a deferral path: if `compactionAttempted` is false and compaction is enabled, trigger compaction instead of writing `failed`

*Compaction failure (R9):*
  - If `compactConversation()` throws, catch the error, write `failed` signal with descriptive message and the error's message as context. The last main-loop response (available in the outer `while` scope) can provide additional context via `extractLastText` if available. Return exit code 1

*Scratchpad write (R14):*
  - If scratchpad path is configured (`config.scratchpad`), resolve it via `resolve(cwd, config.scratchpad)` and validate with `isInsideCwd()` before writing — matching the read-side pattern at `agent.ts:434-435`. If containment fails, skip the scratchpad write but still write the signal
  - Write the compaction summary using `Bun.write(resolvedPath, summary)`
  - Then write `needs_approval` signal via `writeAgentNeedsApproval()`

**Patterns to follow:**
- Existing `messagesClient.create()` call pattern at `agent.ts:467-478`
- `writeAgentNeedsApproval()` in `signals.ts:70-82`
- `extractLastText()` for failure context

**Test scenarios:**
- Happy path: compaction disabled (default) — compaction never fires regardless of context size
- Happy path: compaction enabled, context below threshold — no compaction
- Happy path: compaction enabled, context above threshold — compaction fires, messages replaced with single user message containing `[Original Task]` and `[Conversation Summary]` delimiters
- Happy path: compaction with custom model — API call uses the configured compaction model
- Happy path: compaction usage counted against token budget
- Error path: compaction API call throws — writes `failed` signal with descriptive message
- Error path: compaction API call returns max_tokens — treated as failure per R9
- Edge case: context still over threshold after compaction — writes scratchpad + needs_approval (R14)
- Edge case: R14 with no scratchpad configured — skips scratchpad write, still writes needs_approval
- Edge case: compaction fires only once per cycle — `compactionAttempted` prevents re-triggering
- Integration: verify the compacted messages array has exactly one element with role `user` containing the delimiters, and that the `system` parameter passed to the next API call is unchanged (system blocks are a separate API parameter, not part of the messages array)
- Integration: verify token budget check runs after compaction usage is added

**Verification:**
- Compacted conversation is valid API input (system + single user message)
- Token budget correctly includes compaction usage
- Failure signals include descriptive context
- `make check` passes

---

- [ ] **Unit 7: Logger events for context management**

**Goal:** Add all context management events to the logger.

**Requirements:** Success criterion: "Context management events are observable via the existing JSONL event logger"

**Dependencies:** Units 1, 4, 5, 6 (events are emitted by those units, but the logger methods can be added first)

**Files:**
- Modify: `src/logger.ts`
- Modify: `tests/logger.test.ts`

**Approach:**
- Add methods to `Logger` class:
  - `contextPruned(messagesPruned: number, estimatedTokensSaved: number)` — emits `context_pruned`
  - `contextCompacted(beforeTokens: number, afterTokens: number)` — emits `context_compacted`
  - `contextGuardTriggered(estimatedTokens: number, modelWindow: number)` — emits `context_guard_triggered`
  - `contextWindowUnknown(model: string, fallbackWindow: number)` — emits `context_window_unknown`
  - `contextEstimationDrift(estimated: number, actual: number, ratio: number)` — emits `context_estimation_drift`

**Patterns to follow:**
- Existing `apiCall()`, `toolCall()`, `signalWrite()` methods

**Test scenarios:**
- Happy path: each method emits correct event name and data fields when logging enabled
- Happy path: each method is a no-op when logging disabled
- Edge case: event data includes run_id and timestamp (inherited from `emit`)

**Verification:**
- Logger emits valid JSONL for each new event type
- `make check` passes

## System-Wide Impact

- **Interaction graph:** Context management inserts into the tool loop between tool result collection and the API call. It does not change signal file writing, config loading, tool execution, or the CLI entry point. The only new outbound call is the compaction API request (optional, via existing `MessageClient`)
- **Error propagation:** Context management failures (pre-call guard, compaction failure) propagate through the existing signal file mechanism — `writeFailed` or `writeAgentNeedsApproval`. No new error channels
- **State lifecycle risks:** Pruning mutates message content between turns. If a bug in pruning corrupts `tool_use_id` linkage, the API will reject the request. Mitigation: pruning only replaces the `content` field, never the block structure or IDs
- **API surface parity:** No external API is affected. Agent YAML config gains a new optional `context_management` section
- **Unchanged invariants:** Signal file paths, scratchpad read mechanism, CLI arguments, tool definitions, permission enforcement, and the single-conversation-per-invocation model are all unchanged

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pruning corrupts `tool_use_id` linkage | Only replace `.content` string, never touch `.tool_use_id` or block structure. Test linkage preservation explicitly |
| Assistant messages untouched by pruning | After tool results are stubbed, assistant messages (model reasoning, code blocks) become the dominant context source. Pruning alone may be insufficient for long conversations with verbose model output. Future work could truncate assistant text blocks while preserving `tool_use` blocks. For now, compaction is the fallback |
| chars/3 heuristic significantly under/overestimates | Log estimated vs. actual (`response.usage.input_tokens`) in `context_compacted` and `context_pruned` events for empirical tuning |
| Compaction summary loses critical context | Compaction prompt is designed for agentic continuity (accomplishments, state, remaining work). Iterating on prompt quality is deferred to implementation |
| Anthropic SDK error format changes | R13 detection uses `instanceof BadRequestError` + `.type` check. If the SDK changes, the check fails open to the existing generic handler — no regression |
| Token budget exhausted by compaction call itself | R8 requires compaction tokens count against budget. Budget check runs immediately after compaction. If budget is exceeded, `needs_approval` fires normally |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-15-context-management-requirements.md](docs/brainstorms/2026-04-15-context-management-requirements.md)
- Related code: `src/agent.ts` (conversation loop), `src/config.ts` (config loading), `src/context.ts` (new), `src/logger.ts`, `src/signals.ts`
- Institutional learnings: `docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`, `docs/solutions/best-practices/skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md`, `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`, `docs/solutions/best-practices/signal-file-context-agent-runtime-2026-04-13.md`
