# Vesper

A permission-gated AI agent runtime. Single binary, structural safety — agents cannot exceed their permitted tool surface regardless of what the LLM reasons or decides.

## Install

```sh
brew install hl/tap/vesper
```

Or build from source (requires [Bun](https://bun.sh)):

```sh
bun install
make build
```

## Quick Start

```sh
vesper init
```

This scaffolds a `.vesper/` directory with an example agent config and system prompt. Copy and edit them to create your own agent:

```sh
cp .vesper/agents/example.yml .vesper/agents/builder.yml
cp .vesper/system_prompts/example.md .vesper/system_prompts/builder.md
```

Then run:

```sh
echo "Implement the auth module" | vesper run builder
```

Or pass the task entirely as command-line arguments:

```sh
vesper run builder Implement the auth module
vesper run builder --task "Implement the auth module"
```

If no command-line task is provided, the task prompt is read from stdin. `vesper <agent>` also works as a shorthand for `vesper run <agent>`.

## Agent Configuration

Each agent is defined by a YAML config in `.vesper/agents/` and a system prompt in `.vesper/system_prompts/`. The `system_prompt` path is relative to `.vesper/`.

See the example config scaffolded by `vesper init` for all available keys with comments, or the [builder config](.vesper/agents/builder.yml) for a real-world example.

**Required keys:** `system_prompt`, `token_budget`, `tools`.

## Directory Structure

```
.vesper/
  agents/            # Agent YAML configs (<name>.yml)
  system_prompts/    # System prompt Markdown files
  skills/            # Skill .md files injected at startup
  memories/          # Agent-written memory files
  CLAUDE.md          # Agent-facing guide to project conventions
```

Global agents at `~/.config/vesper/` follow the same layout. Local agents take priority.

## Concepts

**Tools** — Six file/command tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command` — each gated by glob patterns in the agent config. Plus a `signal` tool (always available) for explicit exit control.

**Permissions** — Allow-list only. File paths are resolved through symlinks via `realpathSync`. Commands match binary name, optionally with first argument. Agents with no permissions for a tool category never see that tool in the API call.

**Skills** — Markdown files in a configured directory, injected into every iteration as read-only context. Set `skills: ".vesper/skills"` in the agent config.

**Scratchpad** — A file the agent reads at the start of each iteration and writes to during execution. Persists state across iterations without conversation carry-forward.

**Context Management** — Three-layer system to stay within the model's context window. A pre-call guard estimates token usage and triggers pruning (replaces old tool results with compact stubs) and compaction (summarizes the conversation via an extra API call). Configured via `context_management:` in the agent YAML.

**Completion** — Agent exits when it stops calling tools or exhausts its token budget. `default_signal` controls what's written on exit (`complete` or nothing); agents can override by calling the `signal` tool.

**Signals** — `.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed`. Configurable names. The binary refuses to start if stale signals exist.

## Built-in Agents

This repo ships four example agents you can copy and adapt:

| Agent | Role |
|-------|------|
| `builder` | Implements tasks from a queue |
| `planner` | Processes specs, produces task queues |
| `reviewer` | Reviews implementation, writes reports |
| `scribe` | Documents learnings after plan execution |

## CLI Reference

```
vesper run <agent> [prompt..]
                      Run a named agent (task from args or stdin)
vesper run <agent> --task <prompt>
                      Run a named agent with an explicit task prompt
vesper init           Scaffold .vesper/ directory
vesper init --global  Scaffold ~/.config/vesper/ for shared agents
vesper init --force   Overwrite existing example files
vesper --version      Print version
vesper --help         Show help
```

## Documentation

Detailed guides are in [`docs/guide/`](docs/guide/):

- [Configuration Reference](docs/guide/configuration.md) — every YAML key, types, defaults, validation
- [Permissions](docs/guide/permissions.md) — path globs, command matching, structural safety
- [Tools](docs/guide/tools.md) — each tool's parameters, returns, and error modes
- [Context Management](docs/guide/context-management.md) — pruning, compaction, token estimation
- [Signals](docs/guide/signals.md) — signal files, stale checks, orchestrator integration
- [Skills and Scratchpad](docs/guide/skills-and-scratchpad.md) — persistent context across runs
- [CLI Reference](docs/guide/cli.md) — commands, flags, exit codes, stdin usage
- [Troubleshooting](docs/guide/troubleshooting.md) — common errors and fixes

## Development

```sh
make check      # typecheck + lint + test
make build      # compile binary
make test       # run tests only
make format     # auto-format
```
