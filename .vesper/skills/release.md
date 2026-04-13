# Releasing a New Version

## Steps

1. **Make your changes** and ensure `make check` passes (typecheck + lint + tests).
2. **Commit** the changes with an appropriate `type: description` message.
3. **Bump the version** in `package.json` and commit: `chore: bump version to X.Y.Z`.
4. **Push to main**: `git push origin main`.
5. **Tag the release**: `git tag -a vX.Y.Z -m "vX.Y.Z: short description"` — annotated tags are required.
6. **Push the tag**: `git push origin vX.Y.Z`.

## What Happens Automatically

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

- Runs `make check` on one matrix leg
- Builds native binaries for 4 targets: `darwin_arm64`, `darwin_x64`, `linux_arm64`, `linux_x64`
- Creates a GitHub release with the `.tar.gz` artifacts
- Updates the Homebrew formula in `hl/homebrew-tap`

## Conventions

- Tag message format: `vX.Y.Z: short description of what changed`
- Version in `package.json` must match the tag (without the `v` prefix)
- The release workflow injects the version via `--define "VESPER_VERSION='...'"` at build time
