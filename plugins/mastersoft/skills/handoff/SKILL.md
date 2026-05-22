---
name: handoff
description: Save conversation-only context (goal, done, pending) as a file for next chat. Use on "handoff"/"/handoff"/"continue in next chat". Same-session = /compact.
allowed-tools: Write, Bash(date:*)
argument-hint: "[focus for next session | /compact for same chat]"
---

Produce a small file containing only conversation-only knowledge — what the next chat cannot recover from `git log`, `git diff`, source files, `BRIEF.md`, or `CLAUDE.md`. Compute a path of the form `${TMPDIR:-/tmp}/handoff-<timestamp>.md` where `<timestamp>` comes from `date +%Y%m%dT%H%M%S`. Write directly to that path (the file does not pre-exist, so no prior `Read` is needed — this is what keeps the no-fs-reads contract intact) and print the absolute path on its own line. Do not use `mktemp`: it pre-creates the file, which trips Claude Code's "Read-before-Write on existing files" rule and would force a Read that violates the contract below.

`/compact` and `/handoff` are symmetric across the session boundary: `/compact` preserves context *in place* (same chat, summary replaces history); `/handoff` preserves it *across* (file seeds a fresh chat). They never chain. If the user just wants to free context inside the current chat, route to `/compact` instead and stop.

## Sections (use these, in order)

1. **Goal** — what the user wants achieved, in their own framing when given.
2. **Done** — concrete progress this conversation. Skip mechanical edits visible in `git diff`; keep rationale, rejected approaches, user-stated constraints, surprises.
3. **Pending** — what remains, priority order. Open questions, unresolved decisions, external blockers.
4. **Focus** *(only when an argument was passed via `$ARGUMENTS`)* — verbatim user input, as the first bullet under **Pending**.
5. **Skills** *(only when obviously relevant)* — slash-command names the next session is likely to need (e.g. `/mastersoft:investigate`, `/android-testing`), one per line.

## Rules

- **Conversation-only.** Sole input = transcript + compaction summaries. Treat compaction summaries as ground truth; do not infer past them.
- **No filesystem reads.** Do not run `Bash(git ...)`, do not `Read` source files, do not list directories. The only filesystem operation is one `Write` to a fresh path. Reason: external state goes stale between sessions, leaks scope, and can surface uncommitted secrets — staying conversation-only is the security contract of this skill.
- **No self-reference.** Do not write "this handoff document describes…". Write the content directly so the next agent reads context, not framing.
- **Do not restate what code/git would show.** Reference by path when a pointer helps. The next agent has the same repo.
- **Cap at ~60 lines.** Past that, you are over-restating. Re-read and cut.

## Output line

After the `Write` succeeds, the only thing printed back to the user is the absolute path of the file — no preamble, no summary. The user copies that path into the next chat as context.

## Example shape

```markdown
## Goal
Migrate auth middleware off legacy session-token store; rewrite is compliance-driven, not tech debt.

## Done
- Decided JWT over signed cookies — user vetoed cookies because of past CSRF incident.
- Compatibility shim approach rejected; clean cutover preferred for audit trail.
- Token TTL set to 15 min after weighing UX vs blast radius.

## Pending
- Wire refresh-token rotation; design discussed, not implemented.
- Open: which service owns the JWKS endpoint? Platform team to confirm.
- Decommission `legacy_sessions` table — wait until 30 days of clean logs.

## Focus
- $ARGUMENTS verbatim if non-empty.

## Skills
- /mastersoft:audit — for the security-review pass before merge.
- /mastersoft:commit — once the refresh-token logic lands.
```
