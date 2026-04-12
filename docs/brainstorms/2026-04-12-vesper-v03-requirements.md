---
date: 2026-04-12
topic: vesper-v03
---

# Vesper v0.3 — Signal Config, Environment Safety, and Result Bounding

## Problem Frame

Vesper v0.2 has four residual issues identified during code review:

1. Signal file names are configured via environment variables, inconsistent with the YAML-first config model
2. Spawned commands inherit the full process environment, enabling secret exfiltration via tool results
3. Tool results (file contents, command output) have no size limit, risking context window exhaustion
4. Signal file cleanup between runs is undefined (resolved: caller's responsibility, not the binary's)

## Requirements

**Signal file configuration**

- R1. Signal file names move to the agent YAML config under a `signals` section with keys `complete`, `needs_approval`, and `failed`. Defaults: `.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed`.
- R2. Environment variable support (`VESPER_SIGNAL_*`) is removed entirely. Signal names come from config only.
- R3. Signal file path validation (must resolve inside cwd) is preserved.
- R4. At startup, before the first iteration, the binary checks whether any signal file (complete, needs_approval, failed) already exists. If any signal file is present, the binary exits immediately with code 1 and a message identifying the stale signal file. The caller is responsible for cleaning up signal files between runs.
- R5. Signal file cleanup is NOT the binary's responsibility. The binary only checks for their presence and refuses to run if they exist.

**Command environment safety**

- R6. `run_command` passes a minimal environment to child processes by default: `PATH`, `HOME`, `USER`, `LANG`, `TERM` only.
- R7. Agent YAML config accepts an optional `command_env` field — an array of additional environment variable names to pass through to child processes.
- R8. Variables listed in `command_env` are copied from the parent process environment. Variables not present in the parent env are silently omitted.

**Tool result size bounding**

- R9. Agent YAML config accepts an optional `max_tool_result_size` field in bytes (default 102400 — 100KB).
- R10. Tool results exceeding the limit are truncated. The truncated result includes a notice: `[truncated: showing first <limit> bytes of <total> bytes]`.
- R11. Truncation applies to `read_file` content, `list_files` entries (serialized), `run_command` stdout and stderr individually, and `patch_file` / `write_file` success responses (though these are tiny and won't hit the limit in practice).

## Success Criteria

- All existing 113 tests continue to pass
- Each new feature has dedicated test coverage
- `make check` passes
- `make build` produces a single binary
- Signal file tests updated to use config-based paths instead of env vars
- No `VESPER_SIGNAL_*` env var references remain in the codebase

## Scope Boundaries

- No signal file cleanup by the binary (caller's job)
- No signal file watching or polling by the binary
- `command_env` is a simple string array, not a key-value map — values come from the parent env
- Truncation is byte-based, not token-based — token estimation is deferred

## Key Decisions

- **Config only for signals, no env vars**: The YAML config is the single source of truth for agent behavior. Env vars created a split configuration surface that was hard to reason about and test. Orchestrators that need per-invocation signal names can generate agent YAML dynamically.
- **Minimal default env for commands**: Allowlist is safer than blocklist. Most commands need only PATH. Operators explicitly opt in to passing additional vars via `command_env`.
- **100KB default for tool result truncation**: Large enough for most source files and test output. Small enough to prevent a single result from consuming the entire context window. Configurable per-agent for agents that need to read larger files.

## Config Schema Additions

```yaml
signals:
  complete: ".vesper-complete"        # optional, default shown
  needs_approval: ".vesper-needs-approval"
  failed: ".vesper-failed"

command_env: []                       # optional, default: empty (minimal env only)
max_tool_result_size: 102400          # optional, default: 102400 (100KB)
```

## Outstanding Questions

### Resolve Before Planning

None.

### Defer to Implementation

- Exact list of minimal env vars (PATH, HOME, USER, LANG, TERM — may need platform-specific additions)
- Whether truncation notice should be prepended or appended to the truncated content
- How to handle `list_files` truncation when the entry list is very long (truncate the serialized JSON, or cap the entry count?)
