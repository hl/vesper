# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Core flow: CLI args + stdin → Config resolution → Agent loop (iteration × tool calls) → Signal files

## Workflow

1. Read any relevant docs in `docs/plans/` or `docs/brainstorms/` before implementing
2. Implement — one commit per logical unit of working, testable code
3. Run `make check` — all quality gates + tests
4. Fix any failures at the root cause
5. Commit: `type: description` (feat, fix, refactor, test, docs, chore)

## Quality Gates

Run `make check` (= typecheck + lint + test). Prefer this over running gates individually.

`make check` runs, in order:

1. `bunx tsc --noEmit` — strict TypeScript, zero errors
2. `bunx biome lint .` — lint src/ and tests/
3. `bun test` — full test suite

Single test: `bun test tests/agent.test.ts`
Pattern match: `bun test --test-name-pattern "pattern"`
Build binary: `make build` (`bun build src/index.ts --compile --outfile vesper`)
Auto-format: `make format` (`bunx biome format --write .`)

Pre-commit hook runs `make check` but skips when no code files (`src/`, `tests/`, `*.ts`, config files) are staged.

If any gate fails, fix the root cause. Never suppress, skip, or work around a failure.

## Architecture

**Runtime:** Bun (package manager, test runner, compiler). No Node.js required.

Core flow through source:

- `index.ts` — CLI entry. Parses args (yargs), resolves agent config, early completion check, reads task from stdin, hands off to `runAgent`.
- `agent.ts` — Core loop. Each **iteration** is a fresh API conversation (no context carry-forward). Within an iteration, tool calls loop until the model stops. After each iteration, checks completion.
- `config.ts` — YAML agent config loading and validation. Resolution: `.vesper/` in cwd first, then `~/.config/vesper/`.
- `permissions.ts` — Path: `minimatch` globs against symlink-resolved path relative to cwd. Command: binary name, optionally with first argument.
- `tools.ts` — Six tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`. Results truncated to `max_tool_result_size`.
- `completion.ts` — `CompletionTracker` monitors watch file line count. Empty/missing = complete. No change for N iterations = no_progress.
- `signals.ts` — Writes `.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed`.
- `logger.ts` — JSONL event stream to stderr when `log_events` is enabled.

## Code Standards

- Biome: 2-space indent, 100-char line width. Run `make format` to fix.
- `strict: true` in tsconfig — all source and test files are type-checked
- Named exports only — no default exports
- `VesperError` with exit code for user-facing errors
- One test file per source module in `tests/`
- Tests use `mkdtempSync` for isolated temp directories
- Stub the API via `MessageClient` interface in `agent.ts`

## Technical Constraints

- **Single binary**: Compiles to one native executable via `bun build --compile`
- **Structural safety**: Permission enforcement is structural, not instructional — tools are filtered from the API call entirely if the agent has no permissions for that category
- **Fresh context per iteration**: No conversation carry-forward by design. Agents persist state through the scratchpad file, not history.
- **Symlink resolution**: All path checks resolve symlinks to prevent escapes
- **Prompt caching**: `cache_control: { type: "ephemeral" }` on system prompt block and last tool definition

## Gotchas

1. Agent definitions are `.yml` + `.md` pairs — both files must exist or resolution fails
2. Path permissions are checked against the **real** (symlink-resolved) path, not the lexical path
3. Command permissions match binary name only, or binary + first arg — no deeper arg matching
4. `max_tokens` truncation (stop_reason `"max_tokens"`) is a hard error, not a retry
5. Token budget is cumulative across iterations — exhaustion writes `needs_approval`, not `failed`
6. Watch file completion: empty/missing = complete, stable line count = no_progress
7. `writeComplete` and `writeFailed` accept either a cwd string or a `SignalPaths` object — check the overload

## Navigation

| Resource | Location |
|----------|----------|
| Agent definitions | `.vesper/` (`<name>.yml` + `<name>.md`) |
| Planning docs | `docs/plans/` |
| Requirements / brainstorms | `docs/brainstorms/` |
| Example full config | `.vesper/builder.yml` |
