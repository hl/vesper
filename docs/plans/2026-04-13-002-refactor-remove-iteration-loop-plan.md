---
title: "refactor: Remove iteration loop from Vesper"
type: refactor
status: active
date: 2026-04-13
---

# refactor: Remove iteration loop from Vesper

## Overview

Vesper currently contains an outer iteration loop in `agent.ts` that re-creates fresh API conversations and checks a `CompletionTracker` between iterations. This loop does not belong in Vesper — the external orchestrator **brr** (`/Users/hl/Projects/brr`) owns iteration, re-invocation, signal file checking, fail-streak tracking, and progress detection. Vesper should run exactly one API conversation (with its inner tool-call loop), write a signal file, and exit.

## Problem Frame

Vesper and brr have overlapping responsibilities. brr's `engine.go` runs a loop that invokes the agent command repeatedly, pipes the prompt to stdin, and checks for signal files (`.brr-complete`, `.brr-needs-approval`) between iterations. Vesper duplicates this with its own `while (iterationCount < MAX_ITERATIONS)` loop, `CompletionTracker` (watch file monitoring, no-progress detection), and multi-iteration completion logic. This creates confusion about ownership, makes Vesper harder to reason about, and couples it to iteration semantics that belong in the orchestrator.

## Requirements Trace

- R1. Vesper runs one API conversation per invocation — no outer iteration loop
- R2. The inner tool-call loop (model calls tools until `stop_reason !== "tool_use"`) is preserved
- R3. Signal file writing (complete, needs_approval, failed) is preserved with configurable paths via `signals:` config
- R4. `CompletionTracker`, `completion.ts`, and all watch_file/no_progress_limit logic are removed
- R5. The `completion:` config block is removed from AgentConfig and no longer required in YAML
- R6. Existing agent YAML files with `completion:` blocks continue to load (field is silently ignored)
- R7. Token budget enforcement within the single conversation is preserved
- R8. Scratchpad and skills injection are preserved (read once per invocation)

## Scope Boundaries

- Signal file config (`signals:` block) is untouched — that's the brr/vesper integration surface
- Permission system, tool execution, scratchpad, skills — all untouched
- No changes to brr

## Context & Research

### Relevant Code and Patterns

- `src/agent.ts:388-537` — outer iteration loop to remove; inner tool loop at lines 423-513 to keep
- `src/completion.ts` — `CompletionTracker` class, entirely brr's concern
- `src/config.ts:32-36, 114-142` — `completion` field on `AgentConfig` and its validation
- `src/index.ts:120-131` — early completion check using `CompletionTracker`
- `src/logger.ts:21-23, 38-39` — `iterationStart()` and `completionCheck()` methods
- `src/signals.ts:63` — `writeFailed` accepts `"no_progress"` reason, which no longer applies
- `src/init.ts:52-54` — example YAML template includes `completion:` block
- `.vesper/agents/*.yml` — all four agent configs have `completion:` blocks
- brr `internal/engine/engine.go:172-278` — the iteration loop that owns re-invocation

## Key Technical Decisions

- **Silently ignore `completion:` in YAML rather than rejecting it**: Existing agent configs in the wild may have this field. Removing the validation (not adding a rejection) means old YAMLs keep working. Since `loadConfig` only validates fields it explicitly checks, removing the completion validation block is sufficient — unknown YAML keys are already ignored.
- **Remove `"no_progress"` from `writeFailed` reason union**: This reason only existed for the iteration loop's no-progress detection. The remaining reasons are `"error"` (API errors, max_tokens truncation). Simplify the type.
- **After tool loop ends normally, always write `.vesper-complete`**: When the model stops calling tools (end_turn), the conversation is done. Vesper writes the complete signal and exits 0. brr decides whether to re-invoke.

## Open Questions

### Resolved During Planning

- **Should `completion:` in YAML cause an error?** No — silently ignore for backward compatibility (R6).
- **Does removing the iteration loop affect scratchpad?** No — scratchpad is still read once at the start of the single conversation. brr re-invokes vesper, which re-reads the scratchpad each invocation. The per-iteration re-read in the old loop was the equivalent.

### Deferred to Implementation

- None — this is a straightforward deletion refactor.

## Implementation Units

- [ ] **Unit 1: Remove CompletionTracker and completion config**

  **Goal:** Delete `completion.ts`, remove `completion` from `AgentConfig`, remove completion validation from config loading, remove early completion check from CLI entry.

  **Requirements:** R4, R5, R6

  **Dependencies:** None

  **Files:**
  - Delete: `src/completion.ts`
  - Delete: `tests/completion.test.ts`
  - Modify: `src/config.ts` — remove `completion` field from `AgentConfig` interface, remove completion validation from `loadConfig`
  - Modify: `src/index.ts` — remove `CompletionTracker` import and early completion check (lines 120-131)
  - Test: `tests/config.test.ts`

  **Approach:**
  - Delete `src/completion.ts` and `tests/completion.test.ts` entirely
  - In `config.ts`: remove the `completion` property from `AgentConfig`, remove the `completion` required check (lines 114-117), remove `watchFile`/`noProgressLimit` validation (lines 134-142), remove `completion` from the return object
  - In `index.ts`: remove `CompletionTracker` import, remove the early completion check block, remove the `CompletionTracker` import from the import statement
  - In `tests/config.test.ts`: remove `completion: {}` from all YAML fixtures, remove tests for completion validation ("exits with code 1 when completion key is absent", "completion.no_progress_limit is not a number", "completion.watch_file is not a string"), update `validYaml` and `minimalYaml` to not include `completion`, remove assertions on `config.completion`

  **Patterns to follow:**
  - Existing config validation pattern — only validate fields that exist in `AgentConfig`

  **Test scenarios:**
  - Happy path: YAML without `completion:` block loads successfully with all other fields correct
  - Happy path: YAML with `completion:` block still loads successfully (silently ignored, R6)
  - Edge case: previously-required `completion: {}` in minimal YAML is no longer needed

  **Verification:**
  - `bunx tsc --noEmit` passes — no references to deleted types
  - `bun test tests/config.test.ts` passes
  - No import of `completion.ts` anywhere in the codebase

- [ ] **Unit 2: Remove iteration loop from agent.ts**

  **Goal:** Flatten `runAgent` to run one API conversation, write signal, and return.

  **Requirements:** R1, R2, R3, R7, R8

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/agent.ts`
  - Modify: `src/signals.ts` — narrow `writeFailed` reason type
  - Test: `tests/agent.test.ts`

  **Approach:**
  - In `agent.ts`: remove `CompletionTracker` import, remove `MAX_ITERATIONS` constant, remove `iterationCount` variable, remove the outer `while` loop. The function body becomes: build system/user message (with skills + scratchpad), run the inner tool loop, then after `stop_reason !== "tool_use"` write `.vesper-complete` and return exit 0. Token budget and max_tokens checks remain inside the inner loop unchanged.
  - In `signals.ts`: change `writeFailed` reason parameter from `"no_progress" | "error"` to just `"error"` (string literal type narrowing)
  - In `tests/agent.test.ts`: remove `completion` from `makeConfig` factory entirely, delete test 8 (no_progress detection) and test 9 (watch file empty), rewrite test 1 to verify that end_turn writes complete signal directly (no watch_file needed), strip all `completion:` overrides from remaining tests

  **Patterns to follow:**
  - The existing inner tool loop pattern (lines 423-513) — keep this exactly as-is
  - Signal writing pattern — `writeComplete` on success, `writeFailed` on error, `writeNeedsApproval` on budget

  **Test scenarios:**
  - Happy path: model returns end_turn on first call -> writes `.vesper-complete`, exit 0
  - Happy path: model calls tools then returns end_turn -> writes `.vesper-complete`, exit 0
  - Error path: API error -> writes `.vesper-failed` with reason "error", exit 1
  - Error path: max_tokens truncation -> writes `.vesper-failed`, exit 1
  - Error path: token budget exceeded -> writes `.vesper-needs-approval`, exit 0
  - Happy path: token budget exceeded mid-conversation (after tool calls) -> writes `.vesper-needs-approval`
  - Happy path: scratchpad + skills still injected into user message
  - Happy path: permission denied tool calls still work correctly within the single conversation

  **Verification:**
  - `bun test tests/agent.test.ts` passes
  - No reference to `CompletionTracker`, `iterationCount`, `MAX_ITERATIONS`, or `completionCheck` in `agent.ts`

- [ ] **Unit 3: Remove iteration/completion logger events**

  **Goal:** Remove logger methods that only existed for the iteration loop.

  **Requirements:** R1 (no iteration concept)

  **Dependencies:** Unit 2

  **Files:**
  - Modify: `src/logger.ts`
  - Modify: `tests/logger.test.ts`

  **Approach:**
  - Remove `iterationStart()` and `completionCheck()` methods from `Logger`
  - Update logger tests to remove assertions on these events

  **Patterns to follow:**
  - Keep remaining logger methods (`apiCall`, `toolCall`, `signalWrite`, `skillsLoaded`) unchanged

  **Test scenarios:**
  - Happy path: Logger still emits api_call, tool_call, signal_write, skills_loaded events correctly
  - Edge case: Logger with events disabled still suppresses all output

  **Verification:**
  - `bun test tests/logger.test.ts` passes
  - No reference to `iterationStart` or `completionCheck` in the codebase

- [ ] **Unit 4: Update agent YAMLs, init template, and docs**

  **Goal:** Remove `completion:` blocks from all agent configs, init scaffolding, and CLAUDE.md.

  **Requirements:** R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `.vesper/agents/builder.yml`
  - Modify: `.vesper/agents/planner.yml`
  - Modify: `.vesper/agents/reviewer.yml`
  - Modify: `.vesper/agents/scribe.yml`
  - Modify: `src/init.ts` — remove `completion:` from example YAML template, update CLAUDE.md scaffold
  - Modify: `tests/init.test.ts` — remove assertion for `completion:`
  - Modify: `CLAUDE.md` — remove completion references from architecture docs

  **Approach:**
  - Remove the `completion:` block (and its comments) from each agent YAML
  - In `init.ts`: remove the completion lines from `EXAMPLE_AGENT_YML`, update the `token_budget` comment from "Max tokens across all iterations" to "Max tokens per run", update the CLAUDE.md scaffold to remove "iterations" language from the scratchpad section
  - In `CLAUDE.md`: remove `completion.ts` from architecture, remove "Fresh context per iteration" from technical constraints, remove watch file gotcha (#6), update core flow description

  **Test scenarios:**
  - Test expectation: none — pure config/docs changes. Verified by `make check` passing.

  **Verification:**
  - `grep -r "completion" src/ tests/ .vesper/agents/` returns no hits except possibly in unrelated contexts
  - `grep -r "iteration" src/ tests/` returns no hits related to the outer loop concept
  - `make check` passes

## System-Wide Impact

- **Interaction graph:** brr invokes vesper via subprocess with prompt on stdin. Vesper writes signal files that brr reads. This interface is unchanged — vesper still writes the same signals, brr still reads them. The only change is vesper no longer duplicates brr's iteration logic internally.
- **Error propagation:** Unchanged. API errors, max_tokens, and budget exhaustion still produce the same signal files and exit codes.
- **API surface parity:** Agent YAML configs lose the `completion:` block but old configs with it still load (backward compatible).
- **Unchanged invariants:** Signal file names, paths, and format. Permission system. Tool execution. Scratchpad and skills injection. Token budget enforcement.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Old agent YAML files with `completion:` break | Silently ignore unknown fields (R6) — tested explicitly |
| Tests that relied on iteration behavior have gaps | Each test is individually reviewed and rewritten to test single-conversation behavior |

## Sources & References

- brr engine loop: `internal/engine/engine.go` in `/Users/hl/Projects/brr`
- Related plans: `docs/plans/2026-04-12-001-feat-vesper-cli-plan.md` (original architecture)
