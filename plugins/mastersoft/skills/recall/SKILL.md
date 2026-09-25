---
name: recall
description: Look back over your own past Claude Code sessions. Read-only. Use proactively when the user asks "what was I working on", "did we discuss X before", "when did we decide Y", "find that past chat about Z", or wants a recap of recent sessions. Default (no query) recaps the current repo's recent sessions; a query searches past sessions for it. Scope another repo with --project <name>. For codebase questions use ask; for current-work root-cause use investigate.
context: fork
agent: mastersoft:hindsight
background: false
model: sonnet
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/recall.js" *)
argument-hint: "[query] [--project <name>] [--all-projects]"
---

Request: $ARGUMENTS

Answer this request about the user's past Claude Code sessions. The skill runs as a forked `hindsight` agent that waits in the turn that invoked it, so this skill's `allowed-tools` cover your `recall.js` calls. The request may be empty, a search query, and/or flags like `--project <name>` / `--all-projects`; pass the flags to `recall.js` unchanged.

- **Empty request** → recap the most recent sessions for the current repo (`list`).
- **A topic or question** → find the past sessions about it (`search`).
- **A session id, or "show me that one"** → dump that session (`show`).

If a search returns nothing substantive, narrow the query once to the part that went unanswered and search again. If that also fails, reply:

> "Hindsight couldn't pull a useful answer. Try a narrower topic, add `--all-projects`, or check whether Claude Code pruned the sessions (`cleanupPeriodDays`, default 30) or never saved them (`CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `--no-session-persistence`)."

Reply with the answer only, grounded in transcript excerpts and with resume ids.
