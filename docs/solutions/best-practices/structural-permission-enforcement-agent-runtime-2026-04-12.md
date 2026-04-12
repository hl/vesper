---
title: "Structural Permission Enforcement in Agent Runtimes"
date: 2026-04-12
category: best-practices
module: agent-runtime
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Building an agent runtime that gives LLMs file system access"
  - "Spawning subprocesses from LLM-directed tool calls"
  - "Running multi-agent pipelines where one agent's output feeds another"
  - "Operating agents in environments with ambient credentials"
tags:
  - agent-runtime
  - permissions
  - security
  - llm-tools
  - path-traversal
  - symlink-escape
  - env-sanitization
  - result-truncation
---

# Structural Permission Enforcement in Agent Runtimes

## Context

The standard approach to giving LLMs tool access relies on instructional constraints: system prompts that say "only access files within the project directory" or "do not run dangerous commands." These constraints are brittle. A sufficiently long reasoning chain, injected content in retrieved documents, or adversarial user input can override them. The LLM is simultaneously the actor being constrained and the reasoner evaluating whether to comply.

Vesper inverts this: the runtime — not the prompt — enforces tool boundaries. The LLM never sees a permission check; it receives an opaque `{"error":"permission_denied"}` when it reaches outside its declared surface. The permission surface is declared in YAML, validated at startup, and enforced in code before any result returns to the model.

This pattern emerged through building Vesper v0.1–v0.3, with security hardening driven by iterative code review that surfaced attack vectors (symlink escape, env secret exfiltration, context exhaustion) that the initial implementation missed.

## Guidance

The structural permission enforcement pattern has eight interlocking components:

### 1. Allow-list YAML config

Each agent gets a config file declaring exactly what it can read, write, delete, and execute. Nothing is implicit. Types are validated at load time with hard errors — the process will not start with a malformed config.

```yaml
tools:
  read:   ["src/**/*.ts", "tests/**/*.ts"]
  write:  ["src/**/*.ts"]
  delete: []
  commands: ["tsc", "bun test"]
command_env: ["NODE_ENV"]
max_tool_result_size: 51200
```

### 2. Runtime permission gate — opaque denial

Every tool call passes through `executeTool` which checks permissions before calling any tool implementation. The LLM receives either the tool result or `{"error":"permission_denied"}` with no detail about why or what the allow-list contains. An optional `reveal_permissions: true` flag exposes patterns for debugging.

### 3. Path jail with realpathSync — symlink escape prevention

A lexical path check (`path.resolve`) is insufficient. A symlink inside cwd can point outside the jail. Two checks run in sequence:

1. **Lexical check** — catches obvious `../..` escapes cheaply
2. **Symlink resolution** — `realpathSync` on both path and cwd, then re-check containment

For non-existent write targets, the parent directory is canonicalized and the filename appended. (session history) This approach has an inherent TOCTOU window — a symlink could be modified between the check and the file operation — but closing it requires kernel-level sandboxing (`O_NOFOLLOW`/`openat`), which is infeasible in user-space TypeScript.

### 4. Minimal command environment — allowlist, not blocklist

Child processes receive only `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR` by default. Additional keys are opt-in via `command_env` in the config. Everything not listed is stripped. This prevents accidental secret exfiltration (e.g., `ANTHROPIC_API_KEY`) through command stdout/stderr.

(session history) The initial implementation inherited the full `process.env`. This was flagged during v0.1 review as an advisory and accepted temporarily. By v0.3 it became a hard requirement after recognizing that any network-capable allowed command (`git`, `curl`) could read and transmit secrets.

### 5. Tool result truncation

All results are bounded by `max_tool_result_size` (default 100KB). Truncation preserves UTF-8 character boundaries via `Buffer.subarray` and appends a notice: `[truncated: showing first N bytes of M bytes]`. For directory listings, a binary search finds the maximum entry count that fits.

### 6. Tool filtering — only advertise usable tools

Before each API call, tool definitions are filtered to include only tools the agent has permission to use. A reviewer agent with `delete: []` and `commands: []` never sees `delete_file` or `run_command` in its tool list. This reduces context window cost and prevents the model from attempting calls that will be denied.

### 7. Config-based signal files with stale-check

Signal file paths are declared in config, resolved through the same jail logic as regular paths, and checked for staleness at startup. A stale signal from a previous run causes immediate exit (code 1) before any API call. Cleanup is the caller's responsibility.

(session history) Signal file naming started as env vars (`VESPER_SIGNAL_*`), which was inconsistent with the YAML-first config model. Moved to config-only in v0.3.

### 8. Fresh context per iteration with runtime-injected scratchpad

Each iteration sends a fresh conversation — messages do not accumulate across iterations. This prevents context poisoning from previous tool results and bounds per-call cost. If a scratchpad is configured, its contents are injected at the top of the user message. The scratchpad path is validated against cwd before reading — a misconfigured path cannot read arbitrary files.

(session history) The scratchpad started as a system prompt convention (agents were instructed to read/write it manually). It was promoted to a runtime feature in v0.2 after recognizing that relying on LLM compliance for continuity was fragile.

## Why This Matters

Instructional constraints work until something in the reasoning chain overrides them. Structural enforcement holds regardless:

- **Auditable**: the full permission declaration is in one YAML file per agent, no hidden defaults
- **Testable**: `checkPathPermission` is a pure function that can be unit-tested against every escape pattern without running a model
- **Tamper-proof**: the LLM cannot modify its own config, cannot instruct the runtime to skip checks, and receives no information about the allow-list (by default)

The evolution of Vesper across versions reflects the hardening progression: v0.1 introduced the structural check; v0.2 added observability and cost control; v0.3 closed the remaining attack surface (env sanitization, result bounding, signal path validation).

## When to Apply

- Building any agent runtime that gives LLMs access to file systems, command execution, or external services
- Multi-agent pipelines where one agent's output becomes another's input — injected content cannot override structural enforcement
- Environments with ambient credentials (CI/CD, developer machines, cloud instances)
- Any scenario where the cost of a permission bypass exceeds the cost of implementing the check

## Examples

**Permission check flow — three-layer defense:**
```
LLM calls read_file("../../.env")
  → executeTool: getPermissionList("read_file") → {type:"path", list:["src/**"]}
  → checkPathPermission("../../.env", cwd, ["src/**"])
      → lexical: resolve → /etc/.env → outside cwd → denied
  → LLM receives: {"error":"permission_denied"}
```

**Symlink escape — why realpathSync matters:**
```
/project/src/escape → /etc  (symlink)

LLM calls read_file("src/escape/passwd")
  → lexical resolve: /project/src/escape/passwd → passes (inside cwd)
  → realpathSync: → /etc/passwd → outside realCwd → denied
```

**Environment sanitization — before vs. after:**
```
Before:  Bun.spawn(["git", "push"], { cwd })
         // inherits GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, DATABASE_URL...

After:   Bun.spawn(["git", "push"], { cwd, env: buildCommandEnv(["NODE_ENV"]) })
         // only PATH, HOME, USER, LANG, TERM, TMPDIR, NODE_ENV
```

**Command permission — binary + first-arg matching:**
```
commands: ["bun test"]
  bun test            → allowed
  bun test --only e2e → allowed (additional args ok)
  bun run malicious   → denied (first arg doesn't match)
```

## Related

- Vesper source: `src/permissions.ts`, `src/agent.ts`, `src/tools.ts`, `src/config.ts`
- Vesper README: project documentation with full config reference
- Anthropic tool use docs: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
