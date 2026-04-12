---
date: 2026-04-12
topic: open
focus: ~
---

# Ideation: Vesper v0.2 Improvements

## Codebase Context

Vesper is a greenfield TypeScript/Bun CLI that loads named agent personas (YAML config + MD system prompt) and runs them against the Anthropic API with structural permission enforcement. Architecture: agent.ts (agentic loop), permissions.ts (path/command allow-lists), tools.ts (6 tools), signals.ts (complete/needs-approval/failed), config.ts (YAML parsing), completion.ts (watch file monitoring). 93 tests across 6 files. Compiled to native binary. No README, no observability, no prompt caching.

## Ranked Ideas

### 1. Configurable Model Per Agent
**Description:** Add an optional `model` field to agent YAML config. Default to current hardcoded model. Pass through to `messagesClient.create()`.
**Rationale:** Unanimous across 4/4 ideation agents. Different personas have different intelligence/cost profiles. Planner benefits from stronger reasoning; reviewer could run cheaper. One-line config addition, one-line code change.
**Downsides:** None meaningful. Default preserves current behavior.
**Confidence:** 95%
**Complexity:** Low
**Status:** Explored

### 2. Prompt Caching
**Description:** Pass the system prompt as a structured content block with `cache_control: { type: "ephemeral" }` instead of a plain string. Tool definitions get the same treatment.
**Rationale:** Every API call pays full input token cost for the same system prompt + tools prefix. For a builder doing 20 tool calls, that's 20x redundant processing. The SDK supports this natively.
**Downsides:** Cache has a 5-minute TTL. Negligible code change.
**Confidence:** 95%
**Complexity:** Low
**Status:** Explored

### 3. Permission Transparency
**Description:** When a tool call is denied, return structured context (tool name, path, which allow-list was checked) instead of opaque `{error: "permission_denied"}`. Gate behind opt-in config flag (`reveal_permissions: true`).
**Rationale:** 4/4 agents flagged independently. LLM wastes tokens retrying blind. `logDeniedCall` already computes the denial info — it just never reaches the model.
**Downsides:** Reveals permission config to the LLM. Opt-in flag mitigates adversarial probing.
**Confidence:** 90%
**Complexity:** Low
**Status:** Explored

### 4. Filter Tool Definitions by Permissions
**Description:** Before each API call, filter `TOOL_DEFINITIONS` to include only tools the agent has permission to use (non-empty allow-lists). A reviewer with `delete: []` and `commands: []` only sees `read_file`, `list_files`, `write_file`.
**Rationale:** Reduces context window waste and model confusion. Compounds with prompt caching — fewer tools = smaller cached prefix.
**Downsides:** Dynamic tool list per agent; minor prompt template consideration.
**Confidence:** 85%
**Complexity:** Low
**Status:** Explored

### 5. Structured Event Log (JSONL)
**Description:** Emit one JSONL line per event to stderr: iteration start, API call (tokens, latency), tool execution (name, duration, permitted/denied), completion check, signal write. Run ID and timestamp on each line. Gate behind `--verbose` or config flag.
**Rationale:** 3/4 agents flagged zero observability as the biggest operational gap. The loop already tracks tokens and iteration count but never emits them.
**Downsides:** Adds noise to stderr when enabled. Flag keeps default clean.
**Confidence:** 85%
**Complexity:** Low-Medium
**Status:** Explored

### 6. Runtime-Enforced Scratchpad
**Description:** At each iteration boundary, the runtime reads a designated scratchpad file and injects its contents into the user message before the task prompt. Configured via a `scratchpad_file` field in the YAML config.
**Rationale:** 3/4 agents flagged the fragile convention. Both planner and builder waste their first tool call reading the scratchpad every iteration. If the LLM forgets, context is silently lost.
**Downsides:** Couples runtime to scratchpad concept. Injected context consumes tokens.
**Confidence:** 75%
**Complexity:** Medium
**Status:** Explored

### 7. Command Execution Timeout
**Description:** Add a `command_timeout` field to agent YAML config (default 30s). Enforce with a kill timer around `Bun.spawn`. Return `{stdout, stderr, exit_code: 124}` on expiry.
**Rationale:** 3/4 agents flagged this. A hung command blocks the agent forever with no signal, no error, no recovery. Builder allows `git commit` which spawns arbitrary hooks.
**Downsides:** Choosing a good default is hard — some commands legitimately run long. Per-agent config handles this.
**Confidence:** 85%
**Complexity:** Low
**Status:** Explored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | API retry with backoff | Operators can wrap the binary; retry complicates the clean error model |
| 2 | Dry-run / validate mode | Low leverage — config errors surface instantly on run |
| 3 | Streaming API | Spec excludes it; significant complexity for headless CLI |
| 4 | Graceful SIGTERM handling | Orchestrators handle cleanup; small utility |
| 5 | Signal file cleanup | One-liner for caller; couples binary to orchestration policy |
| 6 | Partial config fallback | Strict behavior is intentional design |
| 7 | Watch file content injection | Couples runtime to queue format |
| 8 | Parallel tool execution | Premature; most iterations do 1-2 tool calls |
| 9 | Agent self-declaring completion | Violates "structural, not instructional" principle |
| 10 | Token budget soft warning | Requires mid-conversation injection; complex |
| 11 | Tool extension / plugins | Premature for v0 |
| 12 | Bidirectional signal channel | Scope creep; changes execution model |
| 13 | Configurable MAX_OUTPUT_TOKENS | Low value (but stop_reason max_tokens mishandling is a bug) |
| 14 | Programmatic API | Already nearly there; premature to formalize |
| 15 | Config inheritance | Only 3 agents; premature abstraction |
| 16 | Search/glob tool | Duplicates coreutils via run_command |
| 17 | Tool result truncation | Complex context window management; later |
| 18 | Command permission globbing | Scope creep; current design intentionally simple |

## Session Log
- 2026-04-12: Initial ideation — 37 candidates generated across 4 agents, 7 survived. All 7 selected for v0.2 brainstorm batch.
