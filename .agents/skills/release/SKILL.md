---
name: release
description: This skill should be used when the user asks to "release", "cut a release", "publish a new version", "bump and release", "ship a version", "tag a release", or wants to create a new versioned release of vesper.
---

# Release a New Version of Vesper

Release vesper by bumping the version, committing, tagging, and pushing. The CI workflow handles binary builds, the GitHub release, and the Homebrew formula update.

## Process

1. **Ensure all changes are committed and pushed.** Run `git status` to verify a clean working tree on `main`. If there are uncommitted changes, commit them first.

2. **Run quality gates.** Execute `make check` (typecheck + lint + tests). Do not proceed if any gate fails.

3. **Determine the new version.** Read the current version from `package.json`. Bump according to the change:
   - Patch (X.Y.Z → X.Y.Z+1): bug fixes, model ID updates, minor corrections
   - Minor (X.Y.Z → X.Y+1.0): new features, new tools, new config options
   - Major (X.Y.Z → X+1.0.0): breaking changes to agent config format or CLI interface

4. **Bump the version in `package.json`.** Edit the `"version"` field. Commit with message: `chore: bump version to X.Y.Z`.

5. **Push to main.** `git push origin main`.

6. **Create an annotated tag.** Annotated tags are required — lightweight tags will be rejected.
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z: short description"
   ```
   Tag message format: `vX.Y.Z:` followed by a brief summary of what changed.

7. **Push the tag.** `git push origin vX.Y.Z`. This triggers the release workflow.

## What CI Does Automatically

Pushing a `v*` tag triggers `.github/workflows/release.yml`:

- Runs `make check` on one matrix leg
- Builds native binaries for 4 targets: `darwin_arm64`, `darwin_x64`, `linux_arm64`, `linux_x64`
- Packages each as a `.tar.gz` artifact
- Creates a GitHub release with auto-generated release notes
- Computes SHA256 checksums and updates the Homebrew formula in `hl/homebrew-tap`

## Conventions

- The version in `package.json` must match the tag (without the `v` prefix)
- The release workflow injects the version at build time via `--define "VESPER_VERSION='...'"` — no other version source exists
- Previous tag messages follow the pattern: `vX.Y.Z: short description of what changed`
