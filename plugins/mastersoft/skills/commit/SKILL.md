---
name: commit
description: Atomic Conventional Commits with adaptive quality gates (format/lint/test) discovered from CLAUDE.md or project configs. Use proactively when the user asks to commit or save changes (not on your own initiative — commit only when asked). For releases use release.
model: sonnet
effort: medium
allowed-tools: Read, Glob, Grep, Bash(git:*), PowerShell
argument-hint: "[--max=N] [--no-checks] [--no-verify] [--signoff]"
---

Task: Create commits for $ARGUMENTS

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Guidelines

- Do not add Claude Code attribution
- If request is ambiguous, ask for clarification

## Workflow

1. **Detect changes** -> Identify files and logical units of work.
2. **Group related changes** -> Changes with the same logical purpose should be committed together.
3. **Stage changes** -> Stage each logical group (`git add <files>` or `git add -p`).
4. **Run quality gates** -> Adaptive (see below). Skip silently if nothing declared.
5. **Commit** -> Create a separate commit for each logical change.

## Quality Gates (adaptive, default-on)

Always attempt discovery. Skip silently if nothing found — no prompt, no warning. Override with `--no-checks`.

### Discovery (first hit wins)

1. `quality-gates:` YAML block in `./CLAUDE.md`, `./.claude/CLAUDE.md`, or `./AGENTS.md`
2. Else scan `package.json` scripts, `Makefile` targets, `pyproject.toml`, `Cargo.toml`, `go.mod` for known names (`format`, `lint`, `typecheck`, `check`, `test`)
3. Else: no gates → commit straight

### Execution

- Run in order: format → lint → typecheck → test
- Empty/missing field → skip that gate
- On failure: stop, show errors with file:line, propose fixes. Do not mutate code — report only, user re-runs after fixing
- On pass or no gates: proceed to commit
- If `.husky/` or `.pre-commit-config.yaml` covers same gates: defer to hook, skip skill-side run

### Recommended CLAUDE.md block

```yaml
quality-gates:
  format: ruff format --check
  lint: ruff check
  typecheck: mypy .
  test: pytest -x
```

## Commit Rules

### Atomic Commits

- Each commit must contain a **single logical change**, which may span multiple files.
- **Group together**: Changes that serve the same purpose (e.g., "update import paths" affecting 5 files = 1 commit).
- **Keep separate**: Unrelated changes (e.g., "fix bug" + "add feature" = 2 commits).
- Respect `--max=<N>` limit (default 20); if more changes exist, group logically.

### Commit Message Format

- Subject: `<type>: concise summary` (<=72 chars).
- **No scopes.** Plain `<type>:` — no `(auth)`, `(api)`, `(glab)`. The summary already says what changed.
- **Default: subject only. No body.** Most commits — even non-trivial ones — ship with subject alone.
- **Do not include file names in the summary** unless it's a single-file change.
- Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `style`
- Language & verb mood: **see the section below** — this is the #1 source of mistakes in Italian repos.
- If no previous commits: `"Initial commit"` or `"Setup project"`.

### Language & Verb Mood (read carefully — Italian mistakes happen here)

These are **two independent decisions**. Never let the second one be decided by what recent commits happen to look like.

1. **Which language** → match the language of recent commits (see the `git log` context at the top). Italian repo → write Italian; English repo → write English.
2. **Which verb mood** → determined *only* by the language, and it is FIXED:
   - **English → imperative mood**: `add`, `remove`, `fix`, `move`, `disable` — e.g. `feat: add currency helper`
   - **Italian → participio passato**: `aggiunto`, `rimosso`, `sistemato`, `spostato`, `disabilitato` — e.g. `feat: aggiunto helper valuta`

⚠️ **Italian trap — this is the recurring bug.** Conventional Commits is imperative in English, so the natural translation drifts to *imperative Italian* (`sposta`, `disabilita`, `aggiungi`, `rimuovi`). **That is wrong.** Italian ALWAYS uses the past participle (`spostato`, `disabilitato`, `aggiunto`, `rimosso`) — **even if some recent commits in the `git log` context use the imperative.** Do not mimic imperative Italian: matching the language does NOT mean matching a wrong mood. Correct the pattern, don't propagate it.

| ❌ Wrong (imperative IT) | ✅ Right (participio passato) |
|---|---|
| `fix: sposta il file di config` | `fix: spostato il file di config` |
| `feat: disabilita il retry` | `feat: disabilitato il retry` |
| `refactor: aggiungi validazione` | `refactor: aggiunta la validazione` |

### Body Decision Heuristic

**Default = no body.** Write one only when ALL three hold:

1. The WHY is non-obvious from subject + diff (workaround for a specific bug, hidden constraint, surprising decision).
2. Without it, a reviewer would likely ask "why".
3. You can explain it in **≤3 short lines** (~150 chars total).

Otherwise omit. "Touches business logic" / "touches an API" is **not** enough — that describes most commits.

When written: blank line after subject, wrapped at 72 chars, **max 3 lines**. State the WHY only.

**Never put in the body** (these violations are routine and must stop):

- File / module / package lists (the diff is the file list).
- "What changed" bullet rundowns (the subject is the summary).
- Validation or test results (those belong in PR descriptions or CI output).
- Rationale that just paraphrases the subject in more words.

**Breaking changes**: use a `BREAKING CHANGE:` trailer — this is required metadata, not a "body".

### Grouping Logic

**Commit together** (1 commit):

- Import path refactoring across multiple files
- Renaming a function/variable across multiple files
- Formatting changes from a linter/prettier run
- Updating dependencies in related files
- Moving code between files (as part of restructuring)

**Keep separate** (multiple commits):

- Bug fix in one area + new feature in another
- Different types of changes (feat + fix + docs)
- Changes to unrelated systems/modules

## Worked Example

User says: "Commit my changes"

1. **Detect** — `git status`: 3 modified files in `src/auth/`, 1 new file in `src/utils/`
2. **Group** — Auth changes = 1 logical unit (login fix); utils file = separate (new helper)
3. **Stage** — `git add src/auth/login.ts src/auth/middleware.ts src/auth/types.ts`
4. **Commit** — `fix: resolve null check in login flow` (subject only — the diff shows the fix)
5. **Stage** — `git add src/utils/format.ts`
6. **Commit** — `feat: add currency formatting helper` (subject only)

Result: 2 atomic commits, no bodies. Bodies would only appear if e.g. the null fix were a workaround for a specific upstream bug worth flagging in ≤3 lines.

**Same example in an Italian repo** (note the participio passato, never the imperative):

- `fix: sistemato il null check nel flusso di login`
- `feat: aggiunto helper per la formattazione della valuta`

### Counter-example (what NOT to do)

```
feat: add GitLab CLI skill and migrate release workflow

- new skill plugins/mastersoft/skills/glab/ (SKILL.md, references,
  assets: issue/MR templates, labels, gitlab-repo-templates) covering
  MRs, issues, labels, CI/CD pipelines, releases, auth
- release skill: switch tagged-release flow from Gitea to GitLab
- help card: replace /mastersoft:tea entry with /mastersoft:glab
- bump marketplace.json + plugin.json to 3.3.0
```

The subject is fine. The body is a file/change list — exactly the diff itself, re-stated in prose. Drop the body; ship subject only.

## Common Issues

### Too many commits for small changes
**Cause:** Over-splitting related changes into separate commits.
**Fix:** Group by logical purpose: a rename across 5 files = 1 commit, not 5.

### Wrong commit type chosen
**Cause:** Ambiguous change doesn't clearly map to feat/fix/chore.
**Fix:** When uncertain, prefer `chore:` for maintenance, `feat:` only for user-visible features, `fix:` only for bug corrections.

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Create atomic, conventional commits with proper grouping and message formatting.

### Examples
- `commit` (auto-detect, run gates if declared, commit all changes)
- `commit --max=5` (limit to 5 atomic commits)
- `commit --no-checks` (skip adaptive quality gates)

### Checklist
- Detect all staged and unstaged changes.
- Group logically related changes into atomic commits.
- Write conventional commit messages with proper type prefixes.
- Respect the repository's language convention (English/Italian) — and the fixed verb mood: English imperative, Italian participio passato (never imperative Italian, even if recent commits use it).

## Flags

- `--max=<N>` Maximum number of atomic commits (default 20)
- `--signoff` Add Signed-off-by trailer
- `--no-verify` Skip pre-commit hooks
- `--no-checks` Skip adaptive quality gates
