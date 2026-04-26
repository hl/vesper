# Configuration Reference

Each agent is defined by a YAML file in `.vesper/agents/<name>.yml`. Vesper looks for configs locally first, then globally:

1. `.vesper/agents/<name>.yml`
2. `~/.config/vesper/agents/<name>.yml`

## Required Keys

```yaml
system_prompt: system_prompts/builder.md   # Path relative to .vesper/
token_budget: 100000                       # Max tokens per run (must be > 0)
tools:
  read: []
  write: []
  delete: []
  commands: []
```

## Full Reference

```yaml
# --- Required ---

system_prompt: system_prompts/builder.md   # Relative to .vesper/ (or ~/.config/vesper/)
token_budget: 100000                       # Max tokens the agent can consume

tools:
  read:                           # Glob patterns for read_file / list_files
    - "src/**"
    - "docs/**"
  write:                          # Glob patterns for write_file / patch_file
    - "src/**"
  delete:                         # Glob patterns for delete_file
    - "src/**"
  commands:                       # Allowed commands (see permissions docs)
    - "bun test"
    - "git commit"

# --- Optional ---

model: claude-sonnet-4-6          # Claude model ID (default: claude-sonnet-4-6)
command_timeout: 30                # Seconds before killing a command (default: 30)
max_tool_result_size: 102400      # Truncate tool results beyond this many bytes (default: 100KB)
log_denied_calls: false            # Log permission denials to stderr
log_events: false                  # Emit JSONL event stream to stderr
reveal_permissions: false          # Include allowed patterns in denial messages
default_signal: complete           # "complete" or "none" — what to write when agent stops without signaling

command_env: []                    # Extra env vars to pass to commands
                                   # PATH, HOME, USER, LANG, TERM, TMPDIR are always included

scratchpad: null                   # Path to persistent scratchpad file (relative to cwd)
skills: null                       # Path to directory of skill .md files (relative to cwd)
context_files: []                  # Project files appended to the system prompt (relative to cwd)

signals:
  complete: ".vesper-complete"
  needs_approval: ".vesper-needs-approval"
  failed: ".vesper-failed"

context_management:
  pruning: "off"                   # "off" | "always" | "threshold"
  pruning_threshold: 0.7           # Fraction of context window (0-1), used with "threshold"
  compaction_enabled: false         # Enable conversation summarization
  compaction_threshold: 0.8        # Fraction of context window that triggers compaction
  compaction_model: null            # Model for summarization (defaults to agent's model)
```

## Key Details

**`system_prompt`** is resolved relative to the vesper root (`.vesper/` or `~/.config/vesper/`), not the agents directory. A value of `system_prompts/builder.md` resolves to `.vesper/system_prompts/builder.md`.

**`tools`** arrays can be empty, which disables that tool category entirely. The tool won't appear in the API call at all — the model never sees it. See [Permissions](permissions.md) for matching rules.

**`commands`** entries must have at most 2 tokens (binary name, optionally a subcommand). Config validation rejects longer entries. `"git commit"` is valid; `"git commit -m"` is not.

**`model`** determines the context window via longest prefix match:

| Prefix | Context Window |
|--------|---------------|
| `claude-sonnet-4` | 200,000 |
| `claude-opus-4` | 200,000 |
| `claude-haiku-4` | 200,000 |
| `claude-haiku-3` | 200,000 |
| Unknown | 200,000 (fallback) |

**`default_signal`** controls what happens when the agent's conversation ends without an explicit signal. `"complete"` (default) writes the complete signal. `"none"` writes nothing — useful when the agent is expected to signal explicitly.

**`context_files`** are loaded at startup and appended to the system prompt. Each file appears as:

```
# filename.md

<file contents>
```

Files that don't exist, are empty, or resolve outside cwd via symlinks are silently skipped.

## Validation Rules

- `token_budget` must be a finite positive number
- `command_timeout` must be a finite positive number
- `max_tool_result_size` must be a finite positive number
- Threshold values must be between 0 (exclusive) and 1 (inclusive)
- All array fields must contain only strings
- Agent names cannot contain `/`, `\`, or `..`
- Signal, scratchpad, and system prompt paths are checked for symlink escapes

## Example: Minimal Agent

```yaml
system_prompt: system_prompts/helper.md
token_budget: 50000

tools:
  read:
    - "**"
  write: []
  delete: []
  commands: []
```

Read-only agent with no write, delete, or command access.

## Example: Full-Access Builder

```yaml
system_prompt: system_prompts/builder.md
token_budget: 100000
command_timeout: 60
scratchpad: ".vesper/.scratchpad-builder.md"
skills: ".vesper/skills"
context_files:
  - CLAUDE.md

context_management:
  pruning: threshold
  pruning_threshold: 0.7
  compaction_enabled: true
  compaction_threshold: 0.8

tools:
  read:
    - "**"
  write:
    - "src/**"
    - "tests/**"
    - "docs/plans/task-queue.md"
    - ".vesper/.scratchpad-builder.md"
  delete:
    - "src/**"
    - "tests/**"
    - "docs/plans/task-queue.md"
  commands:
    - "git commit"
    - "make check"
```
