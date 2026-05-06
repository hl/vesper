---
title: Parallel same-turn sub-agent execution
status: done
last_review_status: clean
last_reviewed_at: 2026-05-06
last_review_base: 416ae40de8035680ff0c8f8f6144cc9eafbb0fa8
last_review_head: cd5679c08edeeab6057f9781e4782cde6a991c2e
last_review_worktree: clean
last_review_diff_hash: 4eb9f4c400a06000e01d1e56e0da62f436910d903fbae359a289188479def642
---

## Context

Vesper currently exposes `subagent` and `Task` as compatibility tools for running another
configured Vesper agent. A parent agent can delegate to multiple child agents, but those tool calls
are awaited sequentially inside one parent tool loop. Review-style orchestrators that launch many
independent read-only lens agents pay the sum of all child latencies even when the work is
independent.

Vesper's runtime safety model is structural: tool availability is declared in YAML, filtered before
the model sees it, and enforced by the runtime. Parallel sub-agent execution must preserve that
model. Child agents keep their own configs, permissions, token budgets, skills, scratchpads,
context files, and temporary signal files.

Vesper is also a single-invocation runtime. This feature stays inside the existing intra-conversation
tool loop; it does not add retry, re-invocation, or workflow orchestration outside one `runAgent`
call.

This spec is informed by:

- `docs/solutions/best-practices/structural-permission-enforcement-agent-runtime-2026-04-12.md`
- `docs/solutions/best-practices/single-invocation-agent-runtime-separation-of-concerns-2026-04-13.md`
- `docs/solutions/best-practices/signal-file-context-agent-runtime-2026-04-13.md`

## Goals

- Parent agents can fan out independent read-only sub-agent work from one model response.
- Parallel sub-agent execution reduces wall-clock latency for same-turn sub-agent calls.
- Existing agents keep their current sequential behavior unless they opt in.
- Parallel execution preserves permission filtering, result ordering, child signal isolation, and
  token budget reporting.
- OpenAI agents can request same-turn parallel tool calls when the feature is enabled.

## Acceptance Criteria

1. `loadConfig` accepts an optional top-level `subagents` mapping.
2. `loadConfig` defaults `subagents.parallel_same_turn` to `false` when absent.
3. `loadConfig` rejects `subagents.parallel_same_turn` when present and not a boolean.
4. `loadConfig` defaults `subagents.max_concurrency` to `4` when absent.
5. `loadConfig` rejects `subagents.max_concurrency` when present and not a positive integer.
6. `loadConfig` defaults `subagents.aggregate_token_budget` to `null` when absent.
7. `loadConfig` rejects `subagents.aggregate_token_budget` when present and not `null` or a
   positive integer.
8. `loadConfig` defaults `parallel_safe` to `false` when absent from a child agent config.
9. `loadConfig` rejects `parallel_safe` when present and not a boolean.
10. An agent config with no `subagents` dispatch settings runs same-turn `subagent` and `Task` tool
   calls sequentially.
11. An agent config with `subagents.parallel_same_turn: true` runs same-turn read-only `subagent`
   and `Task` tool calls concurrently.
12. With `subagents.parallel_same_turn: true` and `subagents.max_concurrency: 2`, a same-turn batch
   of three read-only child calls never has more than two child agents running at the same time.
13. Tool results for concurrent child calls are appended in the same order as the original
   `tool_use` blocks.
14. A child agent whose config has any non-empty `tools.write`, `tools.delete`, or `tools.commands`
   list does not overlap execution with sibling sub-agent calls unless that child config contains
   `parallel_safe: true`.
15. A child agent with `parallel_safe: true` and non-empty `tools.write`, `tools.delete`, or
   `tools.commands` can overlap execution with sibling sub-agent calls when the parent has
   `subagents.parallel_same_turn: true`.
16. In a mixed same-turn batch, Vesper preserves request order while scheduling: it starts a
   consecutive run of parallel-eligible child calls up to `subagents.max_concurrency`; when it
   reaches a non-parallel-eligible child call, it waits for running siblings to finish, runs that
   child alone, and then resumes the next consecutive run of parallel-eligible child calls.
17. Permission-denied, depth-denied, failed, and successful child calls each produce one result for
   their original `tool_use_id`; one child failure does not remove sibling results from the parent
   tool-result message.
18. Temporary signal files for every child call are cleaned up after success, failure, permission
   denial, and depth denial.
19. Child input and output token usage appears in structured logs when `log_events: true`.
20. With `subagents.aggregate_token_budget` set, Vesper does not start another queued child call
    after completed child usage has reached or exceeded that aggregate budget.
21. When `subagents.aggregate_token_budget` prevents queued child work from starting, the blocked
    child result reports `needs_approval` and includes the aggregate budget, consumed child input
    tokens, and consumed child output tokens.
22. Parent token accounting for the parent agent's own budget still counts only the parent API
    conversation and the returned child result text, not each child agent's internal messages.
23. For OpenAI provider configs, Vesper sends `parallel_tool_calls: true` when
    `subagents.parallel_same_turn: true` and sends `parallel_tool_calls: false` when
    `subagents.parallel_same_turn` is absent or false.
24. Built-in file tools, command tools, MCP-related future tools, and the `signal` tool continue to
    execute with their existing non-parallel behavior in this phase.
25. `make check` passes after the implementation.

## Out Of Scope

- MCP server configuration or MCP tool execution.
- Generic parallel execution for file, command, or signal tools.
- Agent bundle or plugin marketplace import.
- Runtime retry, re-invocation, or workflow orchestration outside one `runAgent` call.
- Native GitHub or PR-review APIs.

## Open Questions

Open questions: none.
