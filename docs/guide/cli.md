# CLI Reference

## Usage

```
vesper [--cwd <path>] run <agent> [prompt..]
vesper [--cwd <path>] <agent> [prompt..]
vesper [--cwd <path>] init
```

## Commands

### `vesper run <agent>`

Run a named agent. The task can be provided as command-line arguments:

```sh
vesper run builder Implement the auth module
vesper run builder --task "Implement the auth module"
```

If no command-line task is provided, Vesper reads the task from stdin:

```sh
echo "Implement the auth module" | vesper run builder
```

`vesper <agent>` is shorthand for `vesper run <agent>`:

```sh
vesper reviewer Review the PR
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

## Run Options

| Option | Description |
|--------|-------------|
| `--task <prompt>`, `-t <prompt>` | Provide the task prompt without reading stdin |

## Environment

Vesper reads provider API keys from the standard SDK environment variables:

| Provider | Required variable |
|----------|-------------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Completed successfully, or stopped by token budget / approval |
| `1` | Error: config invalid, system prompt missing, API failure, context overflow, stale signals |

## Task Input

The task prompt can come from command-line arguments or stdin. Command-line input takes precedence. If both `--task` and positional prompt words are provided, Vesper exits with an error.

Pass short prompts directly:

```sh
# Positional prompt words
vesper run builder Implement user authentication

# Explicit task option
vesper run builder --task "Implement user authentication with JWT tokens."
```

Pipe longer prompts from files, heredocs, or other commands:

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
