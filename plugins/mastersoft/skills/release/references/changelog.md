# Changelog generation & entry formats

How to draft changelog entries and the entry-format template for each workflow.
Load this when generating or writing the changelog.

## Generate (both workflows)

When the repo uses conventional commits, lean on an existing generator to draft
the entries — but **always AI-polish the result; never ship raw tool output.**

1. **Detect convention** — do the commit subjects in the range mostly match
   `type(scope)?: …` (feat/fix/docs/…)? If not, skip to step 3.
2. **Draft with a no-install tool** (only if a conventional convention is
   detected). Run it **ephemerally — never install a dependency or add a global
   package**; pick whichever runner already exists (`command -v`):
   - Node (`npx` / `pnpm dlx` / `bunx`): `npx -y git-cliff --unreleased --tag v<version>`
     (Keep-a-Changelog, configurable) or `npx -y conventional-changelog-cli -p conventionalcommits -r 1`.
   - Python (`uvx` / `pipx run`): `uvx git-changelog` / `pipx run git-changelog`.
   - No runner available → skip to step 3.
3. **AI-polish into the repo's style** — take the tool's draft (or, if none ran,
   `git log <range> --oneline`) and rewrite it into readable, human entries: group
   by type/component, expand terse subjects, drop noise (merge commits, dependency
   bumps unless notable), and match the existing changelog's heading style **and
   language**. This synthesis step is mandatory — the tool only supplies raw material.

## Tagged entry format

Notable changes since the last tag, grouped by type, matching the existing file's
style if one is present:

```
## v<version> — <YYYY-MM-DD>

### Features
- <change>

### Fixes
- <change>
```

## Untagged entry format

Prepend the new entry to the top of the entry list, matching the file's existing
style exactly (localized, component-prefixed bullets are common). Stamp the short sha:

```
## [<version>] — <YYYY-MM-DD>
**Commit:** <short-sha>

- **<Component>**: <change>.
```

For `**Commit:**`, match what existing entries reference:
- If they point at the release's own changelog commit → write the entry with a
  placeholder, commit, then `git commit --amend` after filling in that commit's short sha.
- If they point at the last feature commit → use the current `HEAD` sha before committing.

A generic generator won't match a curated, localized bullet style — use it at most
as an input list and rely on the AI-polish step to produce the final entry.
