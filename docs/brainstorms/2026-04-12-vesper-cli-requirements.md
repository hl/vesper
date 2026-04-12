---
title: Vesper — Permission-gated Agent CLI
status: accepted
date: 2026-04-12
---

# Vesper — Permission-gated Agent CLI

## Problem Frame

Existing agent runtimes give LLMs broad tool access and rely on prompt instructions for safety. This is fundamentally fragile — a sufficiently persuasive prompt or reasoning chain can override instructional boundaries.

Vesper inverts this: safety boundaries are structural, not instructional. An agent's permitted tool surface is declared in a YAML config and enforced by the runtime before any tool result reaches the LLM. The agent cannot exceed its permissions regardless of what it reasons or decides.

## Users and Use Cases

- **Developers building multi-agent pipelines** — define agent personas with scoped capabilities, chain them via queue files
- **Teams wanting auditable agent behavior** — YAML configs make permissions reviewable and diffable
- **Anyone running Claude against a codebase** — constrain what the agent can read, write, delete, and execute

## Requirements

### Core

1. CLI binary loads a named agent persona from two files: YAML config (structural constraints) and Markdown file (system prompt)
2. Config resolution: check `<cwd>/.vesper/<agent>.yml` + `.md`, fall back to `~/.config/vesper/`
3. Task prompt read from stdin — binary blocks until EOF
4. All tool calls gated by allow-list permissions enforced by the runtime
5. Five tools: `read_file`, `list_files`, `write_file`, `patch_file`, `delete_file`, `run_command`
6. Permission denial returns `{ error: "permission_denied" }` with no detail about the allow-list
7. Paths resolving outside `cwd` always denied regardless of allow-list
8. Command matching: binary-only entries permit any args; binary+subcommand entries match the first arg exactly
9. Completion model via watch file: empty/missing = complete, no progress = failed, no watch file = run to caller limit
10. Signal files (complete, needs-approval, failed) written to cwd with caller-controlled names via env vars
11. Token budget tracked cumulatively across iterations; exhaustion writes needs-approval signal and exits 0
12. Each iteration is a fresh API conversation — no context accumulation between iterations

### Non-functional

13. Compiled to a single native binary with `bun build --compile`
14. Runs on Linux and macOS
15. `make check` passes (typecheck + lint + test)

## Key Decisions

### Scratchpad file for inter-iteration continuity (Option B)

**Context:** Each iteration starts with a fresh API conversation. The agent has no memory of previous iterations. This is by design (bounded token usage, predictable behavior), but it means tasks must either be completable in a single iteration or the agent needs another mechanism for continuity.

**Alternatives considered:**

- **A. Fresh context, atomic tasks (status quo)** — Forces all tasks to be completable in one conversation. Simple runtime, but failures are silent (partial work on disk with no coordination).
- **B. Scratchpad file (chosen)** — System prompt instructs the agent to read/write a scratchpad file at iteration boundaries. Zero runtime changes. Worst case degrades to Option A behavior.
- **C. Runtime context carry-forward** — Accumulate conversation across iterations within the same task. Significantly more complex runtime, breaks the clean "fresh context per iteration" invariant, introduces task-boundary detection bugs.

**Decision:** Option B. The scratchpad is a system prompt concern, not a runtime feature. Built-in agent prompts instruct the agent to maintain a scratchpad at `docs/plans/.scratchpad-<agent>.md`. The runtime is unaware of it — it's just another file the agent reads and writes using existing tools.

**Why:** Preserves the spec's core invariant (fresh context per iteration) while solving the continuity problem. Failure mode is strictly better than or equal to no scratchpad. Makes agent reasoning observable (humans can read the scratchpad).

## Scope Boundaries

- No streaming API — non-streaming only
- No context carry-forward in the runtime
- No interactive terminal mode — stdin must be piped
- No plugin system or dynamic tool loading
- No retry logic for API errors
- System prompt files are opaque strings — no templating or frontmatter
- The binary never creates or seeds queue/watch files

## Success Criteria

- `make check` exits 0
- `make build` produces a single binary named `vesper`
- `echo "test" | vesper nonexistent` exits 1 with a message identifying missing config files
- `echo "test" | vesper planner` with empty watch file writes complete signal and exits 0 without API calls
- All test cases pass
- Binary compiles and runs on Linux and macOS

## Technical Spec

The full technical specification (tool signatures, config schema, conversation loop, test suite, built-in agent configs) is captured in the original spec document provided at project inception. This requirements doc captures the product decisions and the one design decision (scratchpad pattern) made during brainstorming.
