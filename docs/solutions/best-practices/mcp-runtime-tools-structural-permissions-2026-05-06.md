---
title: MCP Runtime Tools with Structural Permissions
date: 2026-05-06
track: knowledge
category: best-practices
tags: [agent-runtime, mcp, permissions, external-tools, env-sanitization, result-shaping]
spec: docs/specs/mcp-runtime-tools.md
module: src/mcp.ts
---

# MCP Runtime Tools with Structural Permissions

## Context

MCP servers let an agent runtime reach external systems without shelling out through ad hoc
commands. That creates a broader executable and side-effect surface than file tools, so Vesper
models MCP support as a first-class runtime tool surface with explicit config, exact grants,
environment filtering, result shaping, and startup failure behavior.

The key decision is to separate MCP server launch configuration from MCP tool grants. A server can
exist in `mcp_servers`, but Vesper starts it only when `tools.mcp_read` or `tools.mcp_write`
references at least one exact `<server>.<tool>` grant.

## Guidance

Use these rules when adding MCP tools to an agent runtime:

- Require `allow_launch: true` on every configured stdio server so executable startup is explicit.
- Start only referenced servers, before the first model API call.
- Initialize the MCP server, list its tools, and expose only exact granted `<server>.<tool>` names.
- Split grants into `tools.mcp_read` and `tools.mcp_write`; do not infer side effects from tool
  names or descriptions.
- Normalize model-visible names as `mcp__<server>__<tool>` and reject collisions before the model
  sees tools.
- Validate granted tool schemas before the first API call; fail closed on missing, non-object, or
  provider-incompatible schemas.
- Launch MCP processes with the same safe baseline environment as commands plus only the
  server-specific `env` allow-list.
- Return MCP tool execution and protocol errors as tool-result content so one failed tool call does
  not abort the parent tool loop.
- Shape model-facing results into stable JSON before truncation.
- Close stdin and terminate started MCP servers in `finally` after the agent run.

The concrete implementation is in `src/mcp.ts` and is wired into `runAgent` in `src/agent.ts`.

## Why This Matters

MCP tools often touch external state: tickets, repositories, browsers, documents, cloud systems, or
internal services. Treating them as "just another model tool" without structural grants would bypass
the safety posture used for files and commands.

This pattern preserves the important guarantees:

- A malformed or untrusted MCP server cannot silently add tool capabilities to the model-visible
  surface.
- Ambient secrets do not leak into MCP subprocesses unless explicitly allow-listed.
- Read and write grants remain auditable in agent YAML.
- Tool result content is predictable for context pruning and downstream model turns.

## When to Apply

Apply this pattern when:

- An agent runtime launches local stdio MCP servers.
- MCP tools can read or mutate external systems.
- The model provider has schema restrictions that must be checked before tool advertisement.
- You need deterministic startup failure before any model call if integration setup is invalid.

Defer or separate work for MCP resources, prompts, remote transports, sampling requests, or human
confirmation flows; those have different permission boundaries.

## Examples

Config:

```yaml
mcp_servers:
  jira:
    command: "bun"
    args: ["jira-mcp.mjs"]
    env: ["JIRA_TOKEN"]
    allow_launch: true

tools:
  mcp_read: ["jira.search"]
  mcp_write: ["jira.comment"]
```

Successful model-facing result:

```json
{
  "ok": true,
  "server": "jira",
  "tool": "search",
  "content": [{ "type": "text", "text": "..." }],
  "structured_content": null,
  "is_error": false
}
```

Permission denial with `reveal_permissions: true`:

```json
{
  "error": "permission_denied",
  "tool": "mcp__jira__delete_issue",
  "allowed_mcp_read": ["jira.search"],
  "allowed_mcp_write": ["jira.comment"]
}
```

## Related

- `docs/specs/mcp-runtime-tools.md`
- `src/mcp.ts`
- `src/agent.ts`
- `tests/agent.test.ts`
- `tests/config.test.ts`
- `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`
