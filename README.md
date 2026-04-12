# Vesper

A CLI binary that loads named agent personas and runs them against the Anthropic API with structural permission enforcement.

Safety boundaries are structural, not instructional. An agent cannot exceed its permitted tool surface regardless of what the LLM reasons or decides.

## Install

Requires [Bun](https://bun.sh) (latest stable).

```sh
bun install
make build
```

Produces a single native binary named `vesper`.

## Usage

```sh
echo "Implement the feature described in docs/specs/auth.md" | vesper builder
cat prompts/build.md | vesper builder --cwd ./backend
```

The task prompt is read from stdin. The binary blocks until stdin is closed.

## Agent Definition

Each agent is defined by two files in `.vesper/` (or `~/.config/vesper/`):

**`<agent>.yml`** — structural constraints:

```yaml
system_prompt: builder.md
token_budget: 100000
model: claude-sonnet-4-5-20250514  # optional, default: claude-sonnet-4-5-20250514
log_denied_calls: false
log_events: false
reveal_permissions: false
command_timeout: 30                # seconds, default: 30
scratchpad: docs/plans/.scratchpad-builder.md  # optional

tools:
  read:
    - "src/**"
    - "docs/**"
  write:
    - "src/**"
    - "test/**"
  delete:
    - "src/**"
  commands:
    - "git commit"
    - "mix test"

completion:
  watch_file: "docs/plans/task-queue.md"
  no_progress_limit: 3
```

**`<agent>.md`** — system prompt, passed verbatim to the API.

## Config Resolution

1. `<cwd>/.vesper/<agent>.yml` + `<cwd>/.vesper/<agent>.md`
2. `~/.config/vesper/<agent>.yml` + `~/.config/vesper/<agent>.md`

Both files must exist at the same location.

## Permission Model

All permissions are allow-lists enforced by the runtime before any tool result reaches the LLM.

- **File operations** — glob patterns matched via minimatch. Paths resolving outside `cwd` are always denied. Symlinks are resolved via `realpathSync` before matching.
- **Commands** — single-token entries (`mix`) match the binary with any arguments. Two-token entries (`mix test`) match binary + first argument.
- **Denial** — returns `{ error: "permission_denied" }` by default. Set `reveal_permissions: true` for structured denial messages with the tool name, target path, and allowed patterns.

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read a file (gated by `tools.read`) |
| `list_files` | List a directory (gated by `tools.read`) |
| `write_file` | Write/create a file (gated by `tools.write`) |
| `patch_file` | Apply a unified diff (gated by `tools.write`) |
| `delete_file` | Delete a file (gated by `tools.delete`) |
| `run_command` | Run a shell command (gated by `tools.commands`) |

## Completion Model

- **Watch file configured** — empty or missing file means complete. Line count unchanged for `no_progress_limit` iterations means failed.
- **No watch file** — agent runs until token budget or max iterations (1000), then writes complete signal.

## Signal Files

Signal files communicate status to the caller. Names are set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `VESPER_SIGNAL_COMPLETE` | `.vesper-complete` | Clean completion |
| `VESPER_SIGNAL_NEEDS_APPROVAL` | `.vesper-needs-approval` | Token budget exhausted |
| `VESPER_SIGNAL_FAILED` | `.vesper-failed` | Error or no progress |

## Observability

Set `log_events: true` in the agent config to emit JSONL events to stderr:

- `iteration_start` — iteration number
- `api_call` — model, tokens, latency
- `tool_call` — tool name, target, permitted/denied, duration
- `completion_check` — status
- `signal_write` — signal type, path

Each line includes a `run_id` (UUID) and ISO 8601 `timestamp`.

## Scratchpad

Set `scratchpad: <path>` in the agent config. The runtime reads the file at the start of each iteration and injects its contents before the task prompt as a `[Previous Context]` block. The agent writes to the scratchpad via normal `write_file` calls. The runtime never writes it.

## Built-in Agents

| Agent | Role | Watch file |
|-------|------|------------|
| `planner` | Processes spec queue, produces task queue | `docs/plans/spec-queue.md` |
| `builder` | Implements tasks from the queue | `docs/plans/task-queue.md` |
| `reviewer` | Reviews implementation, writes report | None (runs to limit) |

## Development

```sh
make check      # typecheck + lint + test
make build      # compile binary
make test       # run tests only
make typecheck  # type-check only
make lint       # lint only
make format     # auto-format
```
