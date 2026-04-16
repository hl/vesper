# CLI Reference

## Usage

```
vesper [--cwd <path>] <command>
```

## Commands

### `vesper run <agent>`

Run a named agent. The task is read from stdin.

```sh
echo "Implement the auth module" | vesper run builder
```

`vesper <agent>` is shorthand for `vesper run <agent>`:

```sh
echo "Review the PR" | vesper reviewer
```

Agent configs are resolved from `.vesper/agents/<agent>.yml` locally, then `~/.config/vesper/agents/<agent>.yml` globally.

Reserved names that cannot be used as agent names: `init`, `run`, `help`, `version`.

### `vesper init`

Scaffold a `.vesper/` directory with example files.

```sh
vesper init
```

Creates:

```
.vesper/
  agents/example.yml
  system_prompts/example.md
  skills/
  memories/
  CLAUDE.md
```

Also appends signal file patterns to `.gitignore`.

**Flags:**

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing example files |
| `--global` | Scaffold `~/.config/vesper/` instead of `.vesper/` |

Global init skips the `memories/` directory and `.gitignore` updates.

Existing files are preserved unless `--force` is specified. Symlinks on any target path are rejected even with `--force`.

## Global Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Set working directory (default: current directory) |
| `--version` | Print version |
| `--help` | Show help |

## Environment

Vesper requires an `ANTHROPIC_API_KEY` environment variable for the Claude API.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Completed successfully, or stopped by token budget / approval |
| `1` | Error: config invalid, system prompt missing, API failure, context overflow, stale signals |

## Stdin

The task prompt is always read from stdin. If stdin is empty or not connected, the agent receives an empty task.

Pipe from files, heredocs, or other commands:

```sh
# From a file
vesper run builder < tasks/auth.md

# From a heredoc
vesper run builder <<'EOF'
Implement user authentication with JWT tokens.
Use the existing User model in src/models/.
EOF

# From another command
cat spec.md | vesper run planner
```
