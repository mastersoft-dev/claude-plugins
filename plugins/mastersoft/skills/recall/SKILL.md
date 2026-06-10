---
name: recall
description: Look back over your own past Claude Code sessions. Read-only. Use proactively when the user asks "what was I working on", "did we discuss X before", "when did we decide Y", "find that past chat about Z", or wants a recap of recent sessions. Default (no query) recaps the current repo's recent sessions; a query searches past sessions for it. Scope another repo with --project <name>. For codebase questions use ask; for current-work root-cause use investigate.
model: sonnet
argument-hint: "[query] [--project <name>] [--all-projects]"
---

Look back over the user's past Claude Code sessions. Delegate to the `hindsight` agent — it
reads the transcripts in an isolated subcontext (they can be large) and returns a synthesized
answer, keeping the raw history out of this conversation.

## Delegate

Forward the request verbatim. `$ARGUMENTS` may be empty (recap mode), a search query, and/or
flags like `--project <name>` / `--all-projects` — pass them through unchanged.

```
Task(subagent_type: "hindsight", model: "sonnet", prompt: "$ARGUMENTS")
```

Tell the agent which mode the request implies, so it picks the right `recall.js` subcommand:
- **Empty `$ARGUMENTS`** → recap the most recent sessions for the current repo (`list`).
- **A topic or question** → find the past sessions about it (`search`).
- **A session id, or "show me that one"** → dump that session (`show`).

## Retry on empty response

If the agent returns nothing substantive (empty, metadata only, or clearly no answer), retry once
with more budget: `max_turns: 40, model: "sonnet"`. If it still fails:

> "Hindsight couldn't pull a useful answer. Try a narrower topic, add `--all-projects`, or check that the sessions aren't older than the 30-day transcript retention."

## After a successful response

**STOP.** Return the agent's answer. Do NOT do additional research, spawn other agents, read
transcripts yourself, or re-process the answer.

## Help

### Synopsis
Retrospective search and recap over your own past Claude Code sessions (read-only).

### Examples
- `recall` — recap the most recent sessions in the current repo
- `recall "the gitlab migration decision"` — find past sessions that discussed it, with resume ids
- `recall "auth flow" --project legion` — search another repo's sessions
- `recall "why did we drop gitea" --all-projects` — search across every repo

### Checklist
- Default (no query) = recent-sessions recap for the current repo
- A query = search past sessions, ranked by relevance, with resume ids
- `--project <name>` targets another repo; `--all-projects` searches all
- Answers are grounded in transcript excerpts — never reconstructed from memory
- Read-only: never modifies code or transcripts
