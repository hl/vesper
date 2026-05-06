---
title: MCP runtime tools
status: done
---

## Context

Vesper currently exposes a fixed runtime tool surface: file reads, file writes, file deletion,
command execution, sub-agent dispatch, and `signal`. Agents cannot use external MCP servers unless
they shell out through an allowed command. That keeps the permission model small, but it prevents
agents from using structured integrations such as Jira, GitHub, browser automation, or internal
systems through the Model Context Protocol.

MCP defines a client-server protocol where a client initializes a connection, negotiates
capabilities, and can invoke server-provided tools. MCP servers can also expose resources and
prompts, but this spec covers tool calls only. Vesper should act as the MCP client, start configured
local stdio MCP servers, list available server tools, filter them through agent YAML, and expose
only allowed MCP tools to the model.

Vesper's safety model remains structural. MCP servers are external executables and MCP tools can
read or mutate external systems, so MCP support must not bypass Vesper's existing permission,
environment, result-size, logging, and context-management boundaries.

This spec is informed by:

- `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`
- MCP specification pages for base protocol, lifecycle, and tools.

## Goals

- Agent YAML can define local stdio MCP servers and explicitly grant MCP tool capabilities.
- Vesper starts only MCP servers that are explicitly launchable and have at least one granted tool.
- Vesper advertises only granted MCP tools to the model.
- MCP tool calls pass through the same denial, truncation, logging, and context-pruning patterns as
  built-in tools.
- MCP write-capable tools are separated from read-capable tools in config.

## Acceptance Criteria

1. `loadConfig` accepts an optional `mcp_servers` mapping whose server entries contain required
   `command` and `allow_launch` fields and optional `args` and `env` fields.
2. `loadConfig` rejects an `mcp_servers` entry when `command` is missing or not a string.
3. `loadConfig` rejects an `mcp_servers` entry when `args` is present and is not an array of
   strings.
4. `loadConfig` rejects an `mcp_servers` entry when `env` is present and is not an array of
   strings.
5. `loadConfig` rejects an `mcp_servers` entry when `allow_launch` is not exactly `true`.
6. `loadConfig` accepts optional `tools.mcp_read` and `tools.mcp_write` arrays, defaulting both to
   empty arrays when absent.
7. Vesper does not start an MCP server when no entry in `tools.mcp_read` or `tools.mcp_write`
   references that server name.
8. Vesper fails before the first model API call when an agent grants an MCP tool for a server that
   is not defined in `mcp_servers`.
9. Vesper starts a referenced MCP server with only the safe baseline command environment plus the
   environment variable names listed in that server's `env` array.
10. Vesper does not pass unlisted process environment variables to an MCP server.
11. Vesper initializes each started MCP server before listing tools.
12. Vesper fails before the first model API call when a started MCP server does not complete
    initialization within `command_timeout`.
13. Vesper lists tools from each initialized MCP server before the first model API call.
14. MCP grant entries in `tools.mcp_read` and `tools.mcp_write` use exact `<server>.<tool>` string
    matching; glob or minimatch patterns are not supported in this phase.
15. Vesper exposes an MCP tool to the model only when the tool's exact `<server>.<tool>` name is
    present in `tools.mcp_read` or `tools.mcp_write`.
16. Vesper treats any MCP tool grant in `tools.mcp_write` as write-capable.
17. Vesper treats an MCP server tool not granted by `tools.mcp_read` or `tools.mcp_write` as
    unavailable; the model does not see a tool definition for it.
18. Model-visible MCP tool names are normalized as `mcp__<server>__<tool>`.
19. Vesper rejects normalized MCP tool names that collide with built-in tool names or with another
    normalized MCP tool name before the first model API call.
20. MCP tool input schemas advertised to the model are passed through from the MCP server's
    `inputSchema` when they are JSON objects accepted by Vesper's configured model provider.
21. Vesper fails before the first model API call when a granted MCP tool has a missing,
    non-object, or provider-incompatible `inputSchema`.
22. When the model calls a normalized MCP tool name, Vesper dispatches the request to the original
    `{ server, tool }` pair.
23. When the model calls an MCP tool that is not in the normalized MCP tool map, Vesper returns
    `{"error":"permission_denied"}`.
24. With `reveal_permissions: true`, an MCP permission denial includes the denied normalized tool
    name and the configured MCP grant entries.
25. A successful MCP tool call returns model-facing JSON with this shape:
    `{ "ok": true, "server": "<server>", "tool": "<tool>", "content": [...], "structured_content": <object-or-null>, "is_error": false }`.
26. An MCP tool execution error reported by the server returns model-facing JSON with this shape:
    `{ "ok": false, "server": "<server>", "tool": "<tool>", "content": [...], "structured_content": <object-or-null>, "is_error": true }`.
27. An MCP protocol error returns model-facing JSON with this shape:
    `{ "ok": false, "server": "<server>", "tool": "<tool>", "error": { "code": <number-or-null>, "message": "<message>" }, "is_error": true }`.
28. Vesper preserves MCP text content blocks in `content` as `{ "type": "text", "text": "..." }`.
29. Vesper preserves MCP image, audio, and other non-text content blocks in `content` as JSON
    objects with their original fields.
30. Vesper preserves MCP `structuredContent` as `structured_content` when it is a JSON object and
    uses `null` when the MCP response has no `structuredContent`.
31. Vesper represents MCP `resource` and `resource_link` content returned from a tool call as
    JSON objects in `content` without fetching, subscribing to, or separately permission-checking
    the linked resource.
32. MCP tool results larger than `max_tool_result_size` are truncated before being added to the
    parent conversation.
33. MCP tool execution errors are returned to the model as tool result content rather than thrown
    out of the parent tool loop.
34. MCP protocol errors are returned to the model as tool result content rather than thrown out of
    the parent tool loop.
35. MCP startup and initialization errors write the failed signal and exit before the first model
    API call.
36. Structured logs emitted with `log_events: true` include MCP server startup, MCP tool calls,
    permission status, and duration.
37. Context-pruning stub metadata for MCP calls includes tool kind `mcp`, server name, tool name,
    success or error status, and post-truncation byte size.
38. Vesper closes each started MCP server's stdin during shutdown and sends `SIGTERM`, then
    `SIGKILL`, if the process does not exit within the configured timeout sequence.
39. `make check` passes after the implementation.

## Out Of Scope

- MCP resources and resource URI templates.
- MCP prompts.
- MCP sampling requests from servers back into Vesper's model client.
- HTTP, SSE, or remote MCP transports.
- MCP server registry discovery or plugin marketplace installation.
- Generic side-effect inference from MCP tool descriptions.
- Human confirmation prompts for MCP write tools.
- Parallel MCP tool execution.

## Open Questions

Open questions: none.
