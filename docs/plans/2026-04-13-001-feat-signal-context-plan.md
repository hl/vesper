---
title: "feat: Include agent's last text output in signal files"
type: feat
status: active
date: 2026-04-13
origin: docs/brainstorms/2026-04-13-vesper-signal-context-requirements.md
---

# feat: Include agent's last text output in signal files

## Overview

Add a `context` field to `needs_approval` and `failed` signal files containing the agent's last text output from the API response. This gives callers (brr) meaningful context instead of generic budget/error messages.

## Requirements Trace

- R1. Signal files include agent's last text output as a `context` field

## Scope Boundaries

- No change to signal file format (additive field only)
- No change to `complete` signal (stays empty)

## Key Technical Decisions

- **Extract from response.content, not conversation history**: The last API response is already available at every signal write site. No need to track state across iterations.
- **Truncate to 1000 chars**: Signal files should stay small. The context is a hint, not a transcript.
- **`context: null` when unavailable**: Error paths that fire before any API response (e.g., config errors in `index.ts`) don't have agent text. Pass `null` explicitly.

## Implementation Units

- [x] **Unit 1: Add context extraction and pass to signal writers**

**Goal:** Extract last text block from API responses and include in signal payloads.

**Files:**
- Modify: `src/signals.ts`
- Modify: `src/agent.ts`
- Modify: `tests/signals.test.ts`
- Modify: `tests/agent.test.ts`

**Approach:**
- Add helper function `extractLastText(response: Anthropic.Message): string | null` in `agent.ts` — scans `response.content` for the last block with `type === "text"`, returns `.text` truncated to 1000 chars, or `null`.
- Add `context` parameter (type `string | null`) to `writeNeedsApproval` and `writeFailed` in `signals.ts`. Include in the JSON payload.
- At each signal write site in `agent.ts`, pass the extracted text. For error catches before any response exists, pass `null`.
- Update `writeFailed` calls in `index.ts` to pass `null` (no response available at CLI level).

**Test scenarios:**
- `writeNeedsApproval` includes `context` field in JSON output
- `writeFailed` includes `context` field in JSON output
- `context` is `null` when no text block in response
- `context` is truncated to 1000 chars when text is longer
- Existing signal file assertions still pass (additive change)
