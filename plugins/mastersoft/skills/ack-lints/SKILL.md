---
name: ack-lints
description: Acknowledge Mastersoft lint signals for this repo. Defers (silences in this session) or suppresses indefinitely. Use proactively when lint signals are surfacing and the user chooses not to apply /mastersoft:refresh-rules right now. Three args supported - "defer", "suppress", or "clear". Defer touches .claude/.mastersoft-lints-ack (TTL hours). Suppress writes .claude/.mastersoft-lints-suppress (indefinite, until manually deleted). Clear removes both.
allowed-tools: Bash(node:*), Read, Write, PowerShell
argument-hint: "defer | suppress | clear"
---

# Ack-Lints

Records the user's choice on how to handle the lint signals that lint-engine surfaces in a session. Per-directory + per-session by design.

## Inputs

Single argument:

- `defer` — write `.claude/.mastersoft-lints-ack`. Suppresses lint signals in this repo until `MASTERSOFT_LINTS_ACK_HOURS` (default 4) elapse from the file's mtime. Typical scope: "for this session."
- `suppress` — write `.claude/.mastersoft-lints-suppress`. Indefinite — survives across sessions until the user deletes the file. Per-repo opt-out.
- `clear` — remove both files. Re-enables lint signals.

## Procedure

Run the cross-platform helper. It resolves the repo root, ensures `.claude/` exists, touches/writes/removes the right sentinel, and appends both sentinel paths to `.gitignore` if missing. All file operations are Node-native — works identically on macOS, Linux, Windows, and WSL.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js ack-lints {defer|suppress|clear}
```

Pass the user's choice as the single positional argument. The helper prints a one-line result to stdout.

## Refusal cases

- Unknown arg → helper prints `Usage: …` and exits 2; relay that message.
- Not in a git repo → helper still works (uses cwd as repo root); the sentinel just lives wherever you ran the command from. Warn the user if this looks unintentional.

## Notes

- **Never mutates anything else.** Only the two sentinel files + a possible append to `.gitignore`.
- The hook (`lint-engine.js`) honors these files at next prompt — no reload needed.
- Suppress is per-repo, not per-team: both sentinel files are gitignored so other devs/sessions on the same repo are unaffected.
- The helper is OS-agnostic; do NOT shell out to POSIX-only `touch`/`rm`/`mkdir` for these operations.
