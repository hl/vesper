import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VesperError } from "./errors.js";

export interface InitOptions {
  force: boolean;
  global: boolean;
  cwd: string;
  home?: string;
}

const EXAMPLE_AGENT_YML = `# Agent configuration — see https://github.com/hl/vesper
# Copy this file and the matching system prompt to create your own agent.

system_prompt: system_prompts/example.md   # Relative to .vesper/
token_budget: 100000                       # Max tokens per run
max_tool_result_size: 50000                # Truncate tool results beyond this (bytes)
log_denied_calls: false                    # Log when a tool call is denied
log_events: false                          # Emit JSONL event stream to stderr
skills: ".vesper/skills"                   # Directory of skill .md files (null to disable)
scratchpad: ".vesper/.scratchpad.md"       # Persistent scratchpad file (null to disable)
context_files:                             # Project files appended to system prompt
  - CLAUDE.md

signals:
  complete: ".vesper-complete"             # Written on successful completion
  needs_approval: ".vesper-needs-approval" # Written when token budget exhausted
  failed: ".vesper-failed"                 # Written on failure

tools:
  read:                                    # Glob patterns for read_file / list_files
    - "src/**"
    - "docs/**"
  write:                                   # Glob patterns for write_file / patch_file
    - "src/**"
  delete:                                  # Glob patterns for delete_file
    - "src/**"
  commands:                                # Allowed commands (binary or binary + first arg)
    - "bun test"
    - "git commit"
`;

const EXAMPLE_SYSTEM_PROMPT = `You are a helpful agent. Describe your agent's role and capabilities here.

## Guidelines

- Read before writing. Understand the codebase before making changes.
- Follow existing patterns and conventions.
- Write tests for new behavior.
`;

const CLAUDE_MD = `# .vesper/ — Agent Configuration

This directory contains Vesper agent configurations, system prompts, skills, and memories.

## Directory Layout

| Directory         | Purpose                                      |
|-------------------|----------------------------------------------|
| agents/           | Agent config files (.yml)                    |
| system_prompts/   | System prompt files (.md) referenced by configs |
| skills/           | Skill files (.md) injected into agent context |
| memories/         | Project-specific notes and context            |

## Creating an Agent

1. Copy \`agents/example.yml\` to \`agents/<name>.yml\`
2. Copy \`system_prompts/example.md\` to \`system_prompts/<name>.md\`
3. Edit the config: set permissions, tools, token budget
4. Edit the system prompt: describe the agent's role and guidelines
5. Run: \`vesper run <name>\`

## Scratchpad

Agents can persist state via a scratchpad file (configured in the agent YAML).
The default location is \`.vesper/.scratchpad.md\`. Each run starts fresh context but
can read/write the scratchpad to carry forward plans and progress.

## Skills

Skill files in \`skills/\` are Markdown documents injected into the agent's system prompt
at startup. Use them for persistent knowledge: coding standards, API docs, common patterns.
`;

const GITIGNORE_ENTRIES = [
  ".vesper-complete",
  ".vesper-needs-approval",
  ".vesper-failed",
  ".vesper/.scratchpad*.md",
];

/**
 * Reject a path if it exists and is a symlink.
 */
function rejectSymlink(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new VesperError(`${path} is a symlink — refusing to write (security risk)`);
  }
}

/**
 * Write a file atomically: write to a temp file in the same directory, then rename.
 * This prevents TOCTOU races where a symlink could be swapped in between check and write.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpDir = mkdtempSync(join(dir, ".vesper-tmp-"));
  const tmpPath = join(tmpDir, "file");
  try {
    writeFileSync(tmpPath, content, { mode: 0o644 });
    renameSync(tmpPath, filePath);
  } finally {
    // Clean up temp dir (it will be empty after successful rename, or contain the file on failure)
    try {
      lstatSync(tmpPath);
      // If we get here, rename failed — remove the temp file
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // tmpPath doesn't exist (rename succeeded) — just remove the empty dir
      try {
        rmdirSync(tmpDir);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/**
 * Update .gitignore with vesper entries. Returns true if entries were added.
 */
function updateGitignore(gitignorePath: string): boolean {
  rejectSymlink(gitignorePath);

  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf-8");
  }

  // Parse existing lines — skip comments and whitespace
  const existingLines = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      existingLines.add(trimmed);
    }
  }

  const missing = GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) {
    return false;
  }

  let appendContent = "";
  // Add blank line separator if file doesn't end with newline
  if (content.length > 0 && !content.endsWith("\n")) {
    appendContent += "\n";
  }
  appendContent += "\n# vesper\n";
  for (const entry of missing) {
    appendContent += `${entry}\n`;
  }

  // Use append mode for .gitignore (not atomic — we need to preserve existing content)
  if (existsSync(gitignorePath)) {
    appendFileSync(gitignorePath, appendContent);
  } else {
    writeFileSync(gitignorePath, appendContent, { mode: 0o644 });
  }

  return true;
}

export async function init(options: InitOptions): Promise<void> {
  const homeDir = options.home ?? homedir();
  const root = options.global ? join(homeDir, ".config", "vesper") : join(options.cwd, ".vesper");

  // Reject symlinks on the root directory
  rejectSymlink(root);

  const created: string[] = [];

  // Determine display prefix for output
  const displayPrefix = options.global ? "~/.config/vesper" : ".vesper";

  // Create directories
  const dirs = ["agents", "system_prompts", "skills"];
  if (!options.global) {
    dirs.push("memories");
  }

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    const existed = existsSync(dirPath);
    mkdirSync(dirPath, { recursive: true });
    if (!existed) {
      created.push(`${displayPrefix}/${dir}/`);
    }
  }

  // File definitions: [relative path from root, content]
  const files: Array<[string, string]> = [
    [join("agents", "example.yml"), EXAMPLE_AGENT_YML],
    [join("system_prompts", "example.md"), EXAMPLE_SYSTEM_PROMPT],
    ["CLAUDE.md", CLAUDE_MD],
  ];

  for (const [relPath, content] of files) {
    const filePath = join(root, relPath);

    // Reject symlinks even with --force
    rejectSymlink(filePath);

    if (existsSync(filePath) && !options.force) {
      continue;
    }

    atomicWriteFile(filePath, content);
    created.push(`${displayPrefix}/${relPath}`);
  }

  // Update .gitignore (local init only)
  if (!options.global) {
    const gitignorePath = join(options.cwd, ".gitignore");
    const updated = updateGitignore(gitignorePath);
    if (updated) {
      created.push(".gitignore (updated)");
    }
  }

  // Output to stderr
  if (created.length > 0) {
    process.stderr.write("\n  Created:\n");
    for (const item of created) {
      process.stderr.write(`    ${item}\n`);
    }
  } else {
    process.stderr.write("\n  Everything already exists — nothing to create.\n");
  }

  process.stderr.write("\n  Next steps:\n");
  process.stderr.write("    1. Copy and edit example.yml to create your agent\n");
  process.stderr.write("    2. Write a system prompt in system_prompts/\n");
  process.stderr.write(`    3. Run: vesper run <agent-name>\n`);
  process.stderr.write("\n  Docs: https://github.com/hl/vesper\n\n");
}
