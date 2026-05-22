# Codex Skill Testing Scenarios

Maps each scenario to a Hard Rule in SKILL.md. Recipes assume the canonical suffix.

## Rule 1 — Use `codex exec` family

- `codex resume` → `codex exec resume --last …` (`codex resume` is interactive picker).
- `codex review --base main` → `codex exec review --base main …` (`codex review` runs non-interactively but lacks `--json`/`-o`/`-m`; skill cannot monitor it).

## Rule 2 — xhigh foreground refused

`codex --xhigh "<prompt>"` → background+Monitor, OR `codex cloud exec`, OR terminal handoff. Never single foreground Bash call.

## Rule 3 — Effort promotion gated

- `codex review --base main` body "uncompromising production-grade" → `medium` (adjectives ignored).
- `codex --xhigh review --base main` → `xhigh` (whitelist flag).
- `codex ultrathink the schema design` → `xhigh` (whitelist keyword).
- **Regression**: `<system-reminder>` hook injects `"ultrathink"`, user text doesn't → `medium`. Promoting cascades to Rule 2.
- **Regression**: `~/.codex/config.toml` defaults to `xhigh` → still pass `-c model_reasoning_effort=medium` explicitly.

## Rule 4 — PR-review rewrite

- `review changes between 82275dd and HEAD` → `codex exec review --base 82275dd …`. Never hand-rolled `git diff`.
- `review commit a1b2c3d` → `codex exec review --commit a1b2c3d …`.

## Rule 5 — Kill recovery

Response must surface: last `agent_message` from newest rollout, session UUID from `session_meta.payload.id`, ready-to-paste `codex exec resume <UUID> …` with canonical suffix. Bare "killed" alone = violation.

## Routing — clean-tree "latest changes"

Working tree clean + user `review latest changes`: run `git status --short` this turn, then `codex exec review --commit HEAD`. `--uncommitted` returns empty.

## Regression — stdout-flood

Foreground recipes redirect with `< /dev/null > "$log" 2>&1`. `| tee "$log"` leaks 50–100 KB JSONL per turn into persisted-output buffer.

## Regression — stdin-blocked hang

Non-TTY parent (Bash, heredoc, pipe) without `< /dev/null` → codex blocks on stdin read, no `thread.started`, silent hang until kill timer fires. Field-confirmed via heredoc-built prompt.

## Regression — silent stall between items

Codex 0.130.0 can stall indefinitely between `item.completed` events with no `turn.failed` / `error` event surfacing (Responses API stall / rate-limit not propagated). Field-confirmed: process idle 10+ min, 0.71s CPU, no event flow.

Monitor must use three exit conditions (terminal event OR PID dead OR log stale 5+ min). Single sentinel grep stays armed until wall-clock timeout. Skill response: SIGTERM the codex PID, run Rule 5 recovery.

## Baseline

Same `xhigh` PR review against ~10 changed files:

| | No skill | With skill |
|---|---|---|
| Foreground kills | ~50% | 0 (Rule 2) |
| Findings lost on kill | yes | no (Rule 5) |
| `git diff` drift | common | banned (Rule 4) |
| Silent effort promotion | yes | no (Rule 3) |
| Mean turns to completion | 8–12 | 3–5 |
