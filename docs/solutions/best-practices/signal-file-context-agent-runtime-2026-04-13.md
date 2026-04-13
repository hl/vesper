---
title: "Configurable Signal File Content for Agent-Orchestrator Communication"
date: 2026-04-13
category: best-practices
module: agent-runtime
problem_type: best_practice
component: tooling
severity: low
applies_when:
  - "An agent runtime communicates status to an orchestrator via signal files"
  - "The orchestrator displays signal file content to the user"
  - "Budget exhaustion or failure signals need meaningful context beyond generic messages"
tags:
  - signal-files
  - agent-orchestrator
  - brr-integration
  - context-propagation
---

# Configurable Signal File Content for Agent-Orchestrator Communication

## Context

Vesper writes signal files (`.vesper-complete`, `.vesper-needs-approval`, `.vesper-failed`) to communicate status to callers like brr. The `needs_approval` and `failed` signals are JSON payloads with `reason`, `agent`, and `message` fields. Before this change, the message was always generic ("Token budget of X exhausted after Y input and Z output tokens"). brr reads and prints this content to the user, so a generic message wastes a valuable communication channel.

The agent's last text response — which often contains meaningful context like "Completed tasks 1-3, task 4 requires human review" — was available in the API response but discarded at signal write time.

## Guidance

Add a `context` field to signal payloads containing the agent's last text output from the API response. Extract the last non-empty `TextBlock` from `response.content`, truncate to a reasonable limit (1000 chars), and include it alongside the existing fields.

```typescript
// Extract last meaningful text from an API response
export function extractLastText(response: Anthropic.Message): string | null {
  for (let i = response.content.length - 1; i >= 0; i--) {
    const block = response.content[i];
    if (block.type === "text" && block.text.trim().length > 0) {
      const text = block.text.trim();
      return text.length > MAX_CONTEXT_LENGTH ? text.slice(0, MAX_CONTEXT_LENGTH) : text;
    }
  }
  return null;
}
```

Key design choices:
- **Scan backwards** through content blocks to get the most recent text (responses may have multiple text blocks interleaved with tool use blocks).
- **Skip whitespace-only blocks** — these carry no useful context.
- **Truncate to 1000 chars** — signal files should stay small. The context is a hint for the user, not a full transcript.
- **`null` when unavailable** — error paths that fire before any API response (config errors, connection failures) pass `null` explicitly. The field is always present in the JSON, never omitted.
- **Optional parameter on `writeFailed`** — callers in `index.ts` (CLI-level errors) don't have a response, so `context` defaults to `null` when not provided. `writeNeedsApproval` requires it since budget exhaustion always has a response.

## Why This Matters

Signal files are the only communication channel between Vesper (the agent runtime) and brr (the orchestrator). Every signal write is an opportunity to give the user actionable context. A generic "budget exhausted" message forces the user to dig through logs. The agent's last text often contains exactly the context they need — what was accomplished, what's blocked, what needs attention.

## When to Apply

- Any agent runtime that writes structured status files read by an orchestrator
- When the status file content is displayed to users (not just machine-parsed)
- When the agent has a natural-language output channel that carries state information

## Examples

**Before:**
```json
{
  "reason": "token_budget_exceeded",
  "agent": "builder",
  "message": "Token budget of 100000 exhausted after 60000 input and 42000 output tokens."
}
```

**After:**
```json
{
  "reason": "token_budget_exceeded",
  "agent": "builder",
  "message": "Token budget of 100000 exhausted after 60000 input and 42000 output tokens.",
  "context": "I've completed tasks 1-3. Task 4 requires modifying the auth module which needs human review."
}
```

## Related

- [CLI Distribution and Scaffolding](cli-distribution-scaffolding-bun-agent-runtime-2026-04-12.md) — the v0.4 distribution work that preceded this feature
- [Structural Permission Enforcement](structural-permission-enforcement-agent-runtime-2026-04-12.md) — the signal file paths are validated against the same containment rules
