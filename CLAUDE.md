# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Vesper

Vesper is an agent runtime that executes Claude-based agents with structural safety guarantees. Agents are defined as YAML config + Markdown system prompt pairs. The runtime enforces file and command permissions via glob allow-lists, tracks completion via watch files, manages token budgets, and communicates results through signal files. It compiles to a single native binary.

## Commands

```bash
make check       # typecheck + lint + test (also runs as pre-commit hook)
make build       # compile: bun build src/index.ts --compile --outfile vesper
make test        # bun test
make typecheck   # bunx tsc --noEmit
make lint        # bunx biome lint .
make format      # bunx biome format --write .
bun test tests/agent.test.ts              # run a single test file
bun test --test-name-pattern "pattern"    # run tests matching a pattern
```

## Architecture

**Runtime:** Bun (package manager, test runner, compiler). No Node.js required.

**Source layout** (`src/`):
- `index.ts` — CLI entry point. Parses args (yargs), resolves agent config, does early completion check, reads task prompt from stdin, hands off to `runAgent`.
- `agent.ts` — Core loop. Each **iteration** is a fresh API conversation (no context carry-forward by design). Within an iteration, tool calls loop until the model stops requesting tools. After each iteration, checks completion status.
- `config.ts` — Loads and validates YAML agent configs. Agent resolution searches `.vesper/` in cwd first, then `~/.config/vesper/`.
- `permissions.ts` — Path permission uses `minimatch` globs against the real (symlink-resolved) path relative to cwd. Command permission matches binary name, optionally with first argument.
- `tools.ts` — Six tool implementations: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`. Results are truncated to `max_tool_result_size`.
- `completion.ts` — `CompletionTracker` monitors watch file line count across iterations. Empty/missing = complete. No change for N iterations = no_progress.
- `signals.ts` — Writes `.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed` files.
- `logger.ts` — JSONL event stream to stderr when `log_events` is enabled.

**Key design decisions:**
- Fresh context per iteration (not per tool call). Agents persist state through the scratchpad file, not conversation history.
- Permission enforcement is structural, not instructional — tools are filtered from the API call entirely if the agent has no permissions for that category.
- Symlink resolution on all path checks to prevent escapes.
- `cache_control: { type: "ephemeral" }` is applied to the system prompt block and the last tool definition for prompt caching.

## Code Conventions

- **Formatting:** Biome with 2-space indent, 100-char line width. Run `make format` to fix.
- **Strict TypeScript:** `strict: true` in tsconfig. All source and test files are type-checked.
- **Tests:** One test file per source module in `tests/`. Tests use `mkdtempSync` for isolated temp directories. The `MessageClient` interface in `agent.ts` enables API stubbing.
- **No default exports.** All exports are named.
- **Error type:** `VesperError` with exit code for user-facing errors.

## Agent Config Schema

Agent definitions live in `.vesper/` as `<name>.yml` + `<name>.md` pairs. Required fields: `system_prompt`, `token_budget`, `tools` (with at least one non-empty category), `completion`. See `.vesper/builder.yml` for a full example.
