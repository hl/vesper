---
date: 2026-04-13
topic: signal-tool
---

# Signal Tool: Agent-Controlled Exit Signals

## Problem Frame

Vesper always writes a signal file on normal exit (`writeComplete` at `agent.ts:499`), which tells brr to stop iterating. Agents that process work incrementally — doing one unit of work per invocation and expecting brr to re-invoke them — have no way to say "I'm done with this iteration but the loop should continue." Every exit stops brr.

This blocks the list-processing pattern where an agent works through a queue across multiple invocations: pick a task, do it, exit, get re-invoked, pick the next task. The agent also needs a way to signal "the queue is empty, stop iterating" at runtime — a config-time default alone cannot express a decision the agent makes mid-conversation based on what it finds.

## Requirements

**Signal Tool**

- R1. Vesper exposes a `signal` tool to all agents, regardless of `default_signal` setting. The tool accepts a `type` (`complete`, `needs_approval`, or `failed`). `needs_approval` and `failed` accept an optional `message` string. `complete` does not accept a message.
- R2. When the agent calls the signal tool, vesper records the signal but does not write the file immediately. The tool returns success and the conversation continues normally.
- R3. After the conversation ends (model stops issuing tool calls), vesper checks the recorded signal and writes the corresponding file. If the agent called signal multiple times, the last call wins.
- R11. The signal tool is always available to all agents and is not subject to permission filtering. This allows any agent to override its default signal mid-conversation (e.g., an agent with `default_signal: complete` escalating to `needs_approval`).

**Default Signal Behavior**

- R4. Agent configs accept a `default_signal` field with values `complete` or `none`. Default is `complete` (backward-compatible).
- R5. When `default_signal` is `complete` and the agent never calls the signal tool, vesper writes the complete signal on normal exit — identical to today's behavior.
- R6. When `default_signal` is `none` and the agent never calls the signal tool, vesper exits without writing any signal file. brr sees nothing and starts the next iteration.

**Error and Budget Precedence**

- R7. API errors and `max_tokens` truncation still write `failed` unconditionally, regardless of any recorded signal or `default_signal` setting. These are vesper-level failures, not agent decisions.
- R8. Token budget exhaustion still writes `needs_approval` unconditionally, regardless of any recorded signal or `default_signal` setting.
- R12. Vesper-level failures (R7, R8) take precedence over any recorded agent signal. If the agent called `signal("complete")` and a subsequent API call fails, the recorded signal is discarded and `failed` is written.

**Signal File Payloads**

- R9. When the agent signals `needs_approval` or `failed` with a message, that message appears in the signal file's `context` field. Agent-initiated signals use distinct reason values: `"agent_needs_approval"` and `"agent_failed"`, to distinguish them from vesper-level signals (`"token_budget_exceeded"`, `"error"`).
- R10. When the agent signals `complete`, vesper writes an empty file (same as today).

## Success Criteria

- Single-shot agents (no config change needed) behave identically to today.
- List-processing agents with `default_signal: none` can exit without stopping brr.
- List-processing agents can signal `complete` when the work queue is empty, stopping brr.
- Agents can explicitly signal `needs_approval` or `failed` with context messages.
- Signal file payloads distinguish agent-initiated signals from vesper-level signals via the `reason` field.
- No change to brr required — it already reacts to file presence/absence.

## Scope Boundaries

- The signal tool is not a general-purpose communication channel. It only controls exit behavior.
- brr is not modified. Signal file semantics (which files brr watches, what it does when it sees them) are unchanged.
- The signal tool does not terminate the conversation. The model continues normally after calling it.
- Prompt changes to existing agents are out of scope for this feature. Agent configs can opt in via `default_signal: none` when ready.

## Key Decisions

- **Three signal types, not two**: `failed` is agent-callable, not just vesper-internal. This gives agents clean semantic separation between "I need a human" (`needs_approval`) and "this is broken" (`failed`).
- **Last-call-wins**: If the agent calls signal multiple times, the last invocation determines the outcome. Simpler than error-on-duplicate, and the agent may legitimately change its mind mid-conversation.
- **Default is `complete`**: Zero-change backward compatibility. Existing agents and configs don't need to be touched.
- **Tool, not convention**: Agents call a real tool rather than writing signal files themselves. Signal management stays in vesper.
- **No message on `complete`**: The `complete` signal writes an empty file. No consumer for a complete message exists today; trivial to add later if needed.
- **Unconditionally available**: The signal tool is available to all agents regardless of config. An agent with `default_signal: complete` may still need to escalate to `needs_approval` mid-conversation.
- **Vesper failures always win**: Error and budget paths take precedence over any recorded agent signal, preventing an agent's optimistic `signal("complete")` from masking a subsequent failure.
- **Explicit agent reason values**: `"agent_needs_approval"` and `"agent_failed"` distinguish agent-initiated signals from vesper-level `"error"` and `"token_budget_exceeded"`.

## Dependencies / Assumptions

- brr treats "no signal file" as "continue iterating." Verified: this is how brr works — it watches for specific files and acts only when they appear.

## Next Steps

-> `/ce:plan` for structured implementation planning
