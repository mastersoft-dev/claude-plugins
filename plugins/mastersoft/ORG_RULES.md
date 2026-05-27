---
# Mastersoft org-wide plugin config + preamble text.
#
# Edit this single file to tune lint-signal behavior. Bump the plugin version
# (plugin.json + marketplace.json) when shipping changes so users pick
# them up on /reload-plugins.
#
# Per-key precedence: env var > this frontmatter > built-in default.
# (Env names listed in comment after each key.)

# ─── CLAUDE.md / imported rule file size ────────────────────────────
claude_max_lines: 200               # env: MASTERSOFT_CLAUDE_MAX_LINES

# ─── Refresh + verify cadence ───────────────────────────────────────
refresh_interval_days: 60           # env: MASTERSOFT_REFRESH_INTERVAL_DAYS
verify_min_age_days: 7              # env: MASTERSOFT_VERIFY_MIN_AGE_DAYS
verify_mode: suggest                # off|suggest. env: MASTERSOFT_VERIFY_MODE

# ─── Security audit ─────────────────────────────────────────────────
audit_interval_days: 14             # env: MASTERSOFT_AUDIT_INTERVAL_DAYS
audit_enabled: true                 # env: MASTERSOFT_AUDIT_ENABLED (0/1)

# ─── Lint ack behavior ──────────────────────────────────────────────
lints_ack_hours: 4                  # env: MASTERSOFT_LINTS_ACK_HOURS

# ─── Auto-memory pattern promotion ──────────────────────────────────
# Number of uncodified feedback/project entries in Claude Code's
# per-repo auto-memory that triggers the `patterns-to-promote` signal.
# Run /mastersoft:promote-patterns to triage.
patterns_promote_threshold: 3       # env: MASTERSOFT_PATTERNS_PROMOTE_THRESHOLD

# ─── Rule-file staleness ────────────────────────────────────────────
# CLAUDE.md / AGENTS.md / @-imported rule files untouched while the
# repo moved. Generous — rule files are stable by design.
rule_stale_commits: 40              # env: MASTERSOFT_RULE_STALE_COMMITS
rule_stale_days: 120                # env: MASTERSOFT_RULE_STALE_DAYS
---

## Rule taxonomy

Three enforcement layers. Where you change a rule depends on which layer
enforces it — read this table before editing.

| Layer | Enforced where | Example rules | How to change |
|---|---|---|---|
| **Harness** | Claude Code managed-settings + PreToolUse hooks | `git push` confirmation; marketplace allowlist; min plugin version | claude.ai org settings (out-of-repo) for managed-settings keys; `hooks/suggest-push.js` for the push-confirm hook |
| **Lint** | `hooks/lint-engine.js` per-prompt signals | CLAUDE.md/AGENTS.md staleness; file-size caps; audit cadence; stale path refs | YAML frontmatter above (each key comments its env-var override) |
| **Model** | Injected `additionalContext`, tiered (see below) | tier 1 operating posture; tier 2 code hygiene standards; tier 3 brevity | tier prose below |

Mute everything in a shell: `MASTERSOFT_QUIET=1`. Mute lint signals only
(keep the ORG preamble): `MASTERSOFT_QUIET=lints`. Mute only the per-prompt
nudge (tier 3): `MASTERSOFT_QUIET=tier3`. Per-repo persistent suppress:
`.claude/.mastersoft-lints-suppress`.

### Model-tier injection (the prose below)

Three marked sections, injected as `additionalContext` on different cadences
(see `hooks/lib-org-rules.js`). They carry distinct, non-overlapping content —
on a fresh session tiers 1+2 land together, so they must not repeat each other.

| Marker | Content | Injected on | Hook |
|---|---|---|---|
| `tier:1` | operating posture (how to work) | session start: startup/clear/resume/compact (main agent only) | SessionStart |
| `tier:2` | code hygiene standards | session start (as tier 1), mid-session when context grows ≥ `_DISTANCE_PCT`, + every Mastersoft subagent | SessionStart, UserPromptSubmit, SubagentStart |
| `tier:3` | output style (keep ~1 line) | every prompt, + every Mastersoft subagent | UserPromptSubmit, SubagentStart |

Cadence/visibility env (precedence: env > built-in):
- `MASTERSOFT_ORG_RULES=off\|session\|all` — `all` (default) = all tiers; `session` = tiers 1+2 only (no per-prompt tier 3); `off` = none.
- `MASTERSOFT_ORG_RECURRING_DISTANCE_PCT` — re-inject tier 2 when context-window usage grows by this many percentage points since the last assertion (default `15`, `0` = off). Reads the live statusline metric; dormant if the Mastersoft statusline isn't active.
- `MASTERSOFT_ORG_TIER1_TEXT` / `_TIER2_TEXT` / `_TIER3_TEXT` — *replace* a tier's wording (string, `\n` allowed). Set via managed-settings `env` to retune without re-shipping the plugin.
- `MASTERSOFT_ORG_TIER1_APPEND` / `_TIER2_APPEND` / `_TIER3_APPEND` — *append* on top of a tier's base. Use project-settings `env` to add a repo-conditional rule (e.g. tenant isolation) without restating the floor.

Everything above the first `<!-- tier:* -->` marker is maintainer documentation
and is **not** injected. Phrase tier content as declarative project facts, not
imperative system commands (imperative framing can trip prompt-injection
defenses; see Claude Code hooks docs).

---

<!-- tier:1 -->
Operating posture for this agent:
- Think before coding — proportional to ambiguity. Clear requirements + a simple task → just proceed; no grilling. Real ambiguity → state assumptions, surface competing interpretations with AskUserQuestion, don't guess silently. If a simpler approach exists or the request looks wrong, say so before building. Don't over-plan: skip a plan when the path is obvious; for genuinely multi-step work draft a short one (TodoWrite / plan mode). On non-trivial design, pressure-test the approach with the advisor tool before committing — or, if no advisor tool is available, use plan mode.
- Simplicity first. Minimum code for the stated problem — no speculative features, single-use abstractions, unrequested configurability, or handling for impossible cases. 200 lines that could be 50 → rewrite.
- Surgical changes. Touch only what the request requires; prefer Edit over rewrite; match existing style; don't reformat adjacent code. Remove only the symbols your change orphaned — flag other dead code, don't delete it. Every changed line should trace to the request.
- Verify, don't assume done. Turn the task into a checkable goal (e.g. "add validation" → write failing tests for bad input, then make them pass). Run the check; loop until green. Report what ran and what was skipped. Before declaring done on substantial changes, review them — delegate to the code-reviewer agent.
- Route questions by breadth. A scoped codebase or library question — a single-fact lookup, "where is X", "what does Y do", a small count — goes to the ask skill (cheap, isolated subcontext); the Explore agent is for broad multi-location fan-out, not quick facts.

<!-- tier:2 -->
Mastersoft code hygiene standards:
- Types at boundaries. Validate/parse external input (HTTP, DB, queue, FFI, file) into typed domain models; no `any` or untyped maps internally; explicit types on public APIs.
- Errors. Handle only what the layer can act on, else propagate; no silent fallbacks or empty catches; message = what failed + safe identifier + actionable hint.
- No magic values / hardcoded env. Named constants; URLs/paths/ports/timeouts in config; never inline secrets or keys.
- Concurrency & resources. Every async call has a timeout + cancellation; bounded retries with backoff + jitter; no blocking I/O in an async runtime; close/release files, sockets, cursors.
- Tests. Hit real adapters where feasible, mock only external I/O; one behavior per test; never weaken an assertion to make it pass.
- Comments. No comments in the code body — neither block nor trailing. Code self-documents the what; the WHY lives in the commit message, a doc, or a docstring. Docstrings and public-API/reference docs are the only allowed form. No commented-out code; no TODO / FIXME / XXX in merged diffs (track those in issues).
- Shape & security. Functional-core / imperative-shell; composition over inheritance; no dead code; parameterized queries; encode outputs by context; least privilege; never log secrets or PII.

<!-- tier:3 -->
Be brief: lead with the answer, cut filler and preamble. Write code, commits, documentation, and security notes normally.
