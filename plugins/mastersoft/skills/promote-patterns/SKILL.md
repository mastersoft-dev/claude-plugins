---
name: promote-patterns
description: Triage Claude Code auto-memory entries (any topic file except the MEMORY.md index and reference-type pointers) and decide whether each pattern belongs in repo rules (CLAUDE.md / .claude/rules/), in the user-global ~/.claude/CLAUDE.md, or stays in auto-memory. Use proactively when lint-engine signals `patterns-to-promote` or `memory-review-due`, when the user asks to "promote patterns", "review auto memory", "turn corrections into rules", or after a long session with many corrections.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), Bash(git:*), PowerShell, AskUserQuestion
model: sonnet
argument-hint: "[--user-only | --repo-only]"
---

# Promote-Patterns

Curator skill. Walks the Claude Code auto-memory entries for the current
repo, routes each candidate to one of: repo rules, user-global rules,
or "leave in auto-memory". Auto-acts on each `AskUserQuestion` answer
immediately so the user can stop at any point and resume later.

## Inputs

Optional argument:

- `--user-only` — only ask about patterns that look user-global (workflow
  preferences, generic dev habits). Skip project-specific candidates.
- `--repo-only` — only ask about project-specific candidates. Skip the
  ones that look user-global.

Default (no flag): walk everything, classify per-pattern, ask user.

## Procedure

1. **Resolve repo root + paths.** Compute via the cross-platform helper —
   this also gives the dash-encoded slug Claude Code uses for auto-memory:

   ```
   REPO=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js repo-root)
   MEMDIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js memory-path)
   ```

   Abort with one-line message if not in a git repo.

2. **List candidate files.** Glob `${MEMDIR}/*.md`. Exclude `MEMORY.md`
   (it's the index) and any `reference` entry — detect those by EITHER a
   `reference_` filename prefix OR `type: reference` in frontmatter (top-level
   or nested under `metadata:`); they're already explicit pointers. Everything
   else is a candidate, regardless of naming convention: both legacy
   filename-prefix entries (`feedback_`/`project_`/`user_`) and current
   slug-style entries (`<slug>.md` carrying `type:` in frontmatter). If the dir
   is missing or empty, print "No auto-memory patterns to triage in this repo."
   and stop.

3. **Read repo rules + user-global rules for de-dup context.**
   - `<REPO>/CLAUDE.md`, `<REPO>/.claude/rules/**/*.md`
     (follow `@imports` like `lint-engine.js` does).
   - `~/.claude/CLAUDE.md` (read-only — used only for the "is this already
     codified" judgement; never edited by this skill except via the
     explicit "→ User CLAUDE.md" path below).

4. **Pre-process all candidates first (no asks yet):**

   For each candidate file:

   a. Read it. Note the `description:` line in frontmatter (if any) and the
      body — that's the actual pattern.

   b. **Already codified?** Decide judgement-style (not regex): does the
      repo CLAUDE.md / rules already cover this pattern, even
      paraphrased? Does `~/.claude/CLAUDE.md` already cover it? If yes,
      print one line `= covered: <slug>` and drop from the queue.

   c. **Classify scope** (model judgement, two cues):
      - **Project-specific** — mentions this repo's files / commands /
        conventions, or names a specific framework/library this repo
        actively uses.
      - **User-global** — workflow preference, generic dev habit, applies
        across any project.

      Respect `--user-only` / `--repo-only` flags: drop mismatched candidates
      with `= skipped (scope filter): <slug>`.

   Result: a queue of N candidates with each one's scope classification
   prepared. Print a one-line plan: `Triaging N pattern(s) in batches of
   up to 4. Estimated K AskUserQuestion call(s).`

5. **Ask in parallel batches (up to 4 patterns per call):**

   The `AskUserQuestion` API accepts 1-4 question items per call. Take the
   next chunk of up to 4 candidates from the queue and build ONE
   `AskUserQuestion` call with one question item per candidate. Asking
   one-by-one is wrong — it forces the user to click N times when N/4 + 1
   roundtrips suffice.

   Question item shape (per pattern):

   - `question`: include the pattern's source filename + a one-line summary
     of the body, so the user can route without re-reading. Keep under
     ~300 chars.
   - `header`: 1-3 word chip, e.g. `Android #1` or `Push policy`.
   - `multiSelect`: `false` — each pattern routes to exactly one target.
   - `options`: use this set (always 3):

      | Label | Effect |
      |---|---|
      | "→ Repo CLAUDE.md" | Append a bullet to `<REPO>/CLAUDE.md` (or a `.claude/rules/<topic>.md` if scoped). |
      | "→ User ~/.claude/CLAUDE.md" | Append a bullet to user-global rules. |
      | "Skip — leave in auto-memory" | No-op. |

     For project-specific scope, surface "Repo CLAUDE.md" first. For
     user-global, surface "User ~/.claude/CLAUDE.md" first. The "Skip"
     option is always present and is always last.

   After the call returns, walk the answers and apply each diff (step 6).
   Then take the next chunk of up to 4 and repeat until the queue is
   empty.

   **Don't filter the batch by scope before asking.** Mixed batches of
   project-specific + user-global candidates in one call are fine — each
   question item carries its own scope-ordered options.

6. **Apply each answer's diff** in the order they came back.

   - For CLAUDE.md / `.claude/rules` / user CLAUDE.md appends: prefer `Edit`
     over `Write` (preserves rest of file). Match the file's existing
     bullet/section style.
   - **Per-repo files (CLAUDE.md / .claude/rules/<topic>.md)**:
     run `git status --porcelain -- <file>` before each apply. If dirty,
     re-ask via `AskUserQuestion` "overlay anyway / skip". Never overwrite
     uncommitted local changes silently. If multiple files in the batch
     are dirty, batch the overlay-confirm questions in ONE call too.
   - **User-global ~/.claude/CLAUDE.md (extra gate, batched)**: this file
     is usually outside any git tree, so the dirty-tree check above does
     not apply. Instead, collect EVERY "→ User ~/.claude/CLAUDE.md" answer
     in the current batch and fire ONE follow-up `AskUserQuestion` with
     up to 4 confirm-items in parallel:
     > "Append to `~/.claude/CLAUDE.md`? Applies to every future Claude
     > Code session for this user, in every repo. Pattern: <one-line summary>."
     Options per item: "Confirm append" / "Cancel — skip instead".
     Apply only the items the user confirmed; cancelled = treat as Skip.
     Same rule applies for follow-up batches.
   - **Source file in auto-memory**: leave the entry where it is.
     Auto-memory is Claude's working notes; the user can let Claude rewrite
     it later. This skill does NOT delete from auto-memory — deleting would
     make Claude re-learn the same pattern on the next correction.

7. **Record the promotion-check timestamp** when done:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js record-promotion-check
   ```

   This silences the `patterns-to-promote` lint signal until the
   auto-memory dir mtime advances again (new entries written).

8. **Final summary.** Print a 4-line block:

   ```
   Triaged N pattern(s):
     → Repo CLAUDE.md:        <count>
     → User ~/.claude/CLAUDE.md: <count>
     Skipped:                 <count>
   ```

   If any apply was blocked by dirty working tree, list those at the end.

## Refusal cases

- Not in a git repo → "Run inside a git repo."
- Auto-memory dir missing or no candidates → "No auto-memory patterns to
  triage in this repo." (Don't ack the lint signal — there's nothing
  to do, but the dir may populate later.)
- `~/.claude/CLAUDE.md` missing AND user picks "→ User ~/.claude/CLAUDE.md"
  → create it with a one-line header `# User-global Claude Code rules`
  before appending.

## Notes

- **AskUserQuestion per pattern (batched up to 4 per call, per step 5), never a
  single blanket approve-all.** Same fatigue-mitigation rule as
  `/mastersoft:refresh-rules`: never ask "apply all 12?" in one lump.
- **Diffs stay small.** A single bullet or known-issue row per apply.
  If the source pattern is multi-paragraph, propose a one-line summary
  and link back to the auto-memory file path. The user can expand later.
- **Don't promote `reference_*.md`.** Those are already explicit pointers
  to external resources; promoting them means duplicating URLs into rules.
- **User-global writes are rare.** Most patterns belong in the repo. If
  the user picks "→ User" three or more times in one session, surface
  a one-line note suggesting they review `~/.claude/CLAUDE.md` for
  emerging meta-rules.
- **User-global path is double-gated by design.** A single-question
  approval on `~/.claude/CLAUDE.md` is too thin a barrier given the file
  applies to every future session; the secondary confirm in step 6
  (User-global extra gate) is not optional, even when the user picked "→ User ~/.claude/CLAUDE.md"
  explicitly. Same shape as the `git push` confirm hook: consequential
  ops always re-prompt.
