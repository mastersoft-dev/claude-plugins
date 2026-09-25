---
name: verify
description: Run a semantic verification of project rule files (CLAUDE.md / AGENTS.md, .claude/rules/) against actual codebase state via the rule-auditor agent. Detects contradictions like rules say pnpm but lockfile says npm, stale build commands, architecture drift, zero-match path globs, dangling doc cross-refs, oversized rule files that should be split into path-scoped rules, entry-level claim staleness (counts/symbols/paths that no longer match code), and misplaced content (settled decisions that belong in docs/). Read-only on the repo — outputs evidence-backed findings only. Not auto-invoked (user- or /schedule-triggered); run it when lint-engine signals "verify due" or on schedule via /schedule.
disable-model-invocation: true
context: fork
agent: mastersoft:rule-auditor
background: false
allowed-tools: Read, Bash(git rev-parse:*), Bash(node:*), PowerShell(git rev-parse *), PowerShell(node *)
argument-hint: "[--report-only]"
---

# Verify

Standalone full audit of this repo's rule files. The skill runs as a forked `rule-auditor` (the single source of check logic, shared with `/mastersoft:refresh-rules`) that waits in the turn that invoked it, so this skill's `allowed-tools` cover every step, persisting included. Never edits the repo — writes happen in `/mastersoft:refresh-rules`.

## Procedure

1. **Resolve the repo root** with `git rev-parse --show-toplevel`. Outside a git repo, reply "Run inside a git repo." and stop.

2. **Audit.** Run your full procedure on that root: a standalone run with no input signals, so audit everything.

3. **Persist the finding blocks** — the human-readable blocks of your output, or `No issues detected.` when there are none — through a quoted heredoc, one block per finding in exactly this shape:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js write-findings <<'FINDINGS_EOF'
   ## Finding 1 — <one-line summary>
   **Severity**: high
   **Class**: b
   **Signal**: —
   **Evidence**: AGENTS.md:8 says "X"; package.json shows "Y".
   **Suggestion**: <one-line fix>.
   **Files**: AGENTS.md, package.json
   FINDINGS_EOF
   ```

   The labels stay in English as shown, whatever language you reply in. Write the heredoc straight from this template: the helper prints `Wrote findings to <path>` on success, and otherwise names the block and the missing Severity or Evidence line, so its reply is all the check you need. Keep the json block out of the heredoc: Claude Code's permission check refuses a `{` followed by a quote, and the helper builds the JSON from the blocks. It adds `generatedAt` + `repoRoot` and atomically writes `verify-findings/<slug>.json` in the shared state dir (`~/.claude/mastersoft/state/`, overridable via `MASTERSOFT_STATE_DIR`). `/mastersoft:refresh-rules` reads it to skip re-analysis when a recent verify exists.

4. **Record `last-verify-at`**:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js record-verify
   ```

5. **Reply** with your output: the finding blocks, then the json block. Unless `$ARGUMENTS` contains `--report-only` (used by scheduled runs), end with "To apply suggested fixes, run `/mastersoft:refresh-rules`."

## Refusal cases

- Not in a git repo → "Run inside a git repo."
- `MASTERSOFT_VERIFY_MODE=off` → exit silent.
- No rule files → reply "No rule files to verify. Run /mastersoft:init-rules to scaffold." and skip steps 3–4.

## Notes

- **Read-only on the repo.** The only writes are the plugin state of steps 3–4. Findings that imply a change point at `/mastersoft:refresh-rules` for the user-gated apply path.
- **Why a fork.** In an interactive session a subagent spawned with `Agent` runs in the background and reports in a later turn, where this skill's `allowed-tools` no longer apply, so the persisting steps asked for permission. `background: false` keeps the fork inside the invoking turn.
- **Cost ceiling.** The agent is Sonnet and rare-fire. Do not chain other skills.
