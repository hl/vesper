---
title: "feat: Add skill injection and reorganize .vesper/ directory"
type: feat
status: active
date: 2026-04-12
origin: docs/brainstorms/2026-04-12-vesper-skill-injection-requirements.md
---

# feat: Add skill injection and reorganize .vesper/ directory

## Overview

Add skill injection so Vesper agents can read persistent knowledge files at startup, and reorganize the `.vesper/` directory to separate agent definitions from runtime state.

## Problem Frame

Vesper agents start each run with no memory of prior work. In iterative workflows, agents repeat mistakes and miss project conventions. A persistent skill system lets agents read accumulated knowledge at startup, improving quality over time. (see origin: `docs/brainstorms/2026-04-12-vesper-skill-injection-requirements.md`)

## Requirements Trace

- R1. Config accepts optional `skills` field (directory path relative to cwd)
- R2. Skills directory must resolve inside cwd; silently skip if outside (matches scratchpad)
- R3. Read all `.md` files from directory; ignore non-`.md` files
- R3a. Sort files lexicographically by filename for deterministic ordering
- R4. Non-recursive — top-level files only
- R5. Silently skip if directory missing, not a directory, or empty
- R6. Read once at startup, not per-iteration
- R7. Inject into user message: `[Skills]` → `[Previous Context]` → `[Task]`, every iteration
- R8. Separate skills with filename headings (e.g., `## config-patterns.md`)
- R9. Runtime never writes to skills directory
- R10. Emit `skills_loaded` JSONL event when `log_events` is enabled

## Scope Boundaries

- No frontmatter parsing — raw file content only
- No relevance filtering — all `.md` files in the directory are injected
- No size limiting — user curates the directory
- No recursive directory reading
- Config resolution path change (`.vesper/` → `.vesper/agents/`) is included in this plan

## Context & Research

### Relevant Code and Patterns

- `src/config.ts:43-67` — `resolveAgent` function: current resolution path is `join(cwd, ".vesper")`. Needs to change to `join(cwd, ".vesper", "agents")`
- `src/config.ts:79-219` — `loadConfig` function: the `scratchpad` field (line 154-157) is the exact pattern to follow for `skills`
- `src/agent.ts:295-325` — Scratchpad injection: containment check + file read + prepend to `userContent`. Skills injection follows the same structure but reads a directory instead of a single file, and runs once before the loop
- `src/logger.ts` — Logger class: `skillsLoaded` follows the existing method pattern (`iterationStart`, `apiCall`, etc.)
- `tests/config.test.ts:8-106` — `resolveAgent` tests use temp dirs with `.vesper/` subdirectory
- `tests/agent.test.ts:13-43` — `makeConfig` factory: needs `skills` field added

### Institutional Learnings

None in `docs/solutions/`.

## Key Technical Decisions

- **Config resolution path**: `.vesper/` → `.vesper/agents/` for the cwd lookup. This is a breaking change but acceptable pre-1.0. The home fallback (`~/.config/vesper/`) is unchanged. When `resolveAgent` fails to find an agent in `.vesper/agents/`, it should check if the agent exists at the old `.vesper/` path and emit a clear migration hint in the error message. (see origin for directory convention)
- **Skill loading outside the iteration loop**: Skills are read once into a string variable before entering the `while` loop, then prepended to `userContent` each iteration. This avoids redundant I/O and matches R6.
- **Containment check reuse**: Extract the scratchpad's containment logic into a shared helper (`isInsideCwd`) to avoid duplicating the `realpathSync` dance. Both scratchpad and skills use it.
- **Individual file read errors**: Skip files that fail to read (e.g., permission denied) and continue with remaining files. Log the skip if `log_events` is enabled.

## Open Questions

### Resolved During Planning

- **Prompt template — all four cases**:
  1. Both skills and scratchpad: `[Skills]\n\n## file1.md\n{content}\n\n[Previous Context]\n{scratchpad}\n\n[Task]\n{taskPrompt}`
  2. Skills only (no scratchpad): `[Skills]\n\n## file1.md\n{content}\n\n[Task]\n{taskPrompt}`
  3. Scratchpad only (no skills): `[Previous Context]\n{scratchpad}\n\n[Task]\n{taskPrompt}` (current behavior)
  4. Neither: `{taskPrompt}` (current behavior, no section headers)
- **Mid-directory read failures**: Skip individual files that fail, continue with the rest. Partial skills are better than no skills.
- **Sort order**: Lexicographic by filename (R3a).

### Deferred to Implementation

- *(promoted to resolved)* ~~Exact handling of empty skill files~~

### Resolved During Implementation Planning (Late)

- **Empty skill files**: Skip files where `content.trim().length === 0`, matching scratchpad behavior at `agent.ts:320`

## Implementation Units

- [ ] **Unit 1: Change config resolution path to `.vesper/agents/`**

**Goal:** Move agent definitions from `.vesper/<agent>.{yml,md}` to `.vesper/agents/<agent>.{yml,md}`

**Requirements:** Convention from origin document

**Dependencies:** None

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Approach:**
- Change `resolveAgent` line 45: replace `join(cwd, ".vesper")` with `join(cwd, ".vesper", "agents")`
- Update all tests that create `.vesper/` directories to use `.vesper/agents/`

**Patterns to follow:**
- Existing `resolveAgent` structure

**Test scenarios:**
- Happy path: resolves agent from `cwd/.vesper/agents/` when both `.yml` and `.md` exist
- Happy path: falls back to `~/.config/vesper/` when not in `.vesper/agents/`
- Happy path: prefers `.vesper/agents/` over home when both exist
- Error path: exits code 1 when `.yml` exists but `.md` missing in `.vesper/agents/`
- Error path: exits code 1 when `.md` exists but `.yml` missing in `.vesper/agents/`
- Error path: exits code 1 when agent not found in any location

**Verification:**
- All existing `resolveAgent` tests pass with updated paths
- `make check` passes

- [ ] **Unit 2: Move built-in agent configs to `.vesper/agents/`**

**Goal:** Relocate the built-in planner, builder, and reviewer configs to the new path

**Requirements:** Convention from origin document

**Dependencies:** Unit 1

**Files:**
- Create: `.vesper/agents/builder.yml`, `.vesper/agents/builder.md`
- Create: `.vesper/agents/planner.yml`, `.vesper/agents/planner.md`
- Create: `.vesper/agents/reviewer.yml`, `.vesper/agents/reviewer.md`
- Delete: `.vesper/builder.yml`, `.vesper/builder.md`
- Delete: `.vesper/planner.yml`, `.vesper/planner.md`
- Delete: `.vesper/reviewer.yml`, `.vesper/reviewer.md`
- Modify: `CLAUDE.md` (update navigation table and architecture section to reference `.vesper/agents/`)

**Approach:**
- `git mv` each file from `.vesper/` to `.vesper/agents/`
- The `system_prompt` field in each `.yml` uses a basename (e.g., `builder.md`). Since `configDir` changes to `.vesper/agents/` and the `.md` files move alongside, no change to `system_prompt` values is needed
- Update scratchpad paths in builder and planner `.yml` configs from `docs/plans/.scratchpad-<agent>.md` to `.vesper/.scratchpad-<agent>.md` (aligning with the `.vesper/` convention from origin)
- Update scratchpad references in `builder.md` and `planner.md` system prompts to match the new paths
- Update `CLAUDE.md` navigation table and config resolution documentation to reference `.vesper/agents/`

**Patterns to follow:**
- Existing config file format

**Verification:**
- `make check` passes (updated `resolveAgent` tests from Unit 1 exercise the new path)
- `vesper builder` resolves config from `.vesper/agents/builder.yml`
- No agent config files remain in `.vesper/` root

- [ ] **Unit 3: Add `skills` field to AgentConfig and loadConfig**

**Goal:** Parse the optional `skills` config field

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/agent.test.ts` (update `makeConfig` factory)

**Approach:**
- Add `skills: string | null` to `AgentConfig` interface
- Add parsing block in `loadConfig` following the `scratchpad` pattern: `parsed.skills ?? null`, validate string or null, throw `VesperError` on wrong type
- Add `skills: null` default to `makeConfig` in `agent.test.ts`

**Patterns to follow:**
- `scratchpad` field parsing at `src/config.ts:154-157`
- `makeConfig` factory at `tests/agent.test.ts:13-43`

**Test scenarios:**
- Happy path: parses `skills` correctly when set to a string
- Happy path: defaults to null when `skills` is absent
- Error path: exits code 1 when `skills` is a non-string value (e.g., number)

**Verification:**
- `loadConfig` returns `skills` field for valid configs
- All existing config tests still pass

- [ ] **Unit 4: Add `skillsLoaded` logger method**

**Goal:** Emit a `skills_loaded` JSONL event

**Requirements:** R10

**Dependencies:** None (can be done in parallel with Units 1-3)

**Files:**
- Modify: `src/logger.ts`
- Modify: `tests/logger.test.ts`

**Approach:**
- Add method: `skillsLoaded(fileCount: number, totalBytes: number): void` calling `this.emit("skills_loaded", { file_count: fileCount, total_bytes: totalBytes })`

**Patterns to follow:**
- Existing logger methods (`iterationStart`, `apiCall`, etc.)

**Test scenarios:**
- Happy path: emits `skills_loaded` event with correct `file_count` and `total_bytes` when logging enabled
- Edge case: emits nothing when logging disabled

**Verification:**
- Logger tests pass
- Event JSON matches the established format (`event`, `run_id`, `timestamp`, plus payload)

- [ ] **Unit 5: Implement skill reading and injection in agent.ts**

**Goal:** Read skill files at startup and inject into every iteration's user message

**Requirements:** R2, R3, R3a, R4, R5, R6, R7, R8, R9

**Dependencies:** Units 3 and 4

**Files:**
- Modify: `src/agent.ts`
- Modify: `tests/agent.test.ts`

**Approach:**
- **Extract containment helper**: Pull the `realpathSync` + cwd check from the scratchpad block (lines 299-315) into a helper function `isInsideCwd(targetPath: string, cwd: string): string | null` that returns the resolved real path if inside cwd, or null if outside. Use it for both scratchpad and skills. Only the containment check logic is shared — the scratchpad file read must remain inside the iteration loop (it re-reads each iteration to capture agent writes). Skills are read once before the loop.
- **Skill loading** (before the iteration loop, after logger/signal setup):
  1. If `config.skills` is null, skip
  2. Resolve `config.skills` relative to cwd
  3. Run containment check via `isInsideCwd` — if null, skip silently
  4. Check if path exists and is a directory (`statSync` + `isDirectory()`) — if not, skip
  5. Read directory entries, filter for `.md` extension, sort lexicographically
  6. For each file: try to read content, skip on error
  7. Build skills string: `[Skills]\n\n## filename.md\n{content}\n\n## filename2.md\n{content}`
  8. Call `logger.skillsLoaded(count, bytes)` if any files were read
  9. Store the skills string (or null if no files read)
- **Injection** (inside the iteration loop, modifying the `userContent` construction):
  - If skills string exists, prepend it before scratchpad/task
  - Compose: skills + scratchpad + task, with appropriate section headers
  - Refactor scratchpad injection to use `isInsideCwd` helper

**Patterns to follow:**
- Scratchpad injection at `src/agent.ts:295-325`
- Scratchpad containment check pattern

**Test scenarios:**
- Happy path: skills from `.md` files are injected before scratchpad and task content
- Happy path: skills injected on every iteration (verify user message in second API call)
- Happy path: `skills_loaded` event emitted with correct count and byte total
- Happy path: files sorted lexicographically (`a.md` before `b.md`)
- Edge case: skills directory does not exist — silently skipped, agent runs normally
- Edge case: skills directory is empty (no `.md` files) — silently skipped
- Edge case: skills directory contains non-`.md` files — only `.md` files read
- Edge case: skills directory is actually a regular file — silently skipped
- Edge case: skills path resolves outside cwd — silently skipped
- Edge case: skills + scratchpad both present — correct ordering `[Skills]...[Previous Context]...[Task]`
- Edge case: skills present, no scratchpad — `[Skills]...[Task]` (no `[Previous Context]` section)
- Edge case: skill file exists but contains only whitespace — file skipped, not injected
- Edge case: individual file read error — file skipped, other skills still injected
- Integration: scratchpad injection still works after refactoring to use `isInsideCwd` helper

**Verification:**
- All agent tests pass (existing + new)
- `make check` passes
- Built-in agents with `skills: .vesper/skills` work correctly when directory exists and when it doesn't

- [ ] **Unit 6: Add `skills` to built-in agent configs**

**Goal:** Configure the built-in planner, builder, and reviewer to read from `.vesper/skills/`

**Requirements:** R1 (default convention)

**Dependencies:** Units 2 and 5

**Files:**
- Modify: `.vesper/agents/builder.yml`
- Modify: `.vesper/agents/planner.yml`
- Modify: `.vesper/agents/reviewer.yml`

**Approach:**
- Add `skills: .vesper/skills` to each agent's YAML config

**Test expectation:** none — config file change, verified by running the agents

**Verification:**
- Each agent config parses correctly via `loadConfig`
- Agents skip skills gracefully when `.vesper/skills/` doesn't exist

## System-Wide Impact

- **Config resolution**: `resolveAgent` changes from `.vesper/` to `.vesper/agents/` — this is a breaking change for any project currently using `.vesper/<agent>.yml`. Pre-1.0, this is acceptable.
- **Scratchpad refactor**: Extracting `isInsideCwd` touches the scratchpad injection path. Existing scratchpad tests must continue to pass.
- **User message size**: Skills content is prepended to every API call. Large skill directories increase input token consumption. No guardrail is included (deferred per scope boundary).
- **Unchanged invariants**: Permission model, tool definitions, signal files, token budget tracking, prompt caching — all unchanged. Skills are injected into the user message only; no other API call parameters are affected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Config path change breaks existing projects | Pre-1.0; document in changelog. Migration is `mkdir .vesper/agents && mv .vesper/*.yml .vesper/*.md .vesper/agents/` |
| Large skills directory inflates API costs | Documented in scope boundaries as user's responsibility. Observable via `skills_loaded` event. |
| `isInsideCwd` refactor introduces regression in scratchpad | Existing scratchpad tests exercise the containment check; they must pass after refactoring. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-12-vesper-skill-injection-requirements.md](docs/brainstorms/2026-04-12-vesper-skill-injection-requirements.md)
- Related code: `src/agent.ts` (scratchpad injection pattern), `src/config.ts` (config parsing)
