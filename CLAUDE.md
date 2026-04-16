# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Core flow: CLI args + stdin → Config resolution → Single API conversation (tool calls) → Signal files

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

- `index.ts` — CLI entry. Parses args (yargs), resolves agent config, reads task from stdin, hands off to `runAgent`.
- `agent.ts` — Runs a single API conversation. Tool calls loop until the model stops. Writes signal files on completion, budget exhaustion, or error. Iteration/re-invocation is handled externally by brr.
- `config.ts` — YAML agent config loading and validation. Resolution: `.vesper/agents/` in cwd first, then `~/.config/vesper/`.
- `permissions.ts` — Path: `minimatch` globs against symlink-resolved path relative to cwd. Command: binary name, optionally with first argument.
- `tools.ts` — Six tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`. Results truncated to `max_tool_result_size`.
- `context.ts` — Token estimation (chars/3 heuristic), tool result pruning with outcome-preserving stubs, conversation compaction via summarization API call.
- `signals.ts` — Writes `.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed`. Paths configurable via `signals:` in agent YAML.
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
- **Single conversation per invocation**: Vesper runs one API conversation with tool calls, writes a signal file, and exits. Re-invocation and iteration are handled by the external orchestrator (brr).
- **Structural safety**: Permission enforcement is structural, not instructional — tools are filtered from the API call entirely if the agent has no permissions for that category
- **Symlink resolution**: All path checks resolve symlinks to prevent escapes
- **Prompt caching**: `cache_control: { type: "ephemeral" }` on system prompt block and last tool definition
- **Context management**: Three-layer system — pre-call estimation guard, tool result pruning (stubs preserve outcome metadata), and conversation compaction (summarization API call). Configured via `context_management:` in agent YAML.

## Gotchas

1. Agent definitions are `.yml` files in `.vesper/agents/`. The `system_prompt` path in the YAML is resolved relative to `.vesper/` (the Vesper root), not the agents directory
2. Path permissions are checked against the **real** (symlink-resolved) path, not the lexical path
3. Command permissions match binary name only, or binary + first arg — no deeper arg matching
4. `max_tokens` truncation (stop_reason `"max_tokens"`) is a hard error, not a retry
5. Token budget exhaustion writes `needs_approval`, not `failed`
6. `writeComplete` and `writeFailed` accept a `SignalPaths` object
7. Token estimation uses chars/3 — a heuristic, not exact. The context guard fires at a configurable threshold (default 80%) to trigger pruning/compaction before hitting the model's hard limit
8. Compaction truncation (`stop_reason: "max_tokens"`) is treated as a hard error, not a partial success
9. Command permission entries must have at most 2 tokens (binary + optional subcommand) — config validation rejects longer entries

## Navigation

| Resource | Location |
|----------|----------|
| Agent configs | `.vesper/agents/` (`<name>.yml`) |
| System prompts | `.vesper/system_prompts/` (referenced by `system_prompt` field in agent YAML) |
| Planning docs | `docs/plans/` |
| Requirements / brainstorms | `docs/brainstorms/` |
| Documented solutions | `docs/solutions/` (best practices, patterns, past fixes — YAML frontmatter searchable by `module`, `tags`, `problem_type`) |
| Example full config | `.vesper/agents/builder.yml` |
| Skills directory | `.vesper/skills/` (Markdown skill files injected at startup) |
