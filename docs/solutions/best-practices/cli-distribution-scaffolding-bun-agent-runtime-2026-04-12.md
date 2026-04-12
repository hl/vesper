---
title: "CLI Distribution and Project Scaffolding for Bun/TypeScript Agent Runtimes"
date: 2026-04-12
category: best-practices
module: agent-runtime
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Distributing a Bun/TypeScript CLI as a single compiled binary via Homebrew"
  - "Adding a project scaffolding subcommand to an existing CLI"
  - "Restructuring a single-command CLI to subcommands while maintaining backwards compatibility"
  - "Cross-compiling a Bun binary for multiple targets via GitHub Actions"
related_components:
  - development_workflow
  - documentation
tags:
  - cli-distribution
  - homebrew
  - bun
  - cross-compilation
  - github-actions
  - project-scaffolding
  - atomic-writes
  - symlink-rejection
  - yargs
  - backwards-compatibility
---

# CLI Distribution and Project Scaffolding for Bun/TypeScript Agent Runtimes

## Context

Vesper v0.3 had a flat `.vesper/` directory (agent `.yml` files co-located with paired `.md` system prompts) and a single CLI entry point (`vesper <agent>`). This created friction: no way to install without cloning and building from source, no scaffolding for new projects, a directory layout that mixed two concerns, and no clear path to adding subcommands without breaking existing callers. The `system_prompt` path was resolved relative to the config file's directory rather than a stable root, making the layout rigid.

v0.4 addressed all of these as five interlocking patterns. (session history)

## Guidance

### 1. Subcommand Restructure with Backwards-Compatible Default

Use yargs `$0 [agent]` as a hidden fallback command alongside explicit named subcommands. This preserves the v0.3 calling convention (`vesper <agent>`) while adding `vesper run <agent>` and `vesper init`. The `false` second argument marks the default command hidden from `--help` output.

Gate agent names against a reserved list in the CLI layer (the `run` handler), not in the config module — the config module shouldn't know about CLI subcommand names. (session history: this was an explicit architectural decision during v0.4 planning)

```typescript
// src/index.ts — handler-free parser for testability
export function buildParser(argv: Argv): Argv {
  return argv
    .scriptName("vesper")
    .version(VERSION)
    .option("cwd", { type: "string", default: process.cwd(), global: true })
    .command("run <agent>", "Run a Vesper agent", (y) =>
      y.positional("agent", { type: "string", demandOption: true }))
    .command("init", "Scaffold a .vesper/ project directory", (y) =>
      y.option("force", { type: "boolean", default: false })
       .option("global", { type: "boolean", default: false }))
    .command("$0 [agent]", false)  // hidden backwards compat
    .strict();
}
```

The parser is handler-free — `main()` inspects `argv._[0]` to dispatch. This makes `buildParser` directly testable via `parseArgs(["run", "builder"])` without mocking `process.exit` or stdin.

### 2. Atomic File Writes with Symlink Rejection

When scaffolding files in user-controlled directories, check for symlinks with `lstatSync` (not `statSync`, which follows symlinks) before writing, then write atomically using temp file + `renameSync`.

```typescript
// src/init.ts
function rejectSymlink(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new VesperError(`${path} is a symlink — refusing to write (security risk)`);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpDir = mkdtempSync(join(dir, ".vesper-tmp-"));
  const tmpPath = join(tmpDir, "file");
  try {
    writeFileSync(tmpPath, content, { mode: 0o644 });
    renameSync(tmpPath, filePath);  // atomic on POSIX when same filesystem
  } finally {
    // cleanup: remove tmpDir whether rename succeeded or failed
    try { lstatSync(tmpPath); rmSync(tmpDir, { recursive: true, force: true }); }
    catch { try { rmdirSync(tmpDir); } catch { /* best effort */ } }
  }
}
```

The temp dir is created in the same directory as the target so `renameSync` stays on the same filesystem. This pattern was adopted from brr's `internal/scaffold/scaffold.go`. (session history: the structural permission enforcement pattern — `realpathSync` for path jails — is a related but distinct use of symlink awareness; see the structural-permission-enforcement solution doc)

### 3. Idempotent `.gitignore` Updates

Parse existing lines into a Set, skip comment lines, append only missing entries. Use append mode — not atomic write — to preserve existing content.

```typescript
function updateGitignore(gitignorePath: string): boolean {
  rejectSymlink(gitignorePath);
  let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";

  const existingLines = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) existingLines.add(trimmed);
  }

  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0) return false;

  let appendContent = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  appendContent += "\n# vesper\n" + missing.map((e) => `${e}\n`).join("");

  existsSync(gitignorePath)
    ? appendFileSync(gitignorePath, appendContent)
    : writeFileSync(gitignorePath, appendContent, { mode: 0o644 });
  return true;
}
```

Commented-out entries (`# .vesper-complete`) are treated as absent — the real entry is still appended. This is a deliberate design choice, not an oversight. (session history)

### 4. Config Resolution via `vesperDir`

Return the Vesper root directory (`.vesper/` or `~/.config/vesper/`) from `resolveAgent` instead of the agents subdirectory. Drop the co-located `.md` requirement. The `system_prompt` field in YAML resolves relative to `vesperDir`.

```typescript
export interface ResolvedAgent {
  configPath: string;
  vesperDir: string;  // .vesper/ root, NOT .vesper/agents/
}
```

This decouples config location from resource location. Include a migration hint when the old flat layout is detected. (session history: `promptPath` was never used in `index.ts` — the co-located `.md` requirement was enforced but the resolved path was unused, making R3's interface cleanup zero functional risk)

### 5. Build-Time Version Inlining

`bun build --compile` doesn't bundle `package.json`. The Makefile reads the version and passes it via `--define`:

```makefile
VERSION := $(shell bun -e "const p = await Bun.file('package.json').json(); console.log(p.version)")

build:
	bun build src/index.ts --compile --define "VESPER_VERSION='$(VERSION)'" --outfile vesper
```

```typescript
// src/version.ts
declare const VESPER_VERSION: string | undefined;
export const VERSION = typeof VESPER_VERSION !== "undefined" ? VESPER_VERSION : "dev";
```

The `typeof` guard is required because referencing an undeclared global throws a `ReferenceError`; `typeof` is the one operator that doesn't throw on undeclared identifiers.

### 6. Cross-Compilation + Homebrew Auto-Update

A single `ubuntu-latest` GitHub Actions runner cross-compiles for four targets (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-arm64`, `bun-linux-x64`) — Bun downloads the target runtime automatically. After creating the GitHub release with tarballs, the workflow renders a Homebrew Formula and auto-commits it to a separate tap repo.

Use a **Formula** (not a Cask) for CLI binaries. Casks are for macOS GUI applications. The Formula uses `on_macos`/`on_linux` + `on_arm`/`on_intel` blocks for platform-specific URLs and SHA256 verification.

## Why This Matters

**Atomic writes + symlink rejection** close the TOCTOU race and symlink substitution attack surfaces for any scaffolding tool writing to user-controlled directories. `stat` follows symlinks; `lstat` does not. The combination is the correct primitive.

**Backwards-compatible subcommands** let existing scripts and documentation continue working while the CLI becomes more extensible. The hidden `$0` command is the right yargs primitive — it participates in parsing without appearing in help.

**Version inlining** is a hard requirement for single-binary distribution. The `declare const` + `typeof` pattern is the correct TypeScript idiom for bundler-injected globals.

**Idempotent `.gitignore`** makes `vesper init` safe to re-run. Set-based existence checking with comment-line exclusion prevents both duplicates and false negatives.

**No deprecation period** for breaking changes pre-1.0. v0.3 removed env var signal naming with no migration path; v0.4 follows the same precedent for the `system_prompt` path change. Clean breaks with migration hints in error messages. (session history)

## When to Apply

- **Atomic writes + symlink rejection**: Any CLI that scaffolds files in user-controlled directories
- **Hidden default command**: When adding subcommands to a CLI that has existing users
- **Build-time `--define`**: Any Bun single-binary compilation needing build metadata at runtime (also works with esbuild, Webpack DefinePlugin, Rollup)
- **Idempotent config updates**: Any generator modifying files it doesn't own (`.gitignore`, `.eslintignore`, etc.)
- **Homebrew Formula auto-commit**: Distributing CLI binaries for macOS/Linux without requiring users to compile from source

## Examples

**Before (v0.3):** `vesper builder` resolves `.vesper/builder.yml` + required `.vesper/builder.md`. No scaffolding, no subcommands, no distribution.

**After (v0.4):**
- `vesper builder` — still works (hidden `$0` default)
- `vesper run builder` — canonical form; resolves `.vesper/agents/builder.yml`, reads `system_prompt` relative to `.vesper/`
- `vesper init` — scaffolds `.vesper/` with dirs, example config, CLAUDE.md, `.gitignore` updates; idempotent
- `vesper init --global` — scaffolds `~/.config/vesper/`
- `vesper init --force` — overwrites example files (never overwrites symlinks)
- `vesper --version` — prints `0.4.0` from compile-time constant; `dev` when running from source
- `brew install hl/tap/vesper` — installs from Homebrew after first release tag

## Related

- [Structural Permission Enforcement](structural-permission-enforcement-agent-runtime-2026-04-12.md) — symlink resolution via `realpathSync` for permission path jails (related but distinct: permission checking vs. init file-write safety)
- [Skill Injection](skill-injection-persistent-knowledge-agent-runtime-2026-04-12.md) — the skills directory convention that `vesper init` scaffolds
- [Brr scaffold.go](https://github.com/hl/brr) — reference implementation for the atomic write and `.gitignore` append patterns
