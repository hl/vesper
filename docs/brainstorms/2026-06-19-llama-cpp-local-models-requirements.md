---
date: 2026-06-19
topic: llama-cpp-local-models
---

# llama.cpp Local Model Support

## Summary

Vesper should complete a single prompt against a bare `llama-server` local model with the
same agent loop it uses for hosted providers: send the prompt, process tool calls, return
tool results, and finish with the final response or signal.

---

## Problem Frame

Vesper currently has hosted-provider adapters for Anthropic and OpenAI. The OpenAI path is
Responses-shaped, while the local llama.cpp setup users can run directly is centered on an
OpenAI-compatible Chat Completions route. A local-model user should not need LM Studio or a
Responses-compatible wrapper to run a normal Vesper agent.

The product goal is not to make local models equivalent to hosted frontier models. It is to
make the runtime path work: one prompt enters Vesper, the model can use Vesper's structural
tool surface, and the invocation exits through the existing signal model.

---

## Key Decisions

- **Target bare llama.cpp first.** The first local-model path is for `llama-server`, not
  LM Studio or every OpenAI-compatible local server.
- **Use Chat Completions for local llama.cpp.** Vesper should meet the API surface normal
  llama.cpp deployments expose instead of requiring `/v1/responses`.
- **Keep local model support endpoint-based.** Local llama.cpp is a configurable endpoint
  path, not a new agent identity unless implementation proves a provider split is needed.
- **Treat tool calling as required.** A Vesper run without tool calls cannot execute the
  existing read/write/command loop that makes the runtime useful.

---

## Requirements

**Agent Invocation**

- R1. A Vesper agent can be configured to send its model calls to a local
  `llama-server` Chat Completions endpoint.
- R2. A single prompt run against local llama.cpp follows the same lifecycle as hosted
  providers: prepare tools, call the model, execute requested tools, feed results back,
  and finish when the model stops or the runtime writes a terminal signal.
- R3. Local llama.cpp support does not require LM Studio, cloud credentials, or a hosted
  model account.

**Tool Calling**

- R4. Vesper exposes the same permitted tool set to the local model that it would expose
  for an equivalent hosted-provider run.
- R5. Vesper accepts llama.cpp tool-call responses and converts them into the existing
  internal tool-use shape without changing tool permission enforcement.
- R6. Vesper sends tool results back to llama.cpp in the Chat Completions-compatible form
  needed for the model to continue the conversation.
- R7. If the local model or server cannot perform tool calling, Vesper fails with an
  operator-facing error instead of silently completing a degraded no-tool run.

**Configuration and Operator Experience**

- R8. The local llama.cpp setup path documents the minimum server shape needed for Vesper,
  including a running `llama-server`, a loaded model, a Chat Completions endpoint, and
  tool-call-capable server/model configuration.
- R9. Local endpoint configuration supports the common no-real-key case used by local
  OpenAI-compatible servers.
- R10. Unknown local model context windows use Vesper's existing conservative fallback
  behavior unless a more specific model window is configured in a later feature.

**Compatibility and Safety**

- R11. Existing Anthropic and OpenAI-hosted behavior remains unchanged for current agent
  configs.
- R12. Local llama.cpp support preserves Vesper's structural safety model: tool
  availability is still derived from config permissions, not from model instructions.
- R13. The implementation is covered by adapter-level tests plus at least one practical
  smoke test shape that proves a local Chat Completions tool loop can complete.

---

## Key Flow

- F1. Single-prompt local run
  - **Trigger:** The operator runs a Vesper agent configured for local llama.cpp with a
    task prompt.
  - **Steps:** Vesper resolves config, sends the prompt and permitted tools to the local
    endpoint, executes any requested tools, returns tool results, and repeats until the
    model produces a final answer or the runtime exits through a signal.
  - **Outcome:** The invocation completes with the same observable contract as hosted
    provider runs.
  - **Covered by:** R1, R2, R4, R5, R6, R12.

---

## Acceptance Examples

- AE1. Basic final answer
  - **Covers:** R1, R2, R3.
  - **Given:** A local `llama-server` is running with a compatible model.
  - **When:** The agent prompt can be answered without tools.
  - **Then:** Vesper returns the model's final response and writes the configured terminal
    signal.

- AE2. Tool loop completion
  - **Covers:** R4, R5, R6, R12.
  - **Given:** The agent has permission to read a file and the local model requests that
    tool.
  - **When:** Vesper receives the tool call from llama.cpp.
  - **Then:** Vesper enforces the configured permission, returns the tool result to the
    model, and continues the same invocation.

- AE3. Tool calling unavailable
  - **Covers:** R7, R8.
  - **Given:** The local server or loaded model does not support usable tool calls.
  - **When:** The agent needs a Vesper tool to complete the prompt.
  - **Then:** Vesper surfaces a clear failure rather than pretending the run completed
    successfully.

---

## Success Criteria

- `make check` passes after implementation.
- Existing Anthropic and OpenAI-hosted tests continue to pass.
- A documented local `llama-server` setup can complete a simple single-prompt Vesper run.
- A documented local `llama-server` setup can complete at least one Vesper tool-call loop.

---

## Scope Boundaries

- No LM Studio-specific setup, detection, or troubleshooting in the first pass.
- No requirement to support `/v1/responses` for local models.
- No guarantee that every GGUF model will make good tool-use decisions.
- No streaming support.
- No automatic model download, model launch, or llama.cpp process management.
- No changes to Vesper's single-conversation-per-invocation runtime model.

---

## Dependencies / Assumptions

- Operators provide and run `llama-server` themselves.
- The selected local model and llama.cpp server configuration can produce OpenAI-style
  tool calls.
- Local-server response quirks may require tolerant parsing where doing so does not weaken
  Vesper's permission or signal semantics.

---

## Sources / Research

- `src/config.ts` currently validates providers as `anthropic` or `openai`.
- `src/agent.ts` currently adapts OpenAI through the Responses API.
- `README.md` and `docs/guide/configuration.md` describe OpenAI support as hosted
  OpenAI Responses usage.
- llama.cpp documents OpenAI-style function calling for `llama-server` when tool support
  is enabled through the server's chat-template path.
