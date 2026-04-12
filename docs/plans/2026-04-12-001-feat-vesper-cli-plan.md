---
title: "feat: Build Vesper — permission-gated agent CLI"
type: feat
status: active
date: 2026-04-12
---

# feat: Build Vesper — permission-gated agent CLI

## Overview

Build a CLI binary that loads a named agent persona (YAML config + Markdown system prompt), reads a task prompt from stdin, and runs a permission-gated agentic loop against the Anthropic API. Safety boundaries are structural — the runtime enforces tool allow-lists regardless of what the LLM reasons.

Compiled to a single native binary with `bun build --compile`.

## Problem Frame

Existing agent runtimes give the LLM broad tool access and rely on prompt instructions for safety. Vesper inverts this: the YAML config declares an allow-list of file globs and commands, and the runtime enforces it before any tool result reaches the LLM. This makes agent capabilities auditable and tamper-proof.

## Requirements Trace

- R1. CLI loads agent config from `.vesper/<agent>.yml` + `.vesper/<agent>.md`, falling back to `~/.config/vesper/`
- R2. All tool calls gated by allow-list permissions — denied calls return `{ error: "permission_denied" }` with no detail
- R3. Paths resolving outside `cwd` always denied
- R4. Command matching supports binary-only and binary+subcommand entries
- R5. Completion model: watch file empty/missing → complete; no progress → failed; no watch file → run to caller limit
- R6. Signal files written to cwd with caller-controlled names via env vars
- R7. Token budget tracked cumulatively across iterations; exhaustion writes needs-approval signal
- R8. Each iteration is a fresh API conversation — no context accumulation between iterations
- R9. `make check` passes (typecheck + lint + test), `make build` produces a single binary
- R10. Binary runs on Linux and macOS

## Scope Boundaries

- No streaming — non-streaming API calls only
- No context carry-forward between iterations (scratchpad pattern is a system prompt concern, not runtime)
- No interactive terminal mode — stdin must be piped
- No plugin system or dynamic tool loading
- No retry logic for API errors — write failed signal and exit
- System prompt `.md` files are opaque strings — no templating or frontmatter processing

## Context & Research

### Anthropic SDK

- `@anthropic-ai/sdk` v0.88.0. Tool definitions via `Tool` interface with `name`, `description`, `input_schema`
- Response `stop_reason`: `"tool_use"` means process tool calls; `"end_turn"` means iteration complete
- Tool results sent as `tool_result` content blocks in next user message, must immediately follow assistant message
- `response.usage.input_tokens` / `output_tokens` for budget tracking
- Manual loop (not SDK Tool Runner) required for per-call token tracking and budget enforcement
- `strict: true` on tool definitions guarantees schema-conformant input from the LLM

### Bun Runtime

- `bun build --compile --outfile vesper` produces a single binary; supports cross-compilation via `--target`
- File I/O: `Bun.file().text()` for reads, `Bun.write()` for writes, `node:fs/promises` for `mkdir`, `readdir`, `rm`
- `Bun.file().exists()` for existence checks (async); `existsSync` from `node:fs` for sync
- `Bun.spawn(["cmd", "arg1"], { cwd, stdout: "pipe", stderr: "pipe" })` — stdout/stderr are `ReadableStream`
- `await Bun.stdin.text()` reads all stdin until EOF
- Write signal files before `process.exit()` — Bun exit handlers have edge-case bugs
- `process.env` for environment variables
- `bun test` built-in, Jest-compatible API from `bun:test`

### Unified Diff Patching

The `patch_file` tool requires applying unified diffs. No npm package is specified in the dependency list. Two options:
- Implement a minimal patch applier (unified diff is a well-defined format)
- Add a dependency like `diff` or `patch-package`

Decision: add the `diff` npm package — it provides `applyPatch` which handles unified diffs correctly. Implementing a patch applier from scratch is unnecessary complexity.

## Key Technical Decisions

- **Manual agentic loop over SDK Tool Runner**: The Tool Runner abstracts away per-call usage data, making token budget enforcement impossible. The manual loop gives direct access to `response.usage` after each API call.
- **Non-streaming API**: Simpler loop logic, no need to accumulate content blocks. The CLI is headless — no user watching text stream in.
- **`Bun.spawn` for command execution**: Returns stdout/stderr as `ReadableStream`, exit code as number. Clean mapping to the `run_command` tool response shape.
- **`diff` package for patch_file**: `applyPatch` from the `diff` package handles unified diff parsing and application. Avoids reimplementing a well-defined format.
- **Permission check as a pure function**: `checkPermission(operation, path, config) → boolean` — separates policy from execution, makes testing trivial.
- **All paths resolved and jail-checked before glob matching**: `path.resolve(cwd, inputPath)` then verify it starts with `cwd`. This happens before the allow-list check, so escape attempts are caught regardless of glob patterns.

## Open Questions

### Resolved During Planning

- **Unified diff application**: Use `diff` npm package (`applyPatch` function) rather than writing a custom parser.
- **Model selection**: The spec doesn't specify a model. The agent config should include an optional `model` field, but this can be added later. For now, default to `claude-sonnet-4-5-20250514` — it's capable and cost-effective for agentic work. Hardcode as a constant; easy to extract later.
- **API key**: Read from `ANTHROPIC_API_KEY` env var. The SDK does this automatically via `new Anthropic()`.
- **max_tokens per API call**: Use a reasonable default (4096). This is per-call output tokens, distinct from the cumulative token budget.

### Deferred to Implementation

- **Exact error messages for config validation**: The spec says "descriptive error" — exact wording will be determined during implementation.
- **Patch failure detail strings**: The `patch_failed` error includes a `detail` field — exact content depends on what the `diff` library returns.

## Output Structure

```
vesper/
├── .vesper/
│   ├── planner.yml
│   ├── planner.md
│   ├── builder.yml
│   ├── builder.md
│   ├── reviewer.yml
│   └── reviewer.md
├── src/
│   ├── index.ts
│   ├── agent.ts
│   ├── config.ts
│   ├── permissions.ts
│   ├── tools.ts
│   ├── completion.ts
│   ├── signals.ts
│   └── errors.ts
├── tests/
│   ├── config.test.ts
│   ├── permissions.test.ts
│   ├── tools.test.ts
│   ├── completion.test.ts
│   └── signals.test.ts
├── biome.json
├── tsconfig.json
├── package.json
└── Makefile
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────────┐
│  index.ts                                                   │
│  Parse CLI args (yargs) → resolve config → read stdin       │
│  → call runAgent() → write signal → process.exit()          │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  agent.ts — runAgent(config, systemPrompt, taskPrompt, cwd) │
│                                                             │
│  ITERATION LOOP:                                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 1. Build messages: [{ role: "user", content: task }]   │ │
│  │ 2. API call with system prompt + tool definitions      │ │
│  │ 3. TOOL LOOP:                                          │ │
│  │    ├─ stop_reason === "tool_use"?                      │ │
│  │    │   ├─ For each tool_use block:                     │ │
│  │    │   │   ├─ permissions.check(op, path, config)      │ │
│  │    │   │   ├─ If denied → { error: "permission_denied"}│ │
│  │    │   │   └─ If allowed → tools.execute(name, input)  │ │
│  │    │   ├─ Append assistant msg + tool results          │ │
│  │    │   └─ Next API call (same messages array)          │ │
│  │    └─ stop_reason === "end_turn"? → iteration done     │ │
│  │ 4. Accumulate token usage                              │ │
│  │ 5. Check budget → exceeded? → needs-approval signal    │ │
│  │ 6. Check completion condition                          │ │
│  │    ├─ watch_file empty/missing → complete signal       │ │
│  │    ├─ no progress detected → failed signal             │ │
│  │    └─ still has content → next iteration               │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ permissions.ts│  │   tools.ts   │  │  signals.ts  │
│              │  │              │  │              │
│ checkPath()  │  │ read_file()  │  │ writeComplete│
│ checkCmd()   │  │ list_files() │  │ writeNeeds   │
│ resolvePath()│  │ write_file() │  │ Approval()   │
│ isInsideCwd()│  │ patch_file() │  │ writeFailed()│
│              │  │ delete_file()│  │              │
│              │  │ run_command()│  │              │
└──────────────┘  └──────────────┘  └──────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  config.ts   │  │completion.ts │  │  errors.ts   │
│              │  │              │  │              │
│ resolveAgent │  │ checkWatch   │  │ VesperError  │
│ parseConfig  │  │ File()       │  │ exitWithError│
│ validateConfig│ │ trackProgress│  │              │
│              │  │ ()           │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

## Implementation Units

- [ ] **Unit 1: Project scaffolding**

  **Goal:** Create the project skeleton with all config files and dependencies installed.

  **Requirements:** R9, R10

  **Dependencies:** None

  **Files:**
  - Create: `package.json`
  - Create: `tsconfig.json`
  - Create: `biome.json`
  - Create: `Makefile`

  **Approach:**
  - `package.json` with all dependencies from the spec, plus `diff` for patch support
  - `tsconfig.json` with strict mode, ESNext target, bundler module resolution
  - `biome.json` with the spec's formatter and linter config
  - `Makefile` with build, check, format, lint, test, typecheck targets
  - Run `bun install` to generate lockfile
  - Verify `bun tsc --noEmit` passes on an empty project

  **Test expectation:** none — scaffolding only

  **Verification:**
  - `bun install` completes without errors
  - `bun tsc --noEmit` exits 0

- [ ] **Unit 2: Error types**

  **Goal:** Define error types and a hard-exit helper used throughout the codebase.

  **Requirements:** R1 (config errors exit 1)

  **Dependencies:** Unit 1

  **Files:**
  - Create: `src/errors.ts`

  **Approach:**
  - A `VesperError` class extending `Error` with a `code` field
  - An `exitWithError(message: string, code?: number)` function that writes to stderr and calls `process.exit`
  - Keep it minimal — this is a leaf module with no imports from other `src/` files

  **Test expectation:** none — trivial error class and exit wrapper. Tested indirectly through other modules.

  **Verification:**
  - Imports cleanly from other modules
  - `bunx biome lint src/errors.ts` passes

- [ ] **Unit 3: Config resolution and validation**

  **Goal:** Resolve agent YAML + MD files from the filesystem and parse/validate the config.

  **Requirements:** R1

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/config.ts`
  - Create: `tests/config.test.ts`

  **Approach:**
  - `resolveAgent(name: string, cwd: string)` — checks `<cwd>/.vesper/<name>.yml` and `<cwd>/.vesper/<name>.md`, falls back to `~/.config/vesper/`. Returns `{ configPath, promptPath }` or exits with code 1.
  - `loadConfig(configPath: string)` — reads YAML with `js-yaml`, validates required keys (`system_prompt`, `token_budget`, `tools`, `completion`), applies defaults for optional keys (`log_denied_calls: false`, `no_progress_limit: 3`, empty arrays for tool sub-keys).
  - Return a typed `AgentConfig` interface.
  - Use `os.homedir()` for the `~` expansion.

  **Patterns to follow:**
  - `js-yaml`'s `load()` returns `unknown` — validate with explicit type narrowing, not type assertions.

  **Test scenarios:**
  - Happy path: resolves agent files from `cwd/.vesper/` when both `.yml` and `.md` exist
  - Happy path: falls back to `~/.config/vesper/` when not present in `cwd`
  - Error path: exits with code 1 and message when `.yml` is missing
  - Error path: exits with code 1 and message when `.md` is missing
  - Error path: exits with code 1 when `system_prompt` key is absent
  - Error path: exits with code 1 when `token_budget` key is absent
  - Error path: exits with code 1 when `tools` key is absent
  - Error path: exits with code 1 when `completion` key is absent
  - Edge case: parses all optional keys with correct defaults when absent (`log_denied_calls` → false, `no_progress_limit` → 3, empty tool arrays)

  **Verification:**
  - `bun test tests/config.test.ts` passes
  - Exported types are usable from other modules without `any` casts

- [ ] **Unit 4: Permission enforcement**

  **Goal:** Implement the allow-list permission model for file paths and commands.

  **Requirements:** R2, R3, R4

  **Dependencies:** Unit 3 (uses `AgentConfig` types)

  **Files:**
  - Create: `src/permissions.ts`
  - Create: `tests/permissions.test.ts`

  **Approach:**
  - `checkPathPermission(operation: "read" | "write" | "delete", inputPath: string, cwd: string, allowList: string[]) → boolean`
    1. Resolve `inputPath` relative to `cwd`
    2. Verify resolved path starts with `cwd` (jail check) — deny silently if not
    3. Convert to a relative path from `cwd`
    4. Match against allow-list globs using `minimatch`
  - `checkCommandPermission(command: string, args: string[], allowList: string[]) → boolean`
    1. For each entry in the allow-list: if single token, match binary only; if multi-token, match binary + first arg
  - Both return boolean. The caller (agent loop) constructs the `{ error: "permission_denied" }` response.
  - Optional: `logDeniedCall(toolName: string, target: string)` writes to stderr when `log_denied_calls` is true.

  **Patterns to follow:**
  - `minimatch` with default options (no `dot: true` — hidden files require explicit patterns like `.*`)
  - `path.resolve()` then `resolvedPath.startsWith(cwd + path.sep)` or `resolvedPath === cwd` for jail check

  **Test scenarios:**
  - Happy path: permits a path matching a glob in the read list
  - Happy path: permits a path matching a glob in the write list
  - Happy path: permits a path matching a glob in the delete list
  - Error path: denies a path not matching any glob
  - Error path: denies a path that resolves outside `cwd` (e.g., `../../../etc/passwd`) regardless of allow-list
  - Happy path: permits a command matching a binary-only entry (e.g., `"mix"`) with any arguments
  - Happy path: permits a command matching a binary+subcommand entry (e.g., `"mix test"`) with additional flags
  - Error path: denies a command whose subcommand does not match (e.g., `"mix compile"` against `"mix test"`)
  - Error path: denies a command not in the list at all
  - Integration: returns false for denied operations (caller constructs `{ error: "permission_denied" }`)

  **Verification:**
  - `bun test tests/permissions.test.ts` passes
  - Path traversal attacks are blocked regardless of glob patterns

- [ ] **Unit 5: Signal file writing**

  **Goal:** Implement signal file creation for complete, needs-approval, and failed states.

  **Requirements:** R6, R7

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/signals.ts`
  - Create: `tests/signals.test.ts`

  **Approach:**
  - Read signal file paths from env vars with defaults: `VESPER_SIGNAL_COMPLETE` → `.vesper-complete`, `VESPER_SIGNAL_NEEDS_APPROVAL` → `.vesper-needs-approval`, `VESPER_SIGNAL_FAILED` → `.vesper-failed`
  - `writeComplete(cwd: string)` — writes empty file
  - `writeNeedsApproval(cwd: string, agent: string, budget: number, inputTokens: number, outputTokens: number)` — writes JSON with `reason: "token_budget_exceeded"`
  - `writeFailed(cwd: string, agent: string, reason: "no_progress" | "error", message: string)` — writes JSON
  - All use `Bun.write()` for file creation

  **Test scenarios:**
  - Happy path: reads signal file names from environment variables
  - Edge case: falls back to defaults when environment variables are not set
  - Happy path: writes complete signal as an empty file
  - Happy path: writes needs-approval signal as valid JSON with `reason`, `agent`, and `message` fields
  - Happy path: writes failed signal as valid JSON with `reason`, `agent`, and `message` fields
  - Happy path: writes all signal files to `cwd` (not to process cwd or elsewhere)

  **Verification:**
  - `bun test tests/signals.test.ts` passes
  - Signal files are valid JSON (needs-approval, failed) or empty (complete)

- [ ] **Unit 6: Tool implementations**

  **Goal:** Implement the five tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`.

  **Requirements:** R2 (tools return structured results)

  **Dependencies:** Unit 1 (for `diff` package), Unit 2

  **Files:**
  - Create: `src/tools.ts`
  - Create: `tests/tools.test.ts`

  **Approach:**
  - Each tool is a standalone async function that takes validated input and returns the spec's result type
  - `readFile(resolvedPath: string)` → `{ content: string }` or `{ error: "not_found" }`
  - `listFiles(resolvedPath: string)` → `{ entries: string[] }` or `{ error: "not_found" }`
  - `writeFile(resolvedPath: string, content: string)` → `{ ok: true }` — creates intermediate dirs with `mkdir({ recursive: true })`
  - `patchFile(resolvedPath: string, patch: string)` → `{ ok: true }` or `{ error: "not_found" }` or `{ error: "patch_failed", detail: string }` — uses `applyPatch` from `diff` package; reads file, applies patch, writes only on success
  - `deleteFile(resolvedPath: string)` → `{ ok: true }` or `{ error: "not_found" }`
  - `runCommand(command: string, args: string[], cwd: string)` → `{ stdout, stderr, exit_code }` — uses `Bun.spawn` with piped stdout/stderr
  - Tools receive already-resolved, already-permitted paths. Permission checking is not their concern.

  **Patterns to follow:**
  - `Bun.file(path).exists()` for existence checks before read/delete
  - `Bun.file(path).text()` for file reads
  - `Bun.write(path, content)` for file writes
  - `Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" })` for commands
  - `new Response(proc.stdout).text()` to consume ReadableStream as string

  **Test scenarios:**
  - Happy path: `read_file` returns file contents for a valid path
  - Error path: `read_file` returns `not_found` for a missing file
  - Happy path: `list_files` returns directory entries for a valid directory
  - Happy path: `write_file` creates intermediate directories as needed
  - Happy path: `write_file` overwrites an existing file
  - Happy path: `patch_file` applies a valid unified diff correctly
  - Error path: `patch_file` returns `patch_failed` without modifying the file on invalid/mismatched patch
  - Happy path: `delete_file` removes the file
  - Error path: `delete_file` returns `not_found` for a missing file
  - Happy path: `run_command` returns stdout, stderr, and exit code 0 for a successful command
  - Happy path: `run_command` returns stdout, stderr, and non-zero exit code for a failing command

  **Verification:**
  - `bun test tests/tools.test.ts` passes
  - All tool functions return structured objects, never throw on expected error conditions

- [ ] **Unit 7: Completion detection**

  **Goal:** Implement watch file monitoring and no-progress detection.

  **Requirements:** R5

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/completion.ts`
  - Create: `tests/completion.test.ts`

  **Approach:**
  - `CompletionTracker` class (or equivalent state container):
    - Constructor takes `watchFile: string | null`, `noProgressLimit: number`, `cwd: string`
    - `check()` method: reads the watch file, counts lines, compares to previous count, returns `"complete" | "continue" | "no_progress"`
    - Tracks consecutive unchanged iterations internally
  - When `watchFile` is null: `check()` always returns `"continue"` (caller manages iteration limit)
  - When watch file is empty or missing: returns `"complete"`
  - When watch file has content but line count unchanged for `noProgressLimit` iterations: returns `"no_progress"`
  - The tracker does not create or seed the watch file

  **Test scenarios:**
  - Happy path: returns `"complete"` when watch file is empty
  - Happy path: returns `"complete"` when watch file does not exist
  - Happy path: returns `"continue"` when watch file has content
  - Edge case: detects no-progress after `no_progress_limit` consecutive iterations with unchanged line count
  - Edge case: does not trigger no-progress when lines are being removed each iteration
  - Happy path: returns `"continue"` (never `"complete"` or `"no_progress"`) when no `watch_file` is configured

  **Verification:**
  - `bun test tests/completion.test.ts` passes

- [ ] **Unit 8: Agent runner — conversation loop**

  **Goal:** Implement the core agentic loop that ties together the API, permissions, tools, completion, and signals.

  **Requirements:** R2, R5, R7, R8

  **Dependencies:** Units 3, 4, 5, 6, 7

  **Files:**
  - Create: `src/agent.ts`

  **Approach:**
  - `runAgent(config: AgentConfig, systemPrompt: string, taskPrompt: string, cwd: string)` → `Promise<{ exitCode: number }>`
  - Instantiate `Anthropic` client (reads API key from env automatically)
  - Build tool definitions array matching the spec's five tools (with `strict: true`)
  - Outer loop (iterations):
    1. Build fresh messages: `[{ role: "user", content: taskPrompt }]`
    2. Inner loop (tool rounds within one iteration):
       - Call `client.messages.create({ model, max_tokens: 4096, system: systemPrompt, tools, messages })`
       - Accumulate `usage.input_tokens` + `usage.output_tokens` to running total
       - If `stop_reason === "end_turn"`: break inner loop
       - If `stop_reason === "tool_use"`: for each `tool_use` block, check permissions, execute tool or return denial, build `tool_result` blocks, append assistant message + tool results to messages, continue inner loop
    3. After iteration: check token budget → if exceeded, write needs-approval signal, return `{ exitCode: 0 }`
    4. Check completion tracker → `"complete"` → write complete signal, return `{ exitCode: 0 }`; `"no_progress"` → write failed signal, return `{ exitCode: 1 }`; `"continue"` → next iteration
  - On API error: write failed signal with `reason: "error"`, return `{ exitCode: 1 }`
  - If no `watch_file` and loop exits normally (caller iteration limit not modeled — the agent runs a single invocation): write complete signal, return `{ exitCode: 0 }`

  **Execution note:** This is the integration point. Verify by running against a mock or the real API with a minimal agent config.

  **Test expectation:** none — this module orchestrates side effects (API calls, file I/O, process spawning). Its correctness is verified through the acceptance criteria integration tests. Unit-level modules (permissions, tools, completion, signals) carry their own test coverage.

  **Verification:**
  - Compiles without type errors
  - Integration: `echo "test" | vesper planner` with empty watch file writes complete signal without API calls (the completion check fires before the first API call when watch file is already empty/missing)

- [ ] **Unit 9: CLI entry point**

  **Goal:** Wire CLI argument parsing, config loading, stdin reading, and agent invocation.

  **Requirements:** R1, R8, R9

  **Dependencies:** Units 3, 8

  **Files:**
  - Create: `src/index.ts`

  **Approach:**
  - Use `yargs` to parse `<agent>` positional arg and `--cwd` option
  - Read stdin with `await Bun.stdin.text()`
  - Call `resolveAgent()` to find config files (exits 1 on missing)
  - Call `loadConfig()` to parse and validate YAML
  - Read system prompt file with `Bun.file().text()`
  - **Early completion check**: before calling `runAgent`, check if `watch_file` is configured and already empty/missing — if so, write complete signal and exit 0 without making API calls
  - Otherwise call `runAgent()` and exit with the returned code
  - Wrap top level in try/catch for unexpected errors → write failed signal, exit 1

  **Test expectation:** none — thin entry point. Tested through acceptance criteria.

  **Verification:**
  - `bun build src/index.ts --compile --outfile vesper` succeeds
  - `echo "test" | ./vesper nonexistent` exits 1 with missing config message
  - `echo "test" | ./vesper planner` (with empty watch file) exits 0, writes complete signal, no API calls

- [ ] **Unit 10: Built-in agent configs**

  **Goal:** Create the three reference agent configs (planner, builder, reviewer) with their system prompts.

  **Requirements:** R1 (agents are loadable)

  **Dependencies:** Unit 9 (to verify they load correctly)

  **Files:**
  - Create: `.vesper/planner.yml`
  - Create: `.vesper/planner.md`
  - Create: `.vesper/builder.yml`
  - Create: `.vesper/builder.md`
  - Create: `.vesper/reviewer.yml`
  - Create: `.vesper/reviewer.md`

  **Approach:**
  - YAML configs exactly as specified in the spec
  - System prompts should instruct the agent on its role and behavior
  - Builder and planner prompts should include scratchpad instructions: read `docs/plans/.scratchpad-<agent>.md` at iteration start, write progress summary at iteration end
  - Builder's `read` and `write` allow-lists already cover `docs/plans/**` via the `docs/plans/task-queue.md` pattern — scratchpad at `docs/plans/.scratchpad-builder.md` is within `docs/plans/**` so no config change needed
  - Planner's `write` list covers `docs/plans/**` — scratchpad similarly covered
  - Reviewer has no multi-iteration task continuity need — no scratchpad

  **Test expectation:** none — static config files. Validated by loading them with the config module.

  **Verification:**
  - `echo "test" | ./vesper planner` loads without config errors
  - `echo "test" | ./vesper builder` loads without config errors
  - `echo "test" | ./vesper reviewer` loads without config errors

## System-Wide Impact

- **Interaction graph:** The agent loop is the sole orchestrator. It calls permissions → tools → completion → signals in sequence. No callbacks, observers, or middleware.
- **Error propagation:** Tool execution errors are returned as data to the LLM (not thrown). API errors and unexpected exceptions write the failed signal and exit.
- **State lifecycle risks:** The watch file is read but never written by the binary — no race with external writers. Signal files are write-once. Token budget is append-only.
- **API surface parity:** All five tools share the same permission → execute → result pipeline. No tool has special-case handling.
- **Unchanged invariants:** The watch file, task queues, and scratchpad files are entirely managed by the LLM or external callers. The runtime only reads them.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `diff` package's `applyPatch` may not handle all unified diff edge cases | Test with multi-hunk diffs and context lines; the function is well-established |
| Bun `--compile` may bundle `js-yaml` or `diff` incorrectly | Verify in Unit 1 that a compiled binary can import and use both packages |
| `Bun.spawn` stdout/stderr ReadableStream consumption may hang on large output | Set reasonable buffer expectations; commands in agent configs are typically short-lived |
| Token budget tracking is cumulative but per-call usage may undercount cached tokens | Use `input_tokens + output_tokens` from `usage` field — this reflects actual tokens processed |

## Sources & References

- Anthropic TypeScript SDK: https://github.com/anthropics/anthropic-sdk-typescript
- Anthropic Tool Use docs: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Bun build --compile: https://bun.sh/docs/bundler/executables
- Bun spawn: https://bun.sh/docs/runtime/child-process
- Bun file I/O: https://bun.sh/docs/runtime/file-io
- Bun test runner: https://bun.sh/docs/test
- `diff` npm package: https://github.com/kpdecker/jsdiff
