---
title: "feat: Vesper v0.3 — signal config, env safety, and result bounding"
type: feat
status: active
date: 2026-04-12
origin: docs/brainstorms/2026-04-12-vesper-v03-requirements.md
---

# feat: Vesper v0.3 — signal config, env safety, and result bounding

## Overview

Move signal file names from environment variables to YAML config, sanitize the child process environment for command execution, bound tool result sizes, and check for stale signal files at startup.

## Problem Frame

Signal file naming via env vars is inconsistent with the YAML-first config model. Spawned commands inherit secrets from the parent environment. Tool results have no size limit, risking context exhaustion. (see origin: `docs/brainstorms/2026-04-12-vesper-v03-requirements.md`)

## Requirements Trace

- R1. Signal file names in YAML `signals` section with defaults
- R2. Remove `VESPER_SIGNAL_*` env var support entirely
- R3. Signal path validation preserved (must resolve inside cwd)
- R4. Stale signal file check at startup — exit 1 if any exist
- R5. Cleanup is caller's responsibility
- R6. Minimal default env for `run_command`: PATH, HOME, USER, LANG, TERM
- R7. Optional `command_env` config field — array of additional env var names
- R8. Missing env vars in `command_env` silently omitted
- R9. Optional `max_tool_result_size` config field (default 102400)
- R10. Truncation with notice: `[truncated: showing first <limit> bytes of <total> bytes]`
- R11. Truncation applies to read_file, list_files, run_command stdout/stderr

## Scope Boundaries

- No signal file cleanup by the binary
- No signal file watching/polling
- `command_env` is a string array, not key-value — values from parent env
- Truncation is byte-based, not token-based

## Context & Research

### Relevant Code and Patterns

- `src/signals.ts` — `getSignalPaths(cwd)` reads env vars, `resolveSignalPath` validates containment. Will be rewritten to read from config.
- `src/config.ts` — `AgentConfig` interface and `loadConfig`. New fields follow existing optional-with-defaults pattern.
- `src/tools.ts` — `runCommand` uses `Bun.spawn`. Will add env filtering and result truncation.
- `src/agent.ts` — calls `getSignalPaths(cwd)` at startup, `writeComplete`/`writeFailed`/`writeNeedsApproval` throughout. Signal functions need to accept config-derived paths instead of reading env vars.
- `src/index.ts` — entry point where stale signal check should be added (after config load, before agent run).
- `tests/signals.test.ts` — env var tests need to be replaced with config-based tests.

## Key Technical Decisions

- **Signal paths resolved from config, passed through**: `getSignalPaths` changes from reading env vars to accepting signal names from `AgentConfig`. The `writeComplete`/`writeNeedsApproval`/`writeFailed` functions change signature to accept pre-resolved `SignalPaths` instead of `cwd` — avoids re-resolving on every call and makes the single source of truth explicit.
- **Stale signal check in index.ts, not agent.ts**: The check runs once at startup before stdin is read or any API call is made. It belongs in the entry point, not the agent loop.
- **Minimal env via explicit construction**: Rather than cloning `process.env` and deleting sensitive keys (blocklist), construct a fresh env object with only the allowed keys (allowlist). The allowlist is: `PATH`, `HOME`, `USER`, `LANG`, `TERM` plus any keys in `command_env`.
- **Truncation at the tool function level**: Each tool function in `tools.ts` truncates its own result before returning. This keeps truncation close to the source and means `agent.ts` doesn't need to know about size limits.

## Open Questions

### Resolved During Planning

- **Truncation notice position**: Append to the end of truncated content, not prepend. The beginning of a file or command output is usually more informative.
- **list_files truncation**: Cap the serialized JSON string of the entries array. If truncated, the JSON is invalid — wrap the truncation so it returns `{ entries: [...partial...], truncated: true, total_entries: N }` instead.
- **Platform-specific env vars**: `PATH`, `HOME`, `USER` are POSIX. On macOS also need `TMPDIR`. Add it to the default set.

### Deferred to Implementation

- Whether `Bun.spawn` accepts a partial env object or needs explicit `undefined` for missing vars
- Exact behavior of `Bun.spawn` when `env` option is set (does it replace or merge with process.env?)

## Implementation Units

- [ ] **Unit 1: Move signal config to AgentConfig**

  **Goal:** Add `signals` section to YAML config, remove env var support, update all signal functions.

  **Requirements:** R1, R2, R3

  **Dependencies:** None

  **Files:**
  - Modify: `src/config.ts`
  - Modify: `src/signals.ts`
  - Modify: `src/agent.ts`
  - Modify: `src/index.ts`
  - Test: `tests/config.test.ts`
  - Test: `tests/signals.test.ts`

  **Approach:**
  - Add `signals: { complete: string; needs_approval: string; failed: string }` to `AgentConfig` with defaults
  - `loadConfig` parses the `signals` section, applies defaults, validates each is a string
  - `getSignalPaths` changes to accept signal names from config (not env vars) + cwd, returns resolved paths
  - `writeComplete`, `writeNeedsApproval`, `writeFailed` change signature to accept `SignalPaths` instead of `cwd`
  - Update `agent.ts` to pass `signalPaths` to all write functions
  - Update `index.ts` to use config-based signal paths in the early completion exit
  - Remove all `VESPER_SIGNAL_*` env var references
  - Update signal tests to use config objects instead of env vars

  **Patterns to follow:**
  - Existing optional config fields in `loadConfig` (e.g., `command_timeout`, `scratchpad`)

  **Test scenarios:**
  - Happy path: config with custom signal names → signals written to custom paths
  - Happy path: config with no signals section → defaults used
  - Error path: signal name with path traversal → VesperError thrown
  - Edge case: signal name as non-string → VesperError thrown
  - Integration: no `VESPER_SIGNAL_*` env var references remain in any source file

  **Verification:**
  - `grep -r VESPER_SIGNAL src/ tests/` returns zero matches
  - Signal tests pass with config-based paths

- [ ] **Unit 2: Stale signal check at startup**

  **Goal:** Exit 1 at startup if any signal file already exists.

  **Requirements:** R4, R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/index.ts`
  - Modify: `src/signals.ts` (add `checkStaleSignals` function)
  - Test: `tests/signals.test.ts`

  **Approach:**
  - Add `checkStaleSignals(paths: SignalPaths): string | null` to signals.ts — returns the path of the first stale signal found, or null
  - In `index.ts`, after config load and signal path resolution, call `checkStaleSignals`. If non-null, `exitWithError` with the stale path.
  - Check runs before stdin read and before the early completion check

  **Patterns to follow:**
  - Existing early-exit patterns in `index.ts` (config errors, system prompt missing)

  **Test scenarios:**
  - Happy path: no signal files exist → agent proceeds normally
  - Error path: `.vesper-complete` exists → exit 1 with message naming the file
  - Error path: `.vesper-failed` exists → exit 1
  - Error path: `.vesper-needs-approval` exists → exit 1
  - Edge case: multiple stale signals → reports the first one found

  **Verification:**
  - Binary refuses to start when a signal file exists in cwd

- [ ] **Unit 3: Minimal command environment**

  **Goal:** Pass only allowed env vars to child processes.

  **Requirements:** R6, R7, R8

  **Dependencies:** Unit 1 (for `command_env` config field)

  **Files:**
  - Modify: `src/config.ts` (add `command_env` field)
  - Modify: `src/tools.ts`
  - Test: `tests/config.test.ts`
  - Test: `tests/tools.test.ts`

  **Approach:**
  - Add `command_env: string[]` to `AgentConfig` (default `[]`)
  - In `runCommand`, build a minimal env object: start with `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR` from `process.env`, then add any keys from `command_env`
  - Pass `env` option to `Bun.spawn` — Bun replaces the default env when `env` is set
  - Missing env vars (in default set or command_env) are silently omitted

  **Patterns to follow:**
  - Existing `command_timeout` parameter threading from config through agent.ts to tools.ts

  **Test scenarios:**
  - Happy path: `env` command with default config → output contains PATH but not ANTHROPIC_API_KEY
  - Happy path: `command_env: ["CUSTOM_VAR"]` + `CUSTOM_VAR=hello` in parent → child sees CUSTOM_VAR
  - Edge case: `command_env: ["NONEXISTENT"]` → no error, var simply absent from child env
  - Error path: `command_env` as non-string-array → VesperError from config validation

  **Verification:**
  - `runCommand("env", [], cwd, 30, config)` output does not contain `ANTHROPIC_API_KEY`

- [ ] **Unit 4: Tool result size bounding**

  **Goal:** Truncate tool results that exceed the configured limit.

  **Requirements:** R9, R10, R11

  **Dependencies:** Unit 1 (for `max_tool_result_size` config field)

  **Files:**
  - Modify: `src/config.ts` (add `max_tool_result_size` field)
  - Modify: `src/tools.ts`
  - Test: `tests/config.test.ts`
  - Test: `tests/tools.test.ts`

  **Approach:**
  - Add `max_tool_result_size: number` to `AgentConfig` (default 102400)
  - Add a `truncateResult(content: string, limit: number): string` helper in `tools.ts`
  - Apply truncation to: `readFile` content, `listFiles` (cap entry count, return `{ entries, truncated, total_entries }` when truncated), `runCommand` stdout and stderr individually
  - Truncation notice appended: `\n[truncated: showing first <limit> bytes of <total> bytes]`
  - Thread `max_tool_result_size` from config through `agent.ts` to tool calls

  **Patterns to follow:**
  - Existing parameter threading: `command_timeout` flows config → agent → tools

  **Test scenarios:**
  - Happy path: small file (under limit) → returned in full, no truncation notice
  - Happy path: large file (over limit) → truncated with notice appended
  - Happy path: large command output → stdout and stderr each truncated independently
  - Edge case: file exactly at limit → no truncation
  - Edge case: file one byte over limit → truncated
  - Happy path: list_files with many entries → returns truncated entry list with `truncated: true` and `total_entries`

  **Verification:**
  - A 200KB file read with default 100KB limit returns ~100KB content + truncation notice

- [ ] **Unit 5: Update built-in configs and README**

  **Goal:** Update .vesper/ configs to use new signal fields and document v0.3 features.

  **Requirements:** Success criteria

  **Dependencies:** Units 1-4

  **Files:**
  - Modify: `.vesper/planner.yml`
  - Modify: `.vesper/builder.yml`
  - Modify: `.vesper/reviewer.yml`
  - Modify: `README.md`

  **Approach:**
  - Add `signals` section to each config (can use defaults, shown explicitly for documentation)
  - Add `command_env: []` to builder config
  - Update README: signal file section (config-based, not env vars), command env section, truncation section, stale signal check behavior

  **Test expectation:** none — static config and docs

  **Verification:**
  - All three agents load without config errors
  - README accurately reflects new behavior

## System-Wide Impact

- **Interaction graph:** Signal paths now flow from config → agent.ts → signal write functions. The env var pathway is removed entirely. `index.ts` gains a startup check that can abort before the agent loop.
- **Error propagation:** Stale signal check is a hard exit (code 1) before any API call. This is a new failure mode callers must handle.
- **State lifecycle risks:** Signal files are now write-once per run with a pre-run existence check. No risk of overwriting stale signals — the binary refuses to run.
- **API surface parity:** `runCommand` changes signature (adds `commandEnv` parameter). Tool functions gain a `maxResultSize` parameter.
- **Unchanged invariants:** Permission model, completion model, token budget, and iteration loop are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `Bun.spawn` with explicit `env` may behave differently than inherited env | Test with `env` command to verify only expected vars are present |
| Removing env var signal support is a breaking change | v0.3 is a clean break; document in README |
| Truncation of `list_files` produces invalid JSON if done naively | Return structured `{ entries, truncated, total_entries }` instead of truncating raw JSON |
| Some commands may need env vars not in the default set | `command_env` config field provides the escape hatch |

## Documentation / Operational Notes

- README must be updated to remove env var signal documentation
- Breaking change: `VESPER_SIGNAL_*` env vars no longer work — operators must move signal names to YAML config
- New startup behavior: stale signal files cause immediate exit — callers must clean up between runs

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-12-vesper-v03-requirements.md`
- Existing code: `src/signals.ts`, `src/tools.ts`, `src/config.ts`, `src/agent.ts`, `src/index.ts`
