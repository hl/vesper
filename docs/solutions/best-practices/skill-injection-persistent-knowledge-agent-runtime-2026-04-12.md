---
title: "Persistent Skill Injection in Long-Running Agent Runtimes"
date: 2026-04-12
category: best-practices
module: agent-runtime
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Building an agentic CLI where the same agent runs repeatedly across tasks"
  - "Wanting agents to accumulate knowledge written by other agents or humans"
  - "Using prompt caching and needing to keep the system prompt stable"
  - "Running agents in iterative workflows via an external orchestrator"
tags:
  - agent-runtime
  - context-management
  - prompt-caching
  - skills
  - persistent-knowledge
---

# Persistent Skill Injection in Long-Running Agent Runtimes

## Context

Iterative agent workflows start each run with no memory of prior iterations. The agent repeats mistakes, misses project conventions, and cannot benefit from patterns discovered in earlier runs. A scratchpad solves short-term continuity within a session but does not address cross-run learning written by external tooling.

This pattern was identified while adding skill injection to Vesper (a permission-gated agent CLI) after studying how Magus handles persistent learning via its scribe agent.

## Guidance

Implement a "skills" directory: a set of Markdown files that an external process (orchestrator, human, or post-run summarizer) writes between runs. The agent runtime reads these files once at startup and injects them into the user message as a `[Skills]` section prepended to the task.

### Key design rules

1. **Inject into user message, not system prompt.** The system prompt is the agent persona and should be stable (cache-friendly). Skills are situational, change across runs, and belong in the turn context.

2. **Read once at startup, not per-iteration.** Skills are written between runs by external tooling, never during a run. Reading inside the iteration loop wastes I/O and produces no benefit.

3. **Graceful degradation at every boundary.** Missing directory, not-a-directory, empty directory, whitespace-only files, and individual read errors all silently skip. Partial skills are always better than a fatal error.

4. **Deterministic ordering.** Sort files lexicographically so injection order is consistent across platforms and runs.

5. **Reuse containment checks.** Extract path containment logic (realpathSync + cwd check) into a shared helper rather than duplicating it across scratchpad and skills.

### Implementation pattern

Load skills once before the iteration loop, compose inside:

```typescript
const skillsContent = config.skills !== null
  ? loadSkills(config.skills, cwd, logger)
  : null;

// Inside iteration loop — four-case composition:
if (skillsContent !== null && scratchpadContent !== null) {
  userContent = `${skillsContent}\n\n[Previous Context]\n${scratchpadContent}\n\n[Task]\n${taskPrompt}`;
} else if (skillsContent !== null) {
  userContent = `${skillsContent}\n\n[Task]\n${taskPrompt}`;
} else if (scratchpadContent !== null) {
  userContent = `[Previous Context]\n${scratchpadContent}\n\n[Task]\n${taskPrompt}`;
}
```

The `loadSkills` function: resolve path, containment check, stat (must be directory), readdir, filter `.md`, sort, read each file (skip on error or whitespace-only), compose with `## filename.md` headings. Returns the composed string or null.

### Directory convention

```
.vesper/
  agents/           # agent definitions (yml + md)
  skills/           # skill files (read at startup)
  .scratchpad-*     # per-agent iteration state
```

Separating agent definitions from runtime state makes the directory structure express intent and prevents config from being polluted by transient output files.

## Why This Matters

Without persistent learning, each agent run is a blank slate. The agent pays the cost of rediscovering conventions, re-encountering known failure modes, and re-reasoning through patterns that were already solved. Skills let the orchestration layer accumulate knowledge over time and push it back into the agent's context — without polluting the stable system prompt or requiring the agent to manage its own memory during a run.

The separation keeps responsibilities clear: the agent does work; the orchestrator (or human) distills lessons; the skills directory is the handoff point.

## When to Apply

- Any agent CLI invoked repeatedly by an orchestrator across multiple runs on the same project
- When post-run analysis can identify patterns worth preserving (recurring mistakes, conventions, effective strategies)
- When the system prompt is intentionally stable (cached persona) and cannot absorb run-specific context
- When a scratchpad alone is insufficient because its content is scoped to a single session

Not applicable when: the agent runs once and exits; skills would be written and read in the same run (use scratchpad instead); or the agent has native memory that handles cross-run continuity.

## Examples

A skill file written by an orchestrator after observing a repeated mistake:

```markdown
# Prefer Edit over Write

When modifying existing files, always use the Edit tool rather than Write.
Write overwrites the entire file and loses line-level diff visibility.
Only use Write when creating a file that does not yet exist.
```

Resulting injected user message:

```
[Skills]

## 01-prefer-edit-over-write.md
When modifying existing files, always use the Edit tool...

## 02-always-check-test-output.md
After any code change, run the test suite...

[Previous Context]
Modified src/runner.ts — added retry logic. Tests passed.

[Task]
Finish the error message formatting for the retry path in src/runner.ts.
```

The lexicographic prefix (`01-`, `02-`) gives the orchestrator explicit control over injection order.

## Related

- `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md` — covers the containment check pattern that skill injection reuses
- `docs/brainstorms/2026-04-12-vesper-skill-injection-requirements.md` — requirements document
- `docs/plans/2026-04-12-004-feat-skill-injection-plan.md` — implementation plan
