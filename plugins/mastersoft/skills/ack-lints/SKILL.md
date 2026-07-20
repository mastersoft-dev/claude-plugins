---
name: ack-lints
description: Acknowledge Mastersoft lint signals for this repo. Defers (silences for a TTL window, default 4h, repo-scoped) or suppresses indefinitely. Use proactively when lint signals are surfacing and the user chooses not to apply /mastersoft:refresh-rules right now. Args - "defer [categories...]", "suppress", or "clear". Defer without categories acks all; "defer rules" acks only rules-category signals. Writes .claude/.mastersoft-lints-ack (TTL) or .mastersoft-lints-suppress (indefinite).
allowed-tools: Bash(node:*), PowerShell
argument-hint: "defer [categories...] | suppress | clear"
---

# Ack-Lints

Records the user's choice on how to handle the lint signals that lint-engine surfaces.
Per-repo, not per-session: the ack persists across `/clear`, `/compact`, and concurrent
sessions in the same repo until the TTL elapses or the file is deleted.

## Inputs

Positional arguments: `defer [categories...]`, `suppress`, or `clear`.

- `defer` — write `.claude/.mastersoft-lints-ack`. Content is a CSV of acked
  categories (e.g. `rules`, or `rules,audit`). Empty content = all categories
  (back-compat with no-arg defer). Signals whose category matches are silenced until
  `MASTERSOFT_LINTS_ACK_HOURS` (default 4, configurable via env or ORG_RULES.md
  `lints_ack_hours`) elapses from the file's mtime. A `defer rules` does NOT silence
  `audit`, `patterns`, `verify`, or `migration` signals.
- `suppress` — write `.mastersoft-lints-suppress`. Indefinite — survives across
  sessions until the user deletes the file. Per-repo opt-out.
- `clear` — remove both files. Re-enables all lint signals immediately.

Categories: `rules`, `audit`, `patterns`, `verify`, `migration`. Defer with no
extra args acks all categories.

## Procedure

Run the cross-platform helper. It resolves the repo root, ensures `.claude/` exists,
touches/writes/removes the right sentinel, and appends both sentinel paths to
`.gitignore` if missing. All file operations are Node-native — works identically on
macOS, Linux, Windows, and WSL.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js ack-lints {defer [categories...]|suppress|clear}
```

Pass the user's choice as the first positional argument; optional categories as
further positional args (`defer rules` → `state.js ack-lints defer rules`). The
helper prints a one-line result to stdout.

## Refusal cases

- Unknown arg → helper prints `Usage: …` and exits 2; relay that message.
- Not in a git repo → helper still works (uses cwd as repo root); the sentinel just lives wherever you ran the command from. Warn the user if this looks unintentional.

## Notes

- **Never mutates anything else.** Only the two sentinel files + a possible append to `.gitignore`.
- The hook (`lint-engine.js`) honors these files at next prompt — no reload needed.
- Suppress is per-repo, not per-team: both sentinel files are gitignored so other devs/sessions on the same repo are unaffected.
- The helper is OS-agnostic; do NOT shell out to POSIX-only `touch`/`rm`/`mkdir` for these operations.
