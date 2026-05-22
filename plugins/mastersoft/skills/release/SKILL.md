---
name: release
description: Cut releases — version bump, changelog, signed tag, push, optional GitHub release. For regular commits use commit.
disable-model-invocation: true
model: sonnet
effort: medium
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(gh:*)
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

1. **Determine version** -- Derive next version from conventional commits unless `--version` is provided.
2. **Generate changelog** -- Update changelog with notable changes grouped by type (feat, fix, docs, etc.).
3. **Commit changelog** -- Stage and commit changelog updates using `/commit` conventions.
4. **Create signed tag** -- Tag the release commit (e.g., `v1.6.0`).
5. **Push commits + tags** -- Push both commits and tags to remote.
6. **Publish release** -- Optionally create a GitHub release with notes via `gh release create`.

## Guidelines

- If `--version` is not provided, determine bump from conventional commit types (feat=minor, fix=patch, BREAKING=major).
- Generate changelog entries grouped by change type since last tag.
- Use `/commit` conventions for the changelog commit message.
- Optionally create a GitHub release with notes.

## Pre-Release Checks

Before creating a release:
1. Ensure all tests pass on the release branch
2. Verify no uncommitted changes exist
3. Confirm changelog is up to date
4. Check that the version tag doesn't already exist (`git tag -l`)

## Version Determination

When `--version` is not provided, derive from conventional commits since last tag:
- Any `feat:` commit -> minor bump
- Only `fix:` commits -> patch bump
- Any `BREAKING CHANGE:` or `!:` -> major bump

## Rollback Procedure

If a release needs to be reverted:
1. `git tag -d v<version>` (delete local tag)
2. `git push origin :refs/tags/v<version>` (delete remote tag)
3. If GitHub release was created: `gh release delete v<version>`
4. Revert the changelog commit if needed

## Worked Example

User says: "Release what we have"

1. **Determine version** -- `git log v1.5.0..HEAD`: 2 feat commits, 1 fix -> minor bump -> v1.6.0
2. **Changelog** -- Generate entries grouped by type: Features (2), Fixes (1)
3. **Commit** -- `chore: update changelog for v1.6.0`
4. **Tag** -- `git tag v1.6.0`
5. **Push** -- `git push && git push --tags`
6. **Publish** -- `gh release create v1.6.0 --notes "..."` (if confirmed)

Result: v1.6.0 tagged, changelog updated, GitHub release published.

## Common Issues

### Version already exists
**Cause:** Tag or release with the same version already published.
**Fix:** Use `git tag -l` to check existing tags before creating.

### Changelog empty
**Cause:** No conventional commits since last tag.
**Fix:** Check `git log <last-tag>..HEAD --oneline` to verify commit range.

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Create a tagged release with a changelog and optional GitHub release.

### Examples
- `release --version=1.2.0`
- `release packages/api --chore`

### Checklist
- Determine version bump (major/minor/patch) or use explicit `--version`.
- Generate changelog entries from commits since last tag.
- Tag, push, and optionally create a GitHub release.

## Flags

- `--version=<x.y.z>` Explicit version to release
- `--notes=<path>` Path to additional release notes to append
- `--draft` Create the GitHub release as a draft
- `--chore` Prefer "chore" type for maintenance updates
- `--no-verify` Allow `--no-verify` with VCS hooks when appropriate
- `--signoff` Add Signed-off-by to the release commit
