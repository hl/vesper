# .vesper/ — Agent Configuration

This directory contains Vesper agent configurations, system prompts, skills, and memories.

## Directory Layout

| Directory         | Purpose                                      |
|-------------------|----------------------------------------------|
| agents/           | Agent config files (.yml)                    |
| system_prompts/   | System prompt files (.md) referenced by configs |
| skills/           | Skill files (.md) injected into agent context |
| memories/         | Project-specific notes and context            |

## Creating an Agent

1. Copy `agents/example.yml` to `agents/<name>.yml`
2. Copy `system_prompts/example.md` to `system_prompts/<name>.md`
3. Edit the config: set permissions, tools, token budget
4. Edit the system prompt: describe the agent's role and guidelines
5. Run: `vesper run <name>`

## Scratchpad

Agents can persist state via a scratchpad file (configured in the agent YAML).
The default location is `.vesper/.scratchpad.md`. Each run starts fresh context but
can read/write the scratchpad to carry forward plans and progress.

## Skills

Skill files in `skills/` are Markdown documents injected into the agent's system prompt
at startup. Use them for persistent knowledge: coding standards, API docs, common patterns.
