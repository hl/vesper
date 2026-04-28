# Permissions

Vesper enforces permissions structurally: tools are filtered from the API call entirely if the agent has no permissions for that category. The model never sees tools it can't use.

## Path Permissions

File tools (`read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`) are gated by glob patterns in the agent config:

```yaml
tools:
  read:
    - "src/**"
    - "docs/**"
    - "README.md"
  write:
    - "src/**"
  delete:
    - "src/generated/**"
```

### Matching

Paths are matched using [minimatch](https://github.com/isaacs/minimatch) globs against the resolved path relative to the working directory.

**Two-stage check:**

1. **Lexical check** — resolve the path relative to cwd, verify it doesn't escape via `..`
2. **Real path check** — resolve symlinks via `realpathSync`, verify the real path is inside the real cwd

Both checks must pass. This prevents symlink-based escapes.

### Common Patterns

| Pattern | Matches |
|---------|---------|
| `"**"` | Everything under cwd |
| `"src/**"` | Everything under `src/` |
| `"*.md"` | Markdown files in the root directory |
| `"**/*.test.ts"` | Test files anywhere |
| `"docs/plans/queue.md"` | A single specific file |

### Empty Arrays

An empty array disables the tool category entirely:

```yaml
tools:
  read:
    - "**"
  write: []      # write_file and patch_file are removed from the API call
  delete: []     # delete_file is removed from the API call
  commands: []   # run_command is removed from the API call
  subagents: []  # subagent and Task are removed from the API call
```

### Non-Existent Write Targets

When writing to a path that doesn't exist yet, Vesper walks up to the nearest existing ancestor directory, resolves it, and verifies the reconstructed path is still inside cwd. This allows creating new files and nested directories within permitted paths.

## Command Permissions

Commands are matched by binary name, optionally with the first argument:

```yaml
tools:
  commands:
    - "git commit"    # Allows: git commit -m "msg". Denies: git push
    - "bun"           # Allows: bun test, bun install, bun run, etc.
    - "npm test"      # Allows: npm test. Denies: npm install
```

### Matching Rules

- Each entry is at most 2 tokens: `binary` or `binary subcommand`
- `"git commit"` matches any `git` call where the first argument is `commit`
- `"git"` matches any `git` call regardless of arguments
- Config validation rejects entries with more than 2 tokens

### Environment

Commands run with a restricted environment. Only these variables are passed by default:

- `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`

Additional variables can be allowed via `command_env`:

```yaml
command_env:
  - "DATABASE_URL"
  - "NODE_ENV"
```

## Sub-Agent Permissions

Sub-agent dispatch is gated by exact configured agent names:

```yaml
tools:
  subagents:
    - "reviewer"
    - "researcher"
```

When `tools.subagents` is non-empty, Vesper exposes `subagent` and the Claude-style `Task` compatibility alias. A parent agent can only call listed agents. The called sub-agent then runs with its own config and permissions.

## Permission Denials

When a tool call is denied, the response depends on `reveal_permissions`:

**`reveal_permissions: false`** (default):
```json
{ "error": "permission_denied" }
```

**`reveal_permissions: true`**:
```json
{
  "error": "permission_denied",
  "tool": "write_file",
  "target": "config/secrets.yml",
  "allowed_patterns": ["src/**", "tests/**"]
}
```

Set `log_denied_calls: true` to log denials to stderr for debugging.
