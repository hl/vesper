# Skills and Scratchpad

Skills and the scratchpad are two mechanisms for giving agents persistent context across invocations.

## Skills

Skills are Markdown files injected into the agent's initial user message at startup. Use them for knowledge that should be available every run: coding standards, API references, workflow instructions.

### Configuration

```yaml
skills: ".vesper/skills"   # Directory of .md files (relative to cwd)
```

Set to `null` or omit to disable.

### Loading

- All `.md` files in the directory are loaded, sorted by filename
- Symlinks pointing outside the skills directory are rejected
- Each file is injected as:

```
[Skills]

## coding-standards.md
<file contents>

## api-reference.md
<file contents>
```

### Tips

- Prefix filenames with numbers for explicit ordering: `01-standards.md`, `02-api.md`
- Keep skills focused and concise — they consume context budget every run
- Use skills for stable reference material, not ephemeral state

## Scratchpad

The scratchpad is a file that persists state between invocations. The agent reads it at the start of each run and can write to it during execution.

### Configuration

```yaml
scratchpad: ".vesper/.scratchpad-builder.md"   # Path relative to cwd
```

Set to `null` or omit to disable.

### Lifecycle

1. **Startup** — if the scratchpad exists and is non-empty, its contents are injected into the initial message:

```
[Previous Context]
<scratchpad contents>

[Task]
<stdin task>
```

2. **During execution** — the agent can write to the scratchpad via `write_file` or `patch_file` (the path must be within `tools.write` permissions)

3. **Compaction** — if context management compaction fires, the summary is automatically written to the scratchpad

### Use Cases

- **Progress tracking** — agent writes a checklist of completed steps
- **State carry-forward** — plans, decisions, discovered constraints that survive across invocations
- **Handoff notes** — one agent writes context for the next

### Tips

- Add `.vesper/.scratchpad*.md` to `.gitignore` (`vesper init` does this)
- The scratchpad is just a file — you can read or clear it manually between runs
- Keep it short. Large scratchpads eat into the agent's context budget.

## Message Composition Order

When both skills and scratchpad are present, the initial user message is composed as:

```
[Skills]
<all skill files>

[Previous Context]
<scratchpad contents>

[Task]
<stdin task>
```

When only one is present, the other section is omitted.
