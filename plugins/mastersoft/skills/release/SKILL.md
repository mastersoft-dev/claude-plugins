---
name: release
description: Cut releases — version bump, changelog, annotated tag, push, optional Gitea release via tea. For regular commits use commit.
disable-model-invocation: true
model: sonnet
effort: medium
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(tea:*)
argument-hint: "[--version=x.y.z]"
---

Task: Prepare and publish a release for $ARGUMENTS with proper versioning and artifacts.

## Context

- Last tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Commits since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null)..HEAD --oneline 2>/dev/null || git log --oneline -20`
- Current branch: !`git branch --show-current`
- Working tree status: !`git status --short`
- Existing tags (last 5): !`git tag --sort=-creatordate | head -5`

## Workflow

This team uses **Gitea** (`git.mastersoft.it`), not GitHub. The release is
cut with `git`; the optional published release is created with `tea`.

1. **Determine version** — derive the next version from conventional commits unless `--version` is provided (feat → minor, fix → patch, BREAKING/`!` → major).
2. **Pre-release checks** — tests pass, working tree clean, changelog current, and the target tag does not already exist (`git tag -l 'v<version>'`).
3. **Generate changelog** — update the changelog with notable changes since the last tag, grouped by type (feat, fix, docs, …).
4. **Commit changelog** — stage and commit using the `commit` skill's Conventional Commits conventions (e.g. `chore(release): v1.6.0 changelog`).
5. **Create annotated tag** — `git tag -a v<version> -m "v<version>"`. Add `-s` for a signed tag only when the project signs releases (signing key configured).
6. **Push — confirm first** — pushing to the shared remote is outward-facing; ask the user before pushing, then `git push && git push --tags`.
7. **Publish Gitea release (optional)** — create it with tea, resolving the login from the git remote (`--login` / `--remote`; see the `tea` skill for auth resolution):
   ```bash
   tea release create --tag v<version> --title "v<version>" --note "<release notes>" [--draft]
   ```

## Version Determination

When `--version` is not provided, derive from conventional commits since the last tag:
- Any `feat:` commit → minor bump
- Only `fix:` commits → patch bump
- Any `BREAKING CHANGE:` or `!:` → major bump

## Rollback Procedure

If a release must be reverted:
1. `git tag -d v<version>` — delete the local tag
2. `git push origin :refs/tags/v<version>` — delete the remote tag (confirm first)
3. If a Gitea release was created: `tea release delete v<version>`
4. Revert the changelog commit if needed

## Worked Example

User says: "Release what we have"

1. **Version** — `git log v1.5.0..HEAD`: 2 feat + 1 fix → minor → v1.6.0
2. **Checks** — tests green, tree clean, `v1.6.0` tag absent
3. **Changelog** — entries grouped: Features (2), Fixes (1)
4. **Commit** — `chore(release): v1.6.0 changelog`
5. **Tag** — `git tag -a v1.6.0 -m "v1.6.0"`
6. **Push** — confirm, then `git push && git push --tags`
7. **Publish** — `tea release create --tag v1.6.0 --title "v1.6.0" --note "Features: …; Fixes: …"` (if confirmed)

Result: v1.6.0 tagged and pushed, changelog updated, Gitea release published.

## Common Issues

### Version already exists
**Cause:** A tag or release with the same version already exists.
**Fix:** `git tag -l 'v<version>'` and `tea release list` before creating.

### Changelog empty
**Cause:** No conventional commits since the last tag.
**Fix:** Check `git log <last-tag>..HEAD --oneline` to verify the commit range.

## Additional Resources

- **`references/testing.md`** — troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Create a tagged release with a changelog and an optional Gitea release via tea.

### Examples
- `release --version=1.2.0`
- `release --draft`

### Checklist
- Determine version bump (major/minor/patch) or use explicit `--version`.
- Generate changelog entries from commits since the last tag.
- Tag, confirm, push, and optionally `tea release create`.

## Flags

- `--version=<x.y.z>` Explicit version to release
- `--notes=<path>` Path to additional release notes to append
- `--draft` Create the Gitea release as a draft
- `--chore` Prefer "chore" type for maintenance updates
- `--signoff` Add Signed-off-by to the release commit
