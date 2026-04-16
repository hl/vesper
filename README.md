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

The task prompt is read from stdin. `vesper <agent>` also works as a shorthand for `vesper run <agent>`.

## Agent Configuration

Each agent is defined by a YAML config in `.vesper/agents/` and a system prompt in `.vesper/system_prompts/`. The `system_prompt` path is relative to `.vesper/`.

See the example config scaffolded by `vesper init` for all available keys with comments, or the [builder config](.vesper/agents/builder.yml) for a real-world example.

**Required keys:** `system_prompt`, `token_budget`, `tools`, `completion`.

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

**Tools** — Six tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`. Each gated by glob patterns in the agent config.

**Permissions** — Allow-list only. File paths are resolved through symlinks via `realpathSync`. Commands match binary name, optionally with first argument. Agents with no permissions for a tool category never see that tool in the API call.

**Skills** — Markdown files in a configured directory, injected into every iteration as read-only context. Set `skills: ".vesper/skills"` in the agent config.

**Scratchpad** — A file the agent reads at the start of each iteration and writes to during execution. Persists state across iterations without conversation carry-forward.

**Context Management** — Three-layer system to stay within the model's context window. A pre-call guard estimates token usage and triggers pruning (replaces old tool results with compact stubs) and compaction (summarizes the conversation via an extra API call). Configured via `context_management:` in the agent YAML.

**Completion** — Watch file mode: empty/missing = complete, stable line count = no progress. No watch file: runs to token budget.

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
vesper run <agent>    Run a named agent (reads task from stdin)
vesper init           Scaffold .vesper/ directory
vesper init --global  Scaffold ~/.config/vesper/ for shared agents
vesper init --force   Overwrite existing example files
vesper --version      Print version
vesper --help         Show help
```

## Development

```sh
make check      # typecheck + lint + test
make build      # compile binary
make test       # run tests only
make format     # auto-format
```
