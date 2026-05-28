# Release playbook — examples, rollback, troubleshooting

Load this for a worked example or when a release step goes wrong.

## Worked examples

**Tagged** — user says "Release what we have":
1. **Workflow** — semver tags present, no `**Commit:**` anchors → tagged (recorded already)
2. **Version** — `git log v1.5.0..HEAD`: 2 feat + 1 fix → minor → v1.6.0
3. **Checks** — tests green, tree clean, `v1.6.0` tag absent
4. **Commit** — `chore(release): v1.6.0 changelog`
5. **Tag** — `git tag -a v1.6.0 -m "v1.6.0"`; **Push** — confirm, then `git push && git push --tags`
6. **Publish** — `glab release create v1.6.0 --name "v1.6.0" --notes "Features: …; Fixes: …"` (if confirmed)

**Untagged** — user says "Release":
1. **Workflow** — CHANGELOG has `**Commit:**` anchors + a publish hook → untagged; recorded in the rules file
2. **Version** — last entry `## [0.22.4]` + 1 feat since its commit → minor → 0.23.0
3. **Entry** — prepend `## [0.23.0] — <today>` / `**Commit:** <sha>` / component bullets, matching the file's style and language
4. **Commit** — `chore(release): v0.23.0 changelog`; **no tag**; **Push** — confirm, then `git push`
5. **Publish** — run the project's publish hook in dry-run first, then for real (if confirmed)

## Rollback

**Tagged:**
1. `git tag -d v<version>` — delete the local tag
2. `git push origin :refs/tags/v<version>` — delete the remote tag (confirm first)
3. If a GitLab release was created: `glab release delete v<version>` (confirm)
4. Revert the changelog commit if needed

**Untagged:** revert the changelog commit (`git revert <sha>` or remove the
`## [<version>]` entry). If a publish hook already pushed it, also remove the
version from the hook's published-state file.

## Common issues

### Version already exists
**Cause:** The version is already a tag (tagged) or a `## [<version>]` entry (untagged).
**Fix:** `git tag -l 'v<version>'` / `glab release list` (tagged), or grep the changelog for `## [<version>]` (untagged).

### Changelog empty
**Cause:** No conventional commits in the range.
**Fix:** Verify the range — `git log <last-tag>..HEAD` (tagged) or `git log <last-Commit-sha>..HEAD` (untagged).

### Wrong workflow detected
**Cause:** A recorded line is stale, or local signals are misleading (e.g. old tags on a now-untagged repo).
**Fix:** Override with `--workflow=tagged|untagged`; update the recorded line in the rules file.
