---
name: release
description: Cut releases — version bump, changelog, and either a tagged release (git tag + GitLab release) or an untagged, changelog-anchored one. Auto-detects which workflow the repo uses and records the decision in the rules file. Use proactively when the user asks to cut a release, bump the version, or publish (not on your own initiative). For regular commits use commit.
model: sonnet
effort: medium
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(glab:*), PowerShell
argument-hint: "[--version=x.y.z] [--workflow=tagged|untagged]"
---

Task: Prepare and publish a release for $ARGUMENTS with proper versioning and a changelog.

## Context

- Current branch: !`git branch --show-current`
- Working tree status: !`git status --short`
- Last tag: !`git describe --tags --abbrev=0 2>/dev/null || echo "none"`
- Semver tag count: !`git tag --list 'v*' | wc -l | tr -d ' '`
- Existing tags (last 5): !`git tag --sort=-creatordate | head -5`
- Commits since last tag: !`git log $(git describe --tags --abbrev=0 2>/dev/null)..HEAD --oneline 2>/dev/null || git log --oneline -20`
- Recorded workflow: !`out=$(grep -rih "release workflow:" CLAUDE.md AGENTS.md .claude/rules/ 2>/dev/null | head -1); echo "${out:-none}"`
- Changelog file(s): !`out=$(git ls-files 2>/dev/null | grep -iE "(^|/)changelog(\.md)?$" | head -3); echo "${out:-none}"`
- Changelog uses commit anchors: !`out=$(grep -rIl "\*\*Commit:\*\*" --include="*CHANGELOG*" . 2>/dev/null | head -1); echo "${out:-no}"`
- Last changelog version + commit: !`out=$( { grep -rIh -m1 "^## \[" --include="*CHANGELOG*" . 2>/dev/null; grep -rIh -m1 "\*\*Commit:\*\*" --include="*CHANGELOG*" . 2>/dev/null; } ); echo "${out:-none}"`
- Publish hook present: !`out=$(git ls-files 2>/dev/null | grep -iE "publish[_-]changelog" | head -1); echo "${out:-none}"`

## Workflow

Releases use GitLab (via the `glab` skill), not GitHub. A release is one of two
shapes; **detect which the repo uses before acting**:

- **Tagged** — version anchored by an annotated `git tag`, optional published GitLab release. The default.
- **Untagged** — version anchored in the changelog by a `**Commit:** <sha>` line; no git tag, no GitLab release. Publish (if any) is a project hook (e.g. a `publish_changelog` management command).

### Step 0 — Determine the workflow (do this first)

1. **If `--workflow=` was passed**, use it.
2. **Else if a workflow is recorded** (Context "Recorded workflow" is not `none`), use it — never re-ask.
3. **Else detect from local signals** (Context block — no network call):
   - Changelog has `**Commit:**` anchors, or a publish hook is present → **untagged**.
   - Semver tags exist and the changelog has no commit anchors → **tagged**.
   - Ambiguous or nothing detected → **ask** with `AskUserQuestion`, **tagged recommended**. Only run `glab release list` here if you still need to break the tie.
4. **Respect, don't migrate.** When detection is clear, proceed in that workflow — do not suggest switching an established untagged repo to tagged.
5. **Record the decision** so future runs skip detection. **Edit the file with the `Edit`/`Write` tool — never shell-append (`>>`/`echo`).** Read it first; if a `## Release` section or a `Release workflow:` line already exists, update it in place; otherwise insert a `## Release` section with one line, matching the file's heading style:
   `Release workflow: <tagged|untagged> — <one-line reason>.`
   Target the **imported rules file**: follow `@`-imports from `CLAUDE.md` (so `@AGENTS.md` → edit `AGENTS.md`); if `CLAUDE.md` holds inline rules, edit there. If **no rules file exists**, don't create one just for this — recommend the `init-rules` skill and proceed with the in-session choice. (Rule files are cached at session start, so the record applies to *future* runs; this run already holds the decision — don't ask the user to `/clear`.)

### Tagged workflow

1. **Determine version** — from conventional commits since the last tag unless `--version` is given (see Version Determination).
2. **Pre-release checks** — tests pass, working tree clean, target tag absent (`git tag -l 'v<version>'`).
3. **Generate changelog** — draft + format per `references/changelog.md`.
4. **Commit changelog** — via the `commit` skill (e.g. `chore: release v1.6.0 changelog`).
5. **Create annotated tag** — `git tag -a v<version> -m "v<version>"`. Add `-s` only when the project signs releases.
6. **Push — confirm first** — outward-facing; ask, then `git push && git push --tags`.
7. **Publish GitLab release (optional)** — via the `glab` skill (auto-resolves the host from the remote):
   ```bash
   glab release create v<version> --name "v<version>" --notes "<release notes>"
   # or, for notes from a file
   glab release create v<version> --name "v<version>" --notes-file <path>
   ```
   The `<tag>` is positional in glab (not a `--tag` flag); `--notes` is plural; `--name` replaces `--title`. GitLab does not have a CLI-exposed `--draft` flag — for "scheduled" releases, set `--released-at` to a future ISO 8601 timestamp.

### Untagged workflow

1. **Determine version** — bump from the last changelog version (Context "Last changelog version + commit") unless `--version` is given. The range is **since that entry's `**Commit:**` sha**, not since a tag (see Version Determination).
2. **Pre-release checks** — tests pass, working tree clean, and `## [<version>]` is not already in the changelog.
3. **Write the changelog entry** — draft + format per `references/changelog.md`; then read the file and insert the entry at the top of the entry list with the `Edit` tool (never a shell append/prepend), matching the existing style.
4. **Commit** — via the `commit` skill (e.g. `chore(release): v0.23.0 changelog`). **No `git tag`.**
5. **Push — confirm first** — ask, then `git push` (no `--tags`).
6. **Publish (optional)** — if a publish hook exists (Context "Publish hook present"), offer to run it (dry-run first, then for real). Do **not** create a GitLab release.

## Version Determination

When `--version` is not provided, derive from conventional commits in the release range — since the last tag (tagged) or since the last changelog entry's `**Commit:**` sha (untagged):
- Any `feat:` commit → minor bump
- Only `fix:` commits → patch bump
- Any `BREAKING CHANGE:` or `!:` → major bump

## References

- `references/changelog.md` — no-install changelog generators + mandatory AI-polish, and the entry-format template per workflow. Load when generating/writing the changelog.
- `references/playbook.md` — worked examples, rollback, and common issues. Load for an example or when a step goes wrong.
- `references/testing.md` — test protocols and success criteria.

## Flags

- `--version=<x.y.z>` Explicit version to release
- `--workflow=<tagged|untagged>` Force the workflow, skip detection
- `--notes=<path>` Path to additional release notes to append
- `--released-at=<iso8601>` Set a future timestamp to publish as an "Upcoming Release" (GitLab shows an Upcoming Release badge until the date passes). Replaces the old `--draft` flag — GitLab releases have no draft state.
- `--chore` Prefer "chore" type for maintenance updates
- `--signoff` Add Signed-off-by to the release commit
