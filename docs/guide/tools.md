# Tools

Vesper provides six file/command tools gated by the permission arrays in the agent config, plus a `signal` tool that is always available. Tools not permitted are excluded from the API call entirely.

## read_file

Read the contents of a file.

**Permission:** `tools.read`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path relative to cwd |

**Returns:**

```json
{ "content": "file contents here" }
```

If the file exceeds `max_tool_result_size`, the content is truncated and a marker is appended.

**Errors:**

```json
{ "error": "not_found" }
{ "error": "permission_denied" }
```

## list_files

List entries in a directory.

**Permission:** `tools.read`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Directory path relative to cwd |

**Returns:**

```json
{ "entries": ["file1.ts", "file2.ts", "subdir/"] }
```

If the result exceeds `max_tool_result_size`, it truncates the entry list and sets:

```json
{ "entries": ["..."], "truncated": true, "total_entries": 500 }
```

**Errors:**

```json
{ "error": "not_found" }
{ "error": "permission_denied" }
```

## write_file

Create or overwrite a file. Parent directories are created automatically.

**Permission:** `tools.write`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path relative to cwd |
| `content` | string | File contents |

**Returns:**

```json
{ "ok": true }
```

**Errors:**

```json
{ "error": "permission_denied" }
```

## patch_file

Apply a unified diff patch to an existing file.

**Permission:** `tools.write`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path relative to cwd |
| `patch` | string | Unified diff format |

**Returns:**

```json
{ "ok": true }
```

**Errors:**

```json
{ "error": "not_found" }
{ "error": "patch_failed", "detail": "Hunk #1 failed" }
{ "error": "permission_denied" }
```

## delete_file

Delete a file.

**Permission:** `tools.delete`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path relative to cwd |

**Returns:**

```json
{ "ok": true }
```

**Errors:**

```json
{ "error": "not_found" }
{ "error": "permission_denied" }
```

## run_command

Execute a shell command.

**Permission:** `tools.commands`

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Binary name |
| `args` | string[] | Command arguments |

**Returns:**

```json
{ "stdout": "...", "stderr": "...", "exit_code": 0 }
```

**Behavior:**

- Times out after `command_timeout` seconds (default: 30). Sends `SIGTERM`, then `SIGKILL` after 5 seconds. Exit code `124` on timeout.
- Output truncated to `max_tool_result_size`.
- Environment restricted to `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR` plus any keys in `command_env`.
- Exit code `127` if the binary cannot be found.

**Errors:**

```json
{ "error": "permission_denied" }
```

## signal

Signal Vesper how to exit this invocation. Always available to all agents — bypasses permission filtering because it has no I/O and no safety surface.

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | `"complete"` \| `"needs_approval"` \| `"failed"` | Signal type to write on exit |
| `message` | string (optional) | Context for `needs_approval` or `failed`. Ignored for `complete`. |

**Returns:**

```json
{ "ok": true }
```

The signal is recorded but not written to disk immediately. The actual signal file is written when the agent exits. If the agent calls `signal` multiple times, the last call wins.

If the agent doesn't call `signal`, the `default_signal` config controls exit behavior (see [Signals](signals.md)).

## Tool Result Truncation

All tool results are capped at `max_tool_result_size` bytes (default: 100KB). When truncated:

- `read_file` appends a truncation marker to the content
- `list_files` reduces the entry count and sets `truncated: true`
- `run_command` truncates stdout/stderr independently
