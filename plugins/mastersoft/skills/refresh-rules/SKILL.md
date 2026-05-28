---
name: refresh-rules
disable-model-invocation: true
description: Audit and refresh project rule files (CLAUDE.md / AGENTS.md, .claude/rules/) when lint-engine signals staleness, broken references, an oversized rule file, or recurring corrections in auto-memory. Spawns the read-only rule-auditor agent (seeded with the live lint signals) to produce an evidence-backed findings table, proposes section-by-section diffs gated via AskUserQuestion, auto-applies on confirm, then runs a final re-audit pass over the edited entries. User-invocable; not auto-fired.
allowed-tools: Task, Read, Write, Edit, Glob, Grep, Bash(git:*), Bash(node:*), PowerShell, AskUserQuestion
argument-hint: "[focus-area]"
---

# Refresh-Rules

Curator skill. Delegates analysis to the `rule-auditor` agent, proposes a diff per section, applies on user confirm, then re-audits what it changed. Auto-act on every answer.

## Inputs

- Optional `[focus-area]`: `claude`, `rules`, or a specific path. If omitted, audit all.

## Procedure

0. **Pre-flight notice (emit once at skill start, before any tool calls):**
   > "Heads up: if root CLAUDE.md or any `@`-imported rule file gets edited in this run, the changes won't take effect until `/compact` at the end — rule files are cached at session start. I'll prompt you for `/compact` when we're done. This skill must also run from the main session — if you're in a background subagent or worktree-isolated context, Edit/Write on the parent repo will fail; abort and resume in the parent session."

1. **Resolve repo root** via `git rev-parse --show-toplevel`. Abort if not in a git repo.

2. **Get the analysis** — spawn the auditor, seeded with this session's signals:
   - **Cache reuse only when there are NO live signals.** A cached verify was produced standalone (no signal prioritisation), so reusing it would silently drop the signal-seeding that triggered this refresh. Only when this session shows no `## Mastersoft signals` block: resolve `node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js findings-path`, `Read` it, and if `generatedAt` is < 24h old use it as the starting table — skip the spawn. If signals ARE present, ignore the cache and spawn fresh.
   - **Spawn the `rule-auditor` agent via `Task`**, seeding it with the live lint signals visible in this session (the `## Mastersoft signals` block from lint-engine that prompted this call) and the optional `[focus-area]`. Example prompt:

     ```
     Task (subagent_type: rule-auditor):
     Audit the rule files in <repoRoot> against the codebase.
     Input signals (prioritise the areas these point at): <signal ids, e.g. stale-path-refs, rule-file-stale, rule-file-oversize>.
     Focus: <focus-area or "all">.
     Return findings (human-readable blocks + the trailing json block).
     ```

   - The agent is read-only — it returns findings, it does not edit. Capture its findings table.

3. **Read live rule files** named in the findings (always, since the user may have edited since the audit ran): `<root>/CLAUDE.md`, the relevant `<root>/.claude/rules/**/*.md`, and any `@path.md` imports.

4. **Group proposed changes** into the categories below. For each non-empty group with **high or medium-severity** findings, propose changes via `AskUserQuestion` with three options — **Apply** / **Skip** / **Edit manually** (print the diff for the user). Auto-act on the answer immediately. **Batch all low-severity / advisory findings across groups into a single multi-select `AskUserQuestion`** ("Apply these N low-severity nits?" with one checkbox per finding, each labeled `<group>: <one-line summary>`). This cuts round-trips on long runs without losing per-finding gating. Never bulk-batch high/medium findings — those still get per-section questions ("apply all 12?" is the failure mode to avoid here).

   Groups, in order:

   a. **Stale path refs** — replace deleted paths with current ones (where unambiguous) or drop the line.

   b. **CLAUDE.md compression** — remove duplicate guidance, collapse prose to bullets, strip examples that no longer apply.

   c. **Rule file split** — when the main rules file exceeds the size threshold, move per-topic sections to `.claude/rules/<topic>.md`. The main file is whichever holds the bulk: `AGENTS.md` under the pointer convention (`CLAUDE.md` = `@AGENTS.md`), or `CLAUDE.md` if it holds inline rules.

      **Scope each extracted file with `paths:` frontmatter** matching the code it governs (e.g. testing rules → `paths: ["**/*.test.*"]`, API rules → `paths: ["src/api/**"]`). *Why it matters:* a path-scoped rule loads into context **only when Claude reads a matching file** — that is the only real context saving. Unscoped rules and `@`-imports both load at session start, so they cost the same as leaving the text inline; the split buys nothing unless the pieces are path-scoped. *Caveat:* path-scoped rules trigger on file **reads**, not on `Write`/Bash-generated edits — so keep any must-always-apply rule **unscoped** (no `paths:`). Present the proposed file list AND the trimmed main file.

   d. **Claim refresh** — for each stale claim the auditor flagged in CLAUDE.md / `.claude/rules` (Known State bullets, counts, symbols, paths), update or remove the entry to match code. **Audit every flagged entry, not just append new ones.**

   e. **Misplaced content → docs** — for each placement finding (settled decision squatting in CLAUDE.md, or a `brief-deprecated` signal active), drive migration: stable conventions → CLAUDE.md, settled decisions → `docs/adr/` via `/mastersoft:doc adr`, ephemeral state → drop. Respect the split: CLAUDE.md = stable conventions, settled decisions = `docs/adr/`, ephemeral state not tracked as a file. **On Apply for `brief-deprecated`, the migration is single-shot: write the ADR(s), then remove BRIEF.md (`git rm BRIEF.md` if tracked, else `rm`).** The file's absence is what clears the signal — leaving a stub BRIEF.md (even one that only links to the new ADRs) keeps `brief-deprecated` firing forever. "Skip" preserves the file as-is.

   f. **Promote recurring patterns from auto-memory** — label **ADVISORY — auto-memory is per-user-per-machine. Confirm pattern applies team-wide before promoting.** Surface for review; do NOT auto-apply.

5. **Diff format**: unified diff in a code fence, file-path header, < 60 lines per question (split larger).

6. **Apply step**: on "Apply", use `Edit` (preferred) or `Write` (new files). For deletions (e.g. BRIEF.md in group e), use `Bash`: `git rm <file>` if tracked, else `rm <file>`. Before each apply, `git status --porcelain -- <file>`; if dirty, ask whether to overlay or skip. Re-read + abort if mtime advanced since proposal. **If Edit/Write fails with `EnterWorktree cannot be called from a subagent with a cwd override`** (or any sibling error mentioning subagent isolation / cwd override), **abort the entire run immediately** with: "This skill must run from the main session — Edit/Write would mutate the parent's working tree. Resume in the parent session." Do not retry; the error is structural, not transient.

7. **Final pass** — after all applies, re-verify the entries you changed. Spawn `rule-auditor` again via `Task` scoped to the edited files (`Focus: <edited paths>`); confirm zero residual stale claims. Report any that survive (e.g. a claim you couldn't auto-resolve). This is the step that catches an entry edited incompletely or a sibling entry missed.

8. **Record `last-refresh-at`** then ack ONLY the `rules`-category signals for the session window:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js record-refresh
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js ack-lints defer rules
   ```

   Category scope matters: handling rule-file signals must NOT silence orthogonal concerns (`security-audit-due` = `audit`, `patterns-to-promote` = `patterns`). Those keep firing until their own skills clear them.

9. **Reload reminder**: if root `CLAUDE.md` or an `@`-imported rule file (e.g. `AGENTS.md`) was edited, end with:

   ```
   Rule file was modified. Root CLAUDE.md and its @-imports (e.g. AGENTS.md) are cached at session start; edits do not apply until /compact, /clear, or restart.
   ```

   Use `AskUserQuestion` to offer **Compact now** (print `/compact`) or **Defer**.

10. **Final summary** — applied / skipped per category, plus any residual from the final pass.

## Refusal cases

- Not in a git repo → "Run inside a git repo."
- No rule files at all → "Nothing to refresh. Run /mastersoft:init-rules first."

## Notes

- **Analysis is delegated, interaction is not.** The `rule-auditor` agent (read-only, Sonnet) does the claim-by-claim verification in an isolated subcontext; this skill stays in the main session because it needs the live signals in history and the `AskUserQuestion` answers must land here. Do **not** add `context: fork`.
- **The agent is the single source of check logic** — shared with `/mastersoft:verify`. Never re-implement checks here.
- **Per-section AskUserQuestion, not bulk** — fatigue mitigation.
- **Never overwrite uncommitted local changes silently.**
- **Auto-memory promotion is advisory only** — per-user-per-machine, may not represent the team.
