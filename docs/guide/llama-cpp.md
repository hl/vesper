# llama.cpp Local Models

Vesper can run against a local `llama-server` through its OpenAI-compatible Chat
Completions endpoint. This keeps local models under the existing OpenAI provider while
using a different OpenAI API shape.

## Start llama-server

Run a model with the OpenAI-compatible server:

```sh
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 --jinja
```

`--jinja` enables chat templates used by llama.cpp for tool-calling-capable models.
Model quality and tool-calling reliability depend on the model and template you use.

## Configure an Agent

Create `.vesper/agents/local.yml`:

```yaml
system_prompt: system_prompts/local.md
token_budget: 100000
provider: openai
openai_api: chat_completions
base_url: http://127.0.0.1:8080/v1
model: local-model

tools:
  read:
    - "**"
  write:
    - "src/**"
    - "tests/**"
  delete: []
  commands:
    - "bun test"
```

Create `.vesper/system_prompts/local.md` with the agent instructions you want.

For local Chat Completions, `OPENAI_API_KEY` is optional. If it is unset, Vesper passes
a placeholder key because many OpenAI-compatible local servers ignore authentication.

## Run a Prompt

```sh
vesper run local "Read package.json and summarize the available scripts."
```

The conversation flow is the same as hosted providers: Vesper sends one prompt, exposes
only permitted tools, executes any tool calls, returns tool results, and writes the normal
signal files on completion, approval, or failure.

## Notes

- Use `openai_api: chat_completions`; llama.cpp does not need the Responses API path.
- Keep `base_url` pointed at the `/v1` root, not `/v1/chat/completions`.
- Start with read-only permissions when evaluating a new local model.
- If a model emits malformed tool call arguments, Vesper treats unparsable arguments as an
  empty object and returns normal permission or input errors through the tool loop.
