---
name: verify
description: Run a semantic verification of project rule files (CLAUDE.md / AGENTS.md, .claude/rules/) against actual codebase state via the rule-auditor agent. Detects contradictions like rules say pnpm but lockfile says npm, stale build commands, architecture drift, zero-match path globs, dangling doc cross-refs, oversized rule files that should be split into path-scoped rules, entry-level claim staleness (counts/symbols/paths that no longer match code), and misplaced content (settled decisions that belong in docs/). Read-only — outputs evidence-backed findings only. Use when lint-engine signals "verify due", or on schedule via /schedule.
disable-model-invocation: true
allowed-tools: Task, Read, Bash(git rev-parse:*), Bash(node:*), PowerShell
argument-hint: "[--report-only]"
---

# Verify

Thin orchestrator. Delegates the analysis to the read-only `rule-auditor` agent (single source of check logic, shared with `/mastersoft:refresh-rules`), then persists the findings. Never edits — writes happen in `/mastersoft:refresh-rules`.

## Inputs

- `--report-only` (optional): print findings only, no follow-up line. Used by `/schedule` routine runs.

## Procedure

1. **Resolve repo root** via `git rev-parse --show-toplevel`. Abort if not in a git repo.

2. **Spawn the auditor.** Launch the `rule-auditor` agent via `Task`, passing the repo root. No signals (this is a standalone, full audit). Example prompt:

   ```
   Task (subagent_type: rule-auditor):
   Audit the rule files in <repoRoot> against the codebase. Standalone full run — no input signals, audit everything. Return findings (human-readable blocks + the trailing json block).
   ```

3. **Relay + persist.** Print the agent's human-readable finding blocks to stdout verbatim. Extract the trailing ```json findings object and persist it:

   ```
   printf '%s' '<findings-json>' | node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js write-findings
   ```

   The helper adds `generatedAt` + `repoRoot` and atomically writes `verify-findings/<slug>.json` in the plugin data dir. `/mastersoft:refresh-rules` reads it to skip re-analysis when a recent verify exists.

   If the agent reports no findings, persist `{ "findings": [] }`.

4. **Record `last-verify-at`**:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js record-verify
   ```

5. **Final line** (unless `--report-only`): "To apply suggested fixes, run `/mastersoft:refresh-rules`." With `--report-only`: print findings + exit, no follow-up line.

## Refusal cases

- Not in a git repo → "Run inside a git repo."
- `MASTERSOFT_VERIFY_MODE=off` → exit silent.
- Agent reports no rule files → relay "No rule files to verify. Run /mastersoft:init-rules to scaffold."

## Notes

- **Read-only by design.** This skill and the agent never `Edit`/`Write`. Findings that imply a change point at `/mastersoft:refresh-rules` for the user-gated apply path.
- **The agent is the single source of check logic** — `refresh-rules` spawns the same agent (seeded with live lint signals). Keep check classes in the agent, not duplicated here.
- **Cost ceiling.** The agent is Haiku and rare-fire. Do not chain other skills.
