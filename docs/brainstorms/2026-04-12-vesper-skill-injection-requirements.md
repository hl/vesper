---
date: 2026-04-12
topic: vesper-skill-injection
---

# Vesper Skill Injection

## Problem Frame

Vesper agents start each run with no memory of prior work. In iterative workflows, agents repeat mistakes, miss project conventions, and can't benefit from patterns discovered in earlier iterations.

A persistent skill system solves this: skill files capture reusable patterns and project knowledge, and agents read them at startup to inform their work. Vesper is responsible for injecting skill content into agent context. How skill files are created (manually, by a dedicated agent, or by an external orchestrator) is outside Vesper's scope.

## Requirements

**Skill directory configuration**

- R1. Agent YAML config accepts an optional `skills` field — a directory path relative to cwd containing skill files.
- R2. The skills directory must resolve inside cwd (same containment check as scratchpad). If it resolves outside, skill injection is silently skipped (consistent with scratchpad behavior).

**Skill reading**

- R3. At agent start (before the first iteration), if `skills` is configured, read all `.md` files from the directory. Non-`.md` files are ignored.
- R3a. Skill files are sorted lexicographically by filename before injection, ensuring deterministic ordering across platforms and runs.
- R4. Reading is non-recursive — only top-level files in the skills directory are read.
- R5. If the directory does not exist, is not a directory (e.g., a regular file), or contains no `.md` files, skill injection is silently skipped.
- R6. Skills are read once at startup, not per-iteration. They do not change during a Vesper run.

**Skill injection**

- R7. Skill contents are injected into the user message (task prompt), before scratchpad content and the task itself. Injection order: `[Skills]` → `[Previous Context]` (scratchpad) → `[Task]` (prompt). Skills content, loaded once at startup, is prepended to the user message on every iteration (consistent with scratchpad injection, which also rebuilds the user message each iteration). When scratchpad is not configured, the `[Previous Context]` section is omitted.
- R8. Each skill is separated by a heading using the filename (e.g., `## config-patterns.md`) so the agent can distinguish between skills.
- R9. Skills are read-only at the runtime level. The skill injection mechanism never writes to the skills directory. Agents may write to it via normal `write_file` if their permissions allow.

**Observability**

- R10. When `log_events` is enabled, emit a `skills_loaded` event at startup listing the number of files read and total byte count.

## Success Criteria

- All existing tests continue to pass
- Skill injection has dedicated test coverage (directory exists/missing/empty, jail check, injection ordering with scratchpad)
- `make check` passes
- Agents receiving skills can reference skill content in their work

## Scope Boundaries

- No frontmatter parsing — Vesper reads raw file content, not structured metadata
- No relevance filtering — all skills in the directory are injected. Curation is the caller's responsibility.
- No size limiting on skill content — if the directory has too much content, the user curates it
- No skill writing by the runtime — skill creation is outside Vesper's scope
- No recursive directory reading — flat directory only

## Key Decisions

- **Skills in user message, not system prompt**: The system prompt is the agent's persona (defined by the `.md` file). Skills are situational context, like scratchpad content. Injecting into the user message keeps the system prompt stable and cacheable.
- **Read once at startup, not per-iteration**: Skills written during the current run are intended for future runs, not the current one. Reading once at startup is correct because mid-run changes to the skills directory do not need to affect the running agent, and it avoids redundant I/O.
- **No frontmatter parsing**: Keeps Vesper simple. Skill authors can use frontmatter for their own organization, but Vesper doesn't need to understand it — it just injects the content.
- **Standalone feature**: Skill injection is a distinct capability that builds on top of the existing codebase. It shares patterns with scratchpad injection but introduces no dependencies on other planned work.

## Dependencies / Assumptions

- Skill files are Markdown and should be useful to LLM agents (the intended consumers)
- The skills directory may be empty or nonexistent on first run. Skills accumulate over time as they are created (manually or by external tooling).

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R7][Technical] Exact prompt template when all three sections (skills, scratchpad, task) are present — verify that the ordering is clear to Claude models
- [Affects R3][Technical] Whether `.md` file reads that fail mid-directory (e.g., permission denied on one file) should skip the file or abort skill injection entirely

## Convention

All Vesper project state lives under `.vesper/`:

```
.vesper/
  agents/                    # agent definitions
    builder.yml              #   agent config
    builder.md               #   agent system prompt
    planner.yml
    planner.md
    reviewer.yml
    reviewer.md
  skills/                    # skill files (read by Vesper at startup)
    test-patterns.md
    config-conventions.md
  .scratchpad-builder.md     # per-agent scratchpad
  .scratchpad-planner.md
```

Note: this changes the config resolution path from `.vesper/<agent>.yml` to `.vesper/agents/<agent>.yml`. The home fallback (`~/.config/vesper/<agent>.yml`) remains unchanged.

## Config Schema Addition

```yaml
skills: ".vesper/skills"    # optional, default: null (no skill injection)
```

## Next Steps

-> `/ce:plan` for structured implementation planning
