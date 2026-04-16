---
date: 2026-04-15
topic: context-management
---

# Context Window Management

## Problem Frame

Vesper accumulates the full conversation (assistant responses + tool results) in a messages array that grows unbounded within a single invocation. Tool results — especially `read_file` — are the dominant source of context bloat. When the messages exceed the model's context window, the API call fails with a hard error that surfaces as a generic "API error" failure signal.

The existing `token_budget` provides an indirect guard (cumulative input tokens are recounted each turn, so budgets are typically exhausted before the window fills), but it's a cost guard, not a context guard. An agent that reads several large files early can blow past the context window before the budget check fires.

Agents need to do meaningful iterative work — reading files, patching, verifying — within a single invocation without hitting the context ceiling.

## Requirements

**Tool Result Pruning**
- R1. After the model has responded to a set of tool results, replace the `content` field of each prior turn's `tool_result` blocks with compact stubs before the next API call. The block structure (including `tool_use_id`) must be preserved to maintain API contract validity. Stubs must identify the tool, target, outcome status, and rough size. Examples:
  - `[read_file: src/agent.ts — 610 lines, 15KB]`
  - `[write_file: src/config.ts — ok]`
  - `[run_command: bun test — exit 0, 2KB stdout]`
  - `[patch_file: src/agent.ts — ok, 3 hunks applied]`
- R2. The pruning strategy is configurable per agent in the YAML config: `always` (old results are replaced with stubs per R1 timing), `threshold` (prune only when estimated context exceeds `context_management.pruning_threshold` — a percentage of the model's window, default 70%), or `off` (default — no pruning, current behavior).
- R3. Tool results from the most recent API response are never pruned. Pruning is applied only to tool results from prior turns, before making the next API call. The model always sees the full content of the most recent tool call responses.

**Conversation Compaction**
- R4. When compaction is enabled and estimated context size exceeds `context_management.compaction_threshold` (a configurable percentage of the model's context window, default 80%), trigger a compaction pass before the next tool-loop API call. The pruning threshold (R2) and compaction threshold are separate settings; when both pruning (`threshold` mode) and compaction are active, pruning fires first at its lower threshold, and compaction fires at its higher threshold only if pruning was insufficient.
- R5. Compaction summarizes the conversation history into a compact representation. The system prompt is preserved verbatim as the system block. The original composed `userContent` (including skills and scratchpad content) and the compaction summary are combined into a single user message with clear section delimiters (e.g., `[Original Task]` and `[Conversation Summary]`). This produces a valid single-turn conversation (system + one user message) that the API accepts without relying on consecutive-user-message merging behavior.
- R6. The compaction model defaults to the agent's configured model but can be overridden to a different model (e.g., Haiku) via `context_management.compaction_model` in agent YAML.
- R7. Compaction is opt-in and disabled by default. When context management is needed, pruning alone is the recommended first-line strategy.
- R8. Compaction API call token usage counts against the agent's `token_budget`. If a different compaction model is configured (R6), its token usage still counts toward the same budget.
- R9. If the compaction API call itself fails (rate limit, network error, truncation), the agent writes a `failed` signal with a descriptive message. No retry.

**Context Estimation**
- R10. Context size estimation uses a token heuristic (character count / 3) rather than a tokenizer or API call. The chars/3 ratio is more conservative than chars/4 because it produces larger token estimates, leaving a safer margin before thresholds fire. It also better matches code and JSON tokenization patterns. The estimate covers the full API payload: system blocks, tool definitions, and all messages.
- R11. The model's context window size is derived from the model identifier using prefix matching against SDK model IDs. Known mappings: `claude-sonnet-4` (200K), `claude-opus-4` (200K), `claude-haiku-4` (200K), `claude-haiku-3` (200K). The matching strategy is longest-prefix-wins (e.g., `claude-opus-4-6` matches `claude-opus-4` at 200K). Unknown models fall back to a conservative default of 200K and emit a logger warning event (e.g., `context_window_unknown`) so operators can detect misconfiguration. The lookup table is a flat map in source code, updated when new models with different context windows are released.

**Pre-call Guard**
- R12. Before each API call, estimate the context size (R10). If the estimate exceeds 95% of the model's context window, and compaction is not enabled or has already fired this cycle, write a `failed` signal with a clear message indicating impending context overflow rather than sending the request.

**Safety Net**
- R13. If an API call fails with a context-length error, write a `failed` signal with a clear message indicating context overflow. Detection: check for Anthropic SDK `BadRequestError` (status 400) where `error.type === 'invalid_request_error'` and the message contains "prompt is too long" or similar token-count language. This replaces the current generic "API error" message for this specific failure mode. Note: R13 is a standalone improvement that can ship independently of pruning/compaction.
- R14. If compaction is enabled and context still exceeds the compaction threshold after compaction, write the compaction summary to the scratchpad file (if configured) and then write a `needs_approval` signal using the existing `writeAgentNeedsApproval` function with the summary as the message field.

**Backward Compatibility**
- R15. Existing agent YAML configs without context management settings continue to work. Defaults: pruning `off`, compaction `off`. No behavioral change for agents that don't opt in.

## Success Criteria

- Agents with pruning enabled can iterate longer within a single invocation before hitting context limits (measured by comparing tool call count at context overflow with pruning `always` vs. `off` on a representative workload)
- The API never returns a context-too-large error when pruning or the pre-call guard (R12) is active
- Existing agents work identically without config changes
- Context management events (pruning, compaction, pre-call guard) are observable via the existing JSONL event logger

## Scope Boundaries

- No changes to the single-conversation-per-invocation model
- No changes to signal file paths or the scratchpad read mechanism — R14 writes to the existing scratchpad file using standard file I/O
- No streaming support (not currently implemented)
- No external tokenizer dependency — heuristic estimation only
- Compaction prompt design is deferred to planning

## Key Decisions

- **Pruning before compaction**: Tool result pruning is the first defense because it's cheap, deterministic, and handles the most common case. Compaction is a second layer for when pruning alone isn't sufficient.
- **Off as default**: Pruning changes what the model sees in subsequent turns. Defaulting to `off` preserves current behavior for existing agents — users opt into pruning explicitly.
- **Compaction opt-in**: Compaction adds an extra API call and complexity. Agents that don't need it shouldn't pay for it.
- **chars/3 over chars/4**: Code and JSON (the dominant content in tool results) tokenize at roughly 2.5-3 chars/token, not 4. Using chars/3 prevents thresholds from firing too late for the content types that matter most.
- **Outcome-preserving stubs**: Stubs include success/failure status for write/patch/command tools because the model uses these signals to track its own progress. Read-only tools get size metadata; mutating tools get outcome status.

## Dependencies / Assumptions

- Model context window sizes should be mapped for supported models (see R11 for initial mapping and fallback behavior). This is a small lookup table, not an external dependency.
- The Anthropic API returns `BadRequestError` with `error.type === 'invalid_request_error'` for context-length failures.
- The Anthropic Messages API requires `tool_result` blocks to include a `tool_use_id` matching a prior `tool_use` block — pruning must preserve this linkage.
- The Anthropic Messages API merges consecutive same-role messages into a single turn. R5's compacted structure avoids relying on this by using a single user message.

## Outstanding Questions

### Deferred to Planning
- [Affects R5][Technical] What should the compaction prompt look like? What instructions produce the best summary for agentic continuity?
- [Affects R4][Needs research] What threshold percentages work well in practice? Defaults are 70% (pruning) and 80% (compaction) — should these be validated empirically?
- [Affects R10][Technical] How does pruning interact with prompt caching (`cache_control: ephemeral`)? Modifying message content between turns may invalidate cache breakpoints — measure the impact on cache hit rate.
- [Affects R1][Technical] Stub generation requires correlating each `tool_result.tool_use_id` back to the matching `tool_use` block in the preceding assistant message to extract the tool name and input parameters. Decide the data structure for this correlation.
- [Affects R1][Technical] Stub metadata (line count, byte size) must be computed from tool result content before pruning replaces it. Determine when and where this metadata is captured.
- [Affects R9, R14][Technical] Clarify failure mode ordering: if compaction API call fails (R9, writes `failed`), R14 does not apply. If compaction succeeds but context still exceeds threshold, R14 applies. If both the pre-call guard (R12) and compaction are in play, define precedence.

## Next Steps

-> `/ce:plan` for structured implementation planning
