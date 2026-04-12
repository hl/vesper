---
title: "feat: Vesper v0.4 — Distribution, Init & Restructure"
type: feat
status: active
date: 2026-04-12
origin: docs/brainstorms/2026-04-12-vesper-v04-distribution-init-requirements.md
---

# feat: Vesper v0.4 — Distribution, Init & Restructure

## Overview

Vesper gets a proper distribution and onboarding story: Homebrew installation, project scaffolding via `vesper init`, a cleaner directory layout separating system prompts from agent configs, and a README. The CLI is restructured from a single positional command to subcommands (`run`, `init`) with CLI-level backwards compatibility (`vesper <agent>` still works). The config format is a clean break — existing agent configs must update their `system_prompt` paths.

## Problem Frame

Vesper has no installation path beyond cloning and building from source, no scaffolding for new projects, and `.vesper/agents/` mixes YAML configs with Markdown system prompts. This makes adoption hard — users can't `brew install`, can't bootstrap quickly, and the directory layout conflates two concerns.

(see origin: `docs/brainstorms/2026-04-12-vesper-v04-distribution-init-requirements.md`)

## Requirements Trace

- R1. CLI subcommands: `vesper run <agent>`, `vesper init`, `vesper <agent>` alias, `--help`, `--version`
- R2. `vesper init` scaffolds `.vesper/` with dirs, example config, CLAUDE.md, `.gitignore` updates; `--force` and `--global` flags
- R3. System prompts move to `.vesper/system_prompts/`; `system_prompt` resolves relative to `.vesper/` root; co-located `.md` requirement dropped
- R4. README covering install, quick start, config, concepts
- R5. GitHub Actions CI cross-compiles for 4 targets, creates releases, auto-commits Homebrew Formula

## Scope Boundaries

- No auto-injection of memories at runtime
- No interactive init wizard
- No npm/npx distribution
- No Windows builds
- No deprecation period for the system prompt path change — clean break (consistent with v0.3 precedent)

## Context & Research

### Relevant Code and Patterns

- `src/index.ts` — CLI entry, yargs v18 with `$0 <agent>` default command. `configDir` used in exactly 2 places (lines 63-65) for system prompt resolution. `promptPath` from `resolveAgent` is **never used** in this file.
- `src/config.ts` — `ResolvedAgent { configPath, promptPath, configDir }` interface. `resolveAgent()` searches `cwd/.vesper/agents/` then `~/.config/vesper/`, requires both `.yml` + `.md`. Lines 44-65.
- `tests/config.test.ts` — Only test file impacted by `resolveAgent` changes. Tests co-located `.md` requirement (lines 63-90), `promptPath` assertions (lines 33-34, 45-46), migration hints (107-122).
- `tests/agent.test.ts` — Unaffected. Tests `runAgent()` with pre-loaded configs; no reference to `resolveAgent`, `configDir`, or `promptPath`.
- `src/permissions.ts` — `isInsideCwd` helper for path containment checks; reusable for init's symlink validation.
- Brr's `internal/scaffold/scaffold.go` — Reference implementation for the init pattern: symlink rejection, atomic writes, `.gitignore` append logic, rollback on failure.

### Institutional Learnings

- **Structural permission enforcement** (`docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`): Path jail with `realpathSync`, symlink escape prevention. Init's file writes must use the same containment philosophy.
- **Skill injection** (`docs/solutions/best-practices/skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md`): Skills dir convention, graceful degradation for empty/missing dirs. Init scaffolds an empty `skills/` dir — existing `loadSkills` already handles this.
- **v0.3 breaking change precedent** (`docs/plans/2026-04-12-003-feat-vesper-v03-plan.md`): Signal config migration removed old pathway entirely, no deprecation. v0.4 follows the same pattern.

## Key Technical Decisions

- **Yargs default command for backwards compat**: `vesper <agent>` is implemented as a hidden default command (`$0 [agent]`) that delegates to the same handler as `vesper run <agent>`. This avoids pre-parsing hacks and is a standard yargs pattern.
- **Reserved name check in CLI layer, not `resolveAgent`**: The reserved names (`init`, `run`, `help`, `version`) are CLI concerns. Check in the `run` handler before calling `resolveAgent`, not inside the config module.
- **Version inlined via Makefile `--define`**: `bun build --compile` doesn't bundle `package.json`. The Makefile reads the version from `package.json` and passes it as `--define "VESPER_VERSION='x.y.z'"`. Source declares `declare const VESPER_VERSION: string` with a dev fallback.
- **New `src/init.ts` module**: Init logic lives in its own module (testable independently), wired into the CLI via the `init` subcommand handler.
- **Atomic writes via temp+rename**: Init file creation uses write-to-temp-then-rename pattern (mirroring brr's `atomicWriteFile`). Implemented as a local helper in `init.ts` — not extracted to a shared utility until a second consumer exists.
- **Formula, not Cask**: Homebrew Formulas are the standard for CLI binaries. `Formula/vesper.rb` in `hl/homebrew-tap`.

## Open Questions

### Resolved During Planning

- **Where to check reserved names**: CLI layer (`run` handler), not `resolveAgent`. The config module shouldn't know about CLI subcommand names.
- **How to handle existing README**: Rewrite it — the current 173-line README predates the v0.4 changes and needs restructuring to match the new install/init flow.
- **Home directory layout**: `~/.config/vesper/` mirrors local `.vesper/` structure: `agents/`, `system_prompts/`, `skills/`. `resolveAgent` searches `~/.config/vesper/agents/` for `.yml` files and resolves system prompts against `~/.config/vesper/`.

### Deferred to Implementation

- **Exact CLAUDE.md content**: The structure and wording of `.vesper/CLAUDE.md` will be determined during implementation. It should cover: directory layout, how to create agents, where skills/memories/scratchpads go.
- **CI runner selection for cross-compilation**: Whether all 4 targets can build on a single `ubuntu-latest` runner or need a matrix. Bun's cross-compilation downloads the target runtime, so a single runner likely works.

## Output Structure

```
src/
  init.ts                          # New: init scaffolding logic
  index.ts                         # Modified: subcommand restructure
  config.ts                        # Modified: resolveAgent changes
  version.ts                       # New: version constant with dev fallback
.vesper/
  system_prompts/                  # New directory
    builder.md                     # Moved from .vesper/agents/
    planner.md                     # Moved from .vesper/agents/
    reviewer.md                    # Moved from .vesper/agents/
    scribe.md                      # Moved from .vesper/agents/
.github/
  workflows/
    release.yml                    # New: CI release pipeline
tests/
  init.test.ts                     # New: init tests
  config.test.ts                   # Modified: resolveAgent test updates
```

**Target repo for Homebrew formula:** `hl/homebrew-tap` — `Formula/vesper.rb`

## Implementation Units

- [x] **Unit 1: Refactor `resolveAgent` and system prompt resolution (R3)**

**Goal:** Change `resolveAgent` to return `vesperDir` instead of `configDir`, drop the co-located `.md` requirement, and update `index.ts` to resolve system prompts against `vesperDir`.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `CLAUDE.md` (update Gotcha #1: agents are no longer `.yml` + `.md` pairs; update navigation table)

**Approach:**
- Change `ResolvedAgent` interface: remove `promptPath`, rename `configDir` → `vesperDir`. `vesperDir` is the parent directory of `agents/` — i.e., `cwd/.vesper/` for local agents or `~/.config/vesper/` for global agents. This is the directory against which `config.system_prompt` is resolved.
- In `resolveAgent`: only check for `<name>.yml` existence. Remove the `.md` existence check and the "yml exists but md missing" / "md exists but yml missing" error paths.
- Update the migration hint check (old `.vesper/<name>.yml` path) to also only look for `.yml`.
- In `index.ts`: change `${configDir}/${config.system_prompt}` to `${vesperDir}/${config.system_prompt}` in both the file read and the error message (lines 63-65).
- Update error destructuring from `{ configPath, configDir }` to `{ configPath, vesperDir }`.

**Patterns to follow:**
- Existing `resolveAgent` structure in `src/config.ts` lines 44-65
- Existing `VesperError` pattern for error cases

**Test scenarios:**
- Happy path: agent `.yml` exists in `.vesper/agents/`, no `.md` required → returns `{ configPath, vesperDir }` where `vesperDir` is the `.vesper/` directory
- Happy path: agent found in home directory `~/.config/vesper/agents/` → returns correct `vesperDir` pointing to `~/.config/vesper/` (not `~/.config/vesper/agents/`)
- Happy path: `.md` file exists alongside `.yml` but is ignored (no error, no `promptPath` returned)
- Error path: `.yml` not found in either location → "not found" error
- Error path: `.yml` exists at old path `.vesper/<name>.yml` → migration hint error message
- Edge case: `.yml` exists but `system_prompt` target file does not exist → error caught in `index.ts` when reading the system prompt (not in `resolveAgent`)

**Verification:**
- `make check` passes
- Existing agent configs still work when system prompt path is updated (verified in Unit 2)

---

- [x] **Unit 2: Migrate existing agents to new directory layout (R3)**

**Goal:** Move system prompt `.md` files from `.vesper/agents/` to `.vesper/system_prompts/` and update all configs.

**Requirements:** R3

**Dependencies:** Unit 1

**Files:**
- Create: `.vesper/system_prompts/` directory
- Move: `.vesper/agents/builder.md` → `.vesper/system_prompts/builder.md`
- Move: `.vesper/agents/planner.md` → `.vesper/system_prompts/planner.md`
- Move: `.vesper/agents/reviewer.md` → `.vesper/system_prompts/reviewer.md`
- Move: `.vesper/agents/scribe.md` → `.vesper/system_prompts/scribe.md`
- Modify: `.vesper/agents/builder.yml` — `system_prompt: system_prompts/builder.md`
- Modify: `.vesper/agents/planner.yml` — `system_prompt: system_prompts/planner.md`
- Modify: `.vesper/agents/reviewer.yml` — `system_prompt: system_prompts/reviewer.md`
- Modify: `.vesper/agents/scribe.yml` — `system_prompt: system_prompts/scribe.md`
- Modify: `CLAUDE.md` — update navigation table

**Approach:**
- Create `.vesper/system_prompts/` directory
- Move all four `.md` files
- Update `system_prompt` field in all four `.yml` files from `<name>.md` to `system_prompts/<name>.md`
- Update `CLAUDE.md` navigation table: add "System prompts" row pointing to `.vesper/system_prompts/`, update "Agent definitions" to note `.yml` only

**Test expectation:** none — file moves and YAML edits, no behavioral change beyond what Unit 1 tests cover.

**Verification:**
- `make check` passes (confirms the moved prompts resolve correctly with Unit 1's code changes)
- Manual: `cat .vesper/agents/builder.yml` shows `system_prompt: system_prompts/builder.md`
- Manual: `.vesper/agents/` contains only `.yml` files

---

- [x] **Unit 3: CLI subcommand restructure + version (R1)**

**Goal:** Restructure the CLI from a single `vesper <agent>` command to `vesper run <agent>` and `vesper init` subcommands, with `vesper <agent>` as a backwards-compatible alias. Add `--version`.

**Requirements:** R1

**Dependencies:** Unit 1 (needs new `resolveAgent` return shape)

**Files:**
- Create: `src/version.ts`
- Modify: `src/index.ts`
- Modify: `Makefile`
- Create: `tests/cli.test.ts`

**Approach:**
- Create `src/version.ts`: export a `VERSION` constant. At build time, `VESPER_VERSION` is injected via `--define`. At dev time, fall back to reading `package.json` dynamically. Pattern: `declare const VESPER_VERSION: string | undefined; export const VERSION = typeof VESPER_VERSION !== "undefined" ? VESPER_VERSION : "dev";`
- Restructure `src/index.ts` yargs setup:
  - `.command("run <agent>", "Run a Vesper agent", builderFn, runHandler)` — the current `main()` logic moves into `runHandler`
  - `.command("init", "Scaffold a .vesper/ project directory", initBuilder, initHandler)` — placeholder that will be fleshed out in Unit 5
  - `.command("$0 [agent]", false, ...)` — hidden default command, delegates to `runHandler` if `agent` is provided, otherwise shows help
  - `.version(VERSION)` for `--version`
  - Global `--cwd` option stays at the top level
- Reserved name check: in `runHandler`, before calling `resolveAgent`, check if `agentName` is in `["init", "run", "help", "version"]`. If so, throw `VesperError` with a clear message.
- Update Makefile `build` target: read version from `package.json` and pass it via `--define`. Working pattern (note quoting):
  ```makefile
  VERSION := $(shell bun -e "const p = await Bun.file('package.json').json(); console.log(p.version)")
  build:
  	bun build src/index.ts --compile --define "VESPER_VERSION='$(VERSION)'" --outfile vesper
  ```

**Patterns to follow:**
- Current yargs setup in `src/index.ts`
- Brr's CLI uses cobra (Go) but the concept of `init` + `run` subcommands is the same

**Test scenarios:**
- Happy path: `vesper run builder` parses agent name as "builder" and reaches `runHandler`
- Happy path: `vesper builder` (no subcommand) also parses as agent "builder" via default command
- Happy path: `vesper init` reaches `initHandler`
- Happy path: `vesper --version` prints the version string
- Happy path: `vesper --help` lists `run` and `init` subcommands
- Error path: `vesper run init` — reserved name "init" produces clear error
- Error path: `vesper run run` — reserved name "run" produces clear error
- Error path: unknown subcommand `vesper foo` where "foo" is not a valid agent → normal "agent not found" error from `resolveAgent`
- Edge case: `vesper` with no arguments → shows help text

Note: CLI subcommand routing is tested via the yargs parse result shape, not subprocess execution. Extract the yargs setup into a function that returns the parsed argv for testability.

**Verification:**
- `make check` passes
- `make build` produces a binary that responds to `--version`

---

- [x] **Unit 4: Implement `vesper init` (R2)**

**Goal:** Implement the init scaffolding logic: create `.vesper/` directories, write example config + system prompt + CLAUDE.md, update `.gitignore`. Support `--force` and `--global`.

**Requirements:** R2

**Dependencies:** Unit 3 (CLI wiring for the `init` subcommand)

**Files:**
- Create: `src/init.ts`
- Create: `tests/init.test.ts`
- Modify: `src/index.ts` (wire `initHandler` to call init logic)

**Approach:**
- New `src/init.ts` exports `init(options: { force: boolean; global: boolean })`.
- **Directory creation**: `mkdirSync` with `recursive: true` for `agents/`, `system_prompts/`, `skills/`, `memories/` (skip `memories/` for `--global`). Idempotent — directories that exist are silently skipped.
- **File creation**: Write `example.yml`, `example.md`, `CLAUDE.md` using atomic write (write to temp file in same directory, rename into place). Skip files that already exist unless `--force`. Track what was actually created for the output message.
- **Symlink rejection**: Before any write, check immediate target paths with `lstatSync` — if the path exists and is a symlink, error with a clear message. Check `.vesper/` (or `~/.config/vesper/`), `.gitignore`, and each file being written. Only immediate targets are checked, not full path ancestry (the user explicitly chose to run init in this directory).
- **`.gitignore` update** (local init only): Read existing `.gitignore` (or start empty if absent). Parse lines to find existing entries — skip comment lines (lines starting with `#`), so a commented-out `# .vesper-complete` is treated as absent and the real entry is appended. Append missing entries under `# vesper` header. Only write if entries were added.
- **`--global` flag**: Root path is `~/.config/vesper/` instead of `cwd/.vesper/`. No `memories/` dir, no `.gitignore` update.
- **Output**: Print created items to stderr, then next steps with docs link. Only list items actually created.
- Wire `initHandler` in `index.ts` to call `init()` with the parsed flags.

**Patterns to follow:**
- Brr's `internal/scaffold/scaffold.go` — symlink rejection, atomic writes, `.gitignore` append, rollback, output format
- Vesper's `isInsideCwd` from `src/permissions.ts` — path containment pattern (though init's symlink check is simpler: just reject symlinks, no jail check needed)

**Test scenarios:**
- Happy path: init in empty directory creates all directories, example files, CLAUDE.md, and updates `.gitignore`
- Happy path: init with existing `.vesper/` directory skips dir creation, still creates example files
- Happy path: init with existing `example.yml` skips it without error
- Happy path: init with `--force` overwrites existing example files
- Happy path: init with `--global` creates under `~/.config/vesper/`, no `memories/`, no `.gitignore`
- Happy path: `.gitignore` exists with some vesper entries already — only missing entries appended
- Happy path: `.gitignore` does not exist — created with vesper entries
- Happy path: all `.gitignore` entries already present — no `# vesper` section added, file unchanged
- Edge case: `.gitignore` has commented-out entries (`# .vesper-complete`) — treated as absent, real entries appended
- Error path: `.vesper/` is a symlink → error with clear message
- Error path: `.gitignore` is a symlink → error with clear message
- Error path: target file path is a symlink (even with `--force`) → error
- Integration: running init twice produces the same result as running it once (idempotent)

**Verification:**
- `make check` passes
- `vesper init` in a temp directory produces the expected file tree
- `vesper init` run twice doesn't duplicate `.gitignore` entries or overwrite files

---

- [x] **Unit 5: README (R4)**

**Goal:** Rewrite `README.md` with install, quick start, config overview, and concepts.

**Requirements:** R4

**Dependencies:** Units 2-4 (needs final directory layout and init command to be accurate)

**Files:**
- Modify: `README.md`

**Approach:**
- Rewrite the existing README (173 lines) following the structure in R4: what Vesper is, install (`brew install hl/tap/vesper` + build from source), quick start (`vesper init`, create agent, run), agent config overview, directory structure, concepts (tools, permissions, skills, scratchpad, completion, signals), built-in agents.
- Keep concise — CLAUDE.md is the deep technical reference, README is for humans discovering the project.
- Reference example config scaffolded by `vesper init` rather than duplicating it inline.

**Test expectation:** none — documentation only.

**Verification:**
- README is coherent and accurate against the implemented CLI and directory layout

---

- [x] **Unit 6: GitHub Actions release workflow (R5)**

**Goal:** Create a CI pipeline that cross-compiles Vesper for 4 targets on version tag push, creates a GitHub release with tarballs, and auto-commits an updated Homebrew formula to `hl/homebrew-tap`.

**Requirements:** R5

**Dependencies:** Unit 3 (Makefile version inlining)

**Files:**
- Create: `.github/workflows/release.yml`

**Approach:**
- Trigger: `push.tags: ["v*"]`
- Single job (Bun cross-compilation downloads target runtimes, no need for a matrix):
  1. Checkout
  2. Install Bun (via `oven-sh/setup-bun@v2`)
  3. `bun install`
  4. `make check`
  5. Extract version from tag (`GITHUB_REF_NAME` → strip `v` prefix)
  6. Cross-compile loop for `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`: `bun build src/index.ts --compile --target=$TARGET --define "VESPER_VERSION='$VERSION'" --outfile vesper`
  7. Package each into `vesper_<os>_<arch>.tar.gz`
  8. Compute SHA256 for each tarball
  9. Create GitHub release via `softprops/action-gh-release` with all tarballs attached
  10. Generate updated `Formula/vesper.rb` from a template (inline or script), substituting version and SHA256 values
  11. Checkout `hl/homebrew-tap`, commit updated formula, push (requires `HOMEBREW_TAP_TOKEN` secret — a PAT with repo scope on `hl/homebrew-tap`)

**Patterns to follow:**
- Brr's `.goreleaser.yaml` + `Casks/brr.rb` — similar release flow but for Go. Vesper adapts the concept for Bun cross-compilation.

**Test scenarios:**
- Happy path: pushing `v0.4.0` tag triggers workflow, produces 4 tarballs, creates release, updates formula
- Error path: `make check` fails → workflow stops before building/releasing
- Edge case: tag without `v` prefix → workflow does not trigger

**Verification:**
- Workflow YAML is valid (can be verified with `actionlint` if available)
- Pushing a test tag produces artifacts in the GitHub Actions run

---

- [x] **Unit 7: Homebrew formula (R5)**

**Goal:** Create the Homebrew formula template in `hl/homebrew-tap` that the CI workflow generates/updates on each release.

**Requirements:** R5

**Dependencies:** Unit 6 (CI workflow must exist to generate/update this file on each release)

**Files:**
- Create: `Formula/vesper.rb` (in `hl/homebrew-tap` repo — separate repository, not this project)

**Approach:**
- Write the initial formula with placeholder version/SHA256 values. The CI workflow will overwrite it on each release.
- Formula structure: `class Vesper < Formula`, platform detection (`on_macos` with `on_intel`/`on_arm`, `on_linux` with `on_intel`/`on_arm`), URL pointing to GitHub release tarballs, SHA256 verification, `bin.install "vesper"`.
- Update `hl/homebrew-tap` README to include `brew install hl/tap/vesper`.

**Test expectation:** none — Homebrew formula is declarative configuration. Verified by `brew install` after first release.

**Verification:**
- `brew install hl/tap/vesper` works after the first release tag is pushed
- `vesper --version` prints the expected version after install

## System-Wide Impact

- **Interaction graph:** `index.ts` → `resolveAgent` (config.ts) → system prompt resolution chain changes. No other modules are affected — `runAgent`, tools, permissions, completion, signals all receive already-resolved data.
- **Error propagation:** New reserved-name error in CLI layer before `resolveAgent` is called. System prompt "not found" error location unchanged (still in `index.ts`), just uses `vesperDir` instead of `configDir`.
- **State lifecycle risks:** Init's atomic writes prevent partial file creation. `.gitignore` uses a read-parse-then-append pattern (must read to check existing entries). Atomic write is not needed for `.gitignore` since append-mode open is sufficient for adding entries.
- **API surface parity:** The `vesper <agent>` alias ensures existing scripts/docs continue working. The `ResolvedAgent` interface change is internal (not exported to consumers).
- **Unchanged invariants:** Tool permissions, skill injection, scratchpad behavior, signal file I/O, completion tracking, and the agent iteration loop are all untouched by this plan.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bun cross-compilation produces broken binaries for non-native targets | Test at least one non-native target locally before shipping CI. The v0.1 plan noted "Bun `--compile` may bundle incorrectly" — verify native dependencies work. |
| `HOMEBREW_TAP_TOKEN` secret leaks or expires | Use a fine-grained PAT scoped to `hl/homebrew-tap` only. Document the required secret in the workflow comments. |
| Yargs default command ambiguity between agent names and subcommands | Reserved name check runs before `resolveAgent`. Unknown positionals fall through to `resolveAgent` which produces "not found" errors naturally. |
| Test fixture churn from `resolveAgent` changes | Impact is isolated to `tests/config.test.ts`. Other test files don't reference `resolveAgent`, `configDir`, or `promptPath`. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-12-vesper-v04-distribution-init-requirements.md](docs/brainstorms/2026-04-12-vesper-v04-distribution-init-requirements.md)
- Related plans: `docs/plans/2026-04-12-001-feat-vesper-cli-plan.md` (original CLI), `docs/plans/2026-04-12-003-feat-vesper-v03-plan.md` (breaking change precedent), `docs/plans/2026-04-12-004-feat-skill-injection-plan.md` (directory restructure precedent)
- Related solutions: `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`, `docs/solutions/best-practices/skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md`
- Reference implementation: brr's `internal/scaffold/scaffold.go` (init pattern)
- Homebrew tap: `hl/homebrew-tap` (target repo for Formula)
