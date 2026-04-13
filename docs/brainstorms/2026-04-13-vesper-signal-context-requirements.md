# Vesper Signal File Context

**Date:** 2026-04-13
**Status:** Draft

## Problem

When vesper writes `.vesper-needs-approval` on budget exhaustion, the signal file contains a generic message ("Token budget of X exhausted after Y input and Z output tokens"). brr reads and prints this file content to the user. The agent's last text output — which often contains meaningful context like "Completed tasks 1-3, task 4 requires approval" — is available in the API response but discarded.

## Goals

1. The `needs_approval` signal file includes the agent's last text output alongside the budget info.
2. The `failed` signal file includes the agent's last text output when available (e.g., on `no_progress`).

## Non-Goals

- Changing the signal file format (stays JSON with `reason`, `agent`, `message` fields).
- Adding new signal types.
- Changing `complete` signal (stays empty file).

## R1: Capture Last Text Output in Signal Files

Extract the last text block from the most recent API response and include it in the signal payload as a `context` field.

**`needs_approval` payload (budget exhaustion):**
```json
{
  "reason": "token_budget_exceeded",
  "agent": "builder",
  "message": "Token budget of 100000 exhausted after 60000 input and 42000 output tokens.",
  "context": "I've completed tasks 1-3. Task 4 requires modifying the auth module which needs human review."
}
```

**`failed` payload (no_progress, error):**
```json
{
  "reason": "no_progress",
  "agent": "builder",
  "message": "Watch file line count unchanged for 3 iterations",
  "context": "I attempted to fix the failing test but the approach didn't work. The issue is in the database connection pooling logic."
}
```

**Extraction logic:** Scan `response.content` for the last `TextBlock`, take its `.text` value. If no text block exists, `context` is `null`. Truncate to a reasonable limit (1000 chars) to avoid giant signal files.

**Acceptance criteria:**
- `needs_approval` signal includes `context` field with last agent text (or `null`)
- `failed` signal includes `context` field when a response is available (budget/no_progress cases have a response; early errors may not)
- Existing brr integration is not broken (new field is additive)
- `context` is truncated to 1000 characters max
