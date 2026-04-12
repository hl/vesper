# Vesper v0.4 — Distribution, Init & Restructure

**Date:** 2026-04-12
**Status:** Draft

## Problem

Vesper currently has no installation path beyond cloning and building from source, no scaffolding for new projects, and a directory layout that co-locates agent YAML configs with their system prompt Markdown files. This makes adoption hard — users can't `brew install`, can't bootstrap a project quickly, and the `.vesper/agents/` directory mixes two concerns.

## Goals

1. Users can install Vesper with `brew install hl/tap/vesper`.
2. Users can scaffold a new project with `vesper init`.
3. System prompts live in their own directory (`.vesper/system_prompts/`), separate from agent YAML configs.
4. A README explains what Vesper is and how to get started.

## Non-Goals

- Auto-injection of memories at runtime (deferred — memories stay as files agents read manually; the project CLAUDE.md guides agents to them).
- Interactive init wizard (no prompts — just scaffold and print next steps).
- npm/npx distribution.
- Windows builds.

---

## R1: CLI Subcommand Support

The CLI currently has a single positional command (`vesper <agent>`). Adding `init` requires restructuring to support subcommands.

**Behavior:**
- `vesper init` — scaffold the project
- `vesper run <agent>` — run an agent (current behavior moves under `run`)
- `vesper <agent>` with no subcommand — **keep as an alias for `vesper run <agent>`** for CLI-level backwards compatibility (note: R3 introduces a breaking change to agent config format)
- `vesper --help` — shows both subcommands
- `vesper --version` — prints version from `package.json`

**Acceptance criteria:**
- `vesper run builder` and `vesper builder` both work
- `vesper init` works
- `vesper --help` lists subcommands with brief descriptions
- `vesper init --help` shows init-specific options
- `vesper --version` prints the version
- Unknown subcommands produce a clear error
- Agent names `init`, `run`, `help`, and `version` are reserved — error with a clear message if an agent config uses one

## R2: `vesper init` — Project Scaffolding

Scaffold the `.vesper/` directory structure in the current working directory.

**Creates:**
```
.vesper/
  agents/
  system_prompts/
  skills/
  memories/
  CLAUDE.md                  # agent-facing guide to .vesper/ conventions
  agents/example.yml        # fully documented example config
  system_prompts/example.md # matching example system prompt
```

**Example agent config (`example.yml`)** — shows every possible key with comments explaining each:
```yaml
# Agent configuration — see https://github.com/hl/vesper
# Copy this file and the matching system prompt to create your own agent.

system_prompt: system_prompts/example.md   # Relative to .vesper/
token_budget: 100000                       # Max tokens across all iterations
max_tool_result_size: 50000                # Truncate tool results beyond this (bytes)
log_denied_calls: false                    # Log when a tool call is denied
log_events: false                          # Emit JSONL event stream to stderr
skills: ".vesper/skills"                   # Directory of skill .md files (null to disable)
scratchpad: ".vesper/.scratchpad.md"       # Persistent scratchpad file (null to disable)

signals:
  complete: ".vesper-complete"             # Written on successful completion
  needs_approval: ".vesper-needs-approval" # Written when token budget exhausted
  failed: ".vesper-failed"                 # Written on failure

tools:
  read:                                    # Glob patterns for read_file / list_files
    - "src/**"
    - "docs/**"
  write:                                   # Glob patterns for write_file / patch_file
    - "src/**"
  delete:                                  # Glob patterns for delete_file
    - "src/**"
  commands:                                # Allowed commands (binary or binary + first arg)
    - "bun test"
    - "git commit"

completion:
  watch_file: ~                            # File to monitor for completion (null = run to budget)
  no_progress_limit: 3                     # Iterations without watch file change = no_progress
```

**`.gitignore` updates** — append under a `# vesper` header:
```
.vesper-complete
.vesper-needs-approval
.vesper-failed
.vesper/.scratchpad*.md
```

**Safety:**
- If `.vesper/` directory already exists, skip directory creation (no error).
- If `example.yml` or `example.md` already exist, skip those files (no overwrite).
- `--force` flag: overwrite example files even if they exist.
- Reject symlinks on `.vesper/`, `.gitignore`, and any file being written (security — prevents writes outside the repo).
- Atomic file writes (write to temp, rename) to prevent TOCTOU races.
- `.gitignore` updates are additive — only append entries that don't already exist. Create `.gitignore` if it doesn't exist. Skip if all entries already present. Ignore commented-out entries.

**Output:**
```
  Created:
    .vesper/agents/
    .vesper/system_prompts/
    .vesper/skills/
    .vesper/memories/
    .vesper/agents/example.yml
    .vesper/system_prompts/example.md
    .gitignore (updated)

  Next steps:
    1. Copy and edit example.yml to create your agent
    2. Write a system prompt in system_prompts/
    3. Run: vesper run <agent-name>

  Docs: https://github.com/hl/vesper
```

Only list items that were actually created (skip items that already existed).

**`vesper init --global`:**
Scaffolds `~/.config/vesper/` with the same directory structure (`agents/`, `system_prompts/`, `skills/`) for shared agents across projects. Same safety rules apply (no overwrite without `--force`, symlink rejection). Does not create `memories/` or update `.gitignore` (not a repo).

## R3: System Prompt Directory Restructure

Move system prompts from `.vesper/agents/*.md` to `.vesper/system_prompts/*.md`.

**Resolution change:**
- Currently: `system_prompt` field resolves relative to the agent config directory (`configDir`, i.e. `.vesper/agents/`).
- New: `system_prompt` field resolves relative to `.vesper/` (the Vesper root directory, not the agent config directory).
- Example: `system_prompt: system_prompts/scribe.md` resolves to `.vesper/system_prompts/scribe.md`.
- **This is a breaking change.** Existing agent configs must be updated to use the new path convention.

**Config resolution logic** (`src/config.ts` / `src/index.ts`):
- `resolveAgent()` currently returns `configDir` (the directory containing the YAML file) and requires both `<name>.yml` and `<name>.md` to exist.
- Change: return `vesperDir` (the parent `.vesper/` directory) instead of `configDir`. Drop the co-located `.md` requirement — `resolveAgent` only needs the `.yml` file. The system prompt path comes from the YAML config's `system_prompt` field, resolved against `vesperDir`.
- Remove `promptPath` from the `ResolvedAgent` interface. Update tests accordingly.

**Migration of existing agents (done atomically as part of R3):**
- Move `builder.md`, `planner.md`, `reviewer.md`, `scribe.md` from `.vesper/agents/` to `.vesper/system_prompts/`.
- Update all four YAML configs: `system_prompt: builder.md` → `system_prompt: system_prompts/builder.md`.
- Update CLAUDE.md navigation table to reflect the new layout.

## R4: README

Create `README.md` in the project root covering:

1. **What Vesper is** — one-paragraph description (permission-gated AI agent runtime, single binary, structural safety).
2. **Install** — `brew install hl/tap/vesper` and build-from-source instructions.
3. **Quick start** — `vesper init`, create an agent, run it.
4. **Agent configuration** — brief overview of the YAML + system prompt structure, link to the example config.
5. **Directory structure** — what `.vesper/` contains.
6. **Concepts** — brief explanation of tools, permissions, skills, scratchpad, completion, signals.
7. **Built-in agents** — mention that this repo ships example agents (builder, planner, reviewer, scribe) that users can copy.

Keep it concise. The CLAUDE.md already serves as deep technical reference — the README is for humans discovering the project.

## R5: Homebrew Distribution

Distribute Vesper as a Homebrew cask via the existing `hl/homebrew-tap` repository.

**Build targets:**
- `bun-darwin-arm64` (macOS Apple Silicon)
- `bun-darwin-x64` (macOS Intel)
- `bun-linux-x64` (Linux x64)
- `bun-linux-arm64` (Linux ARM64)

**CI pipeline** (GitHub Actions):
- Trigger: push a version tag (`v*`).
- Steps:
  1. Checkout code.
  2. Install Bun.
  3. `bun install`.
  4. `make check` — all quality gates must pass.
  5. Cross-compile for each target: `bun build src/index.ts --compile --target=<target> --outfile vesper`.
  6. Package each binary into a tarball: `vesper_<os>_<arch>.tar.gz`.
  7. Create GitHub release with all tarballs attached.
  8. Compute SHA256 for each tarball.
  9. Auto-commit the updated `Formula/vesper.rb` directly to `hl/homebrew-tap` main branch (requires a cross-repo PAT or deploy key).

**Homebrew Formula** (`Formula/vesper.rb` in `hl/homebrew-tap`):
- Use a Formula (not a Cask — Formulas are the standard for CLI binaries).
- Platform-specific URLs, SHA256 verification, `bin.install "vesper"`.
- Install: `brew install hl/tap/vesper`.

**Version source:** `package.json` `version` field. Tags should match: `v0.4.0` for `"version": "0.4.0"`. Since `bun build --compile` does not bundle `package.json`, the version must be inlined at build time (e.g., `--define "VERSION='0.4.0'"` or a build script that reads `package.json` and sets a constant).

---

## Sequencing

1. **R3** (directory restructure) — do first, since R2 depends on the new layout.
2. **R1** (subcommand support) — refactor CLI before adding init.
3. **R2** (`vesper init`) — implement scaffolding.
4. **R4** (README) — write after init exists so docs are accurate.
5. **R5** (Homebrew/CI) — last, since it depends on having a stable binary.

## Resolved Questions

1. **Agent onboarding** — `vesper init` scaffolds `.vesper/CLAUDE.md` (agent-facing guide to conventions). CLAUDE.md stays user-owned.
2. **CI formula update** — Release workflow auto-commits the updated formula directly to `hl/homebrew-tap` main.
3. **Global init** — `vesper init --global` scaffolds `~/.config/vesper/` for shared agents across projects.
