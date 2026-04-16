# Troubleshooting

## Stale signal file found

```
Error: Stale signal file found: .vesper-complete
```

A signal file from a previous run still exists. Clean it up:

```sh
rm .vesper-complete .vesper-needs-approval .vesper-failed 2>/dev/null
```

If you're using an orchestrator, it should clean these up before each run.

## Permission denied (opaque)

```json
{ "error": "permission_denied" }
```

The agent tried to access a file or run a command outside its allowed patterns. To debug:

1. Set `reveal_permissions: true` in the agent config to see what was attempted and what's allowed
2. Set `log_denied_calls: true` to log denials to stderr
3. Check glob patterns in `tools.read` / `tools.write` / `tools.delete` / `tools.commands`

Common causes:
- Path doesn't match any glob pattern
- Symlink resolves to a location outside cwd
- Command not in the `commands` list, or subcommand doesn't match

## Command permission rejected at config load

```
Error: Invalid command entry: "git commit -m" — at most 2 tokens allowed
```

Command entries in `tools.commands` can have at most 2 space-separated tokens: a binary name and optionally a subcommand. `"git commit"` is valid; `"git commit -m"` is not.

The agent can still run `git commit -m "message"` — the permission only checks the binary and first argument.

## Context overflow

```
Error: Context overflow — estimated tokens exceed 95% of model window
```

The conversation grew too large for the model's context window. Options:

1. Enable pruning: `context_management.pruning: threshold`
2. Enable compaction: `context_management.compaction_enabled: true`
3. Reduce `max_tool_result_size` to limit individual tool results
4. Reduce `token_budget` to stop the agent sooner
5. Split the task into smaller pieces

## Compaction failed

Compaction produces a structured summary via an extra API call. It fails when:

- The summary is truncated (`stop_reason: "max_tokens"`) — the conversation is too complex to summarize within the compaction token limit
- The summary is empty

Both cases write the `failed` signal. The agent cannot continue.

To recover, reduce the work per invocation or increase the token budget for the compaction model.

## max_tokens truncation

```
Error: Response truncated (stop_reason: max_tokens)
```

The model's response was cut off at the per-call output limit. This is a hard error — Vesper does not retry or attempt to continue the response.

This usually means the model tried to output more than 4096 tokens in a single response. Breaking the task into smaller steps typically resolves this.

## System prompt not found

```
Error: System prompt not found: system_prompts/builder.md
```

The `system_prompt` path in the agent config is resolved relative to the vesper root (`.vesper/` or `~/.config/vesper/`). Check:

1. The file exists at `.vesper/system_prompts/builder.md`
2. The path in the YAML doesn't have a leading `.vesper/` (it's already relative to that directory)

## Agent config not found

```
Error: Agent "builder" not found
```

Vesper looks in two locations:

1. `.vesper/agents/builder.yml`
2. `~/.config/vesper/agents/builder.yml`

Check that the file exists and the name matches (without the `.yml` extension).

If you see a message about migrating from the old path format, move your config from `.vesper/builder.yml` to `.vesper/agents/builder.yml`.

## Token budget exhausted

When the agent's cumulative token usage exceeds `token_budget`, Vesper writes the `needs_approval` signal and exits with code 0. This is not an error — it's a checkpoint.

To continue, increase `token_budget` or re-invoke the agent (with scratchpad for state continuity).

## Empty stderr JSONL events

If `log_events: true` but you see no output, check that you're reading stderr, not stdout:

```sh
echo "task" | vesper run builder 2>events.jsonl
```
