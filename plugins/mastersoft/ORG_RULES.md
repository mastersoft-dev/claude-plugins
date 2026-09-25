---
# Mastersoft org-wide plugin config + preamble text.
#
# Edit this single file to tune lint-signal behavior. Bump the plugin version
# (plugin.json) when shipping changes. Users get the new version after
# `/plugin marketplace update mastersoft` and `/reload-plugins`: background
# auto-update is off for this marketplace unless managed settings set
# `autoUpdate: true` on its `extraKnownMarketplaces` entry.
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
# Uncodified auto-memory entries (everything except the MEMORY.md index and
# `reference`-type pointers, across both filename-prefix and slug+frontmatter
# naming). `patterns_promote_threshold`+ entries with new writes since the last
# triage → `patterns-to-promote`. Separately, entries left untriaged longer
# than `memory_review_days` → `memory-review-due` (staleness nudge).
# Run /mastersoft:promote-patterns to triage.
patterns_promote_threshold: 3       # env: MASTERSOFT_PATTERNS_PROMOTE_THRESHOLD
memory_review_days: 30              # env: MASTERSOFT_MEMORY_REVIEW_DAYS

# ─── Rule-file staleness ────────────────────────────────────────────
# CLAUDE.md / AGENTS.md / @-imported rule files untouched while the
# repo moved. Generous — rule files are stable by design.
rule_stale_commits: 40              # env: MASTERSOFT_RULE_STALE_COMMITS
rule_stale_days: 120                # env: MASTERSOFT_RULE_STALE_DAYS

# ─── Push confirmation ──────────────────────────────────────────────
# Pushes to these branches ask for confirmation; others go straight
# through. Comma-separated; `name/*` = prefix, `*` = every branch.
push_protected_branches: main,master,develop,dev,staging,production,release/*   # env: MASTERSOFT_PUSH_PROTECTED_BRANCHES, plugin option: push_protected_branches
---

## Rule taxonomy

Three enforcement layers. Where you change a rule depends on which layer
enforces it — read this table before editing.

| Layer | Enforced where | Example rules | How to change |
|---|---|---|---|
| **Harness** | Claude Code managed-settings + PreToolUse hooks | push confirmation on protected branches; marketplace allowlist; Claude Code version floor (`minimumVersion` / `requiredMinimumVersion`) | claude.ai org settings (out-of-repo) for managed-settings keys; `push_protected_branches` above + `hooks/suggest-push.js` for the push-confirm hook. No managed key sets a minimum plugin version: to hold everyone on one release, point the managed `extraKnownMarketplaces` source at a tag with `ref` |
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
| `tier:1` | operating posture (how to work) | session start: startup/clear/resume/compact/fork (main agent only) | SessionStart |
| `tier:2` | code hygiene standards | session start (as tier 1), mid-session when context grows ≥ `_DISTANCE_PCT`, + every Mastersoft subagent | SessionStart, UserPromptSubmit, SubagentStart |
| `tier:3` | output style (keep ~1 line) | every prompt, + every Mastersoft subagent | UserPromptSubmit, SubagentStart |

Cadence/visibility env (precedence: env > built-in):
- `MASTERSOFT_ORG_RULES=off\|session\|all` — `all` (default) = all tiers; `session` = tiers 1+2 only (no per-prompt tier 3); `off` = none. Also the `org_rules` plugin option, which the env var overrides.
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
- Think before coding — proportional to ambiguity. Clear requirements + a simple task → just proceed; no grilling. Real ambiguity → state assumptions, surface competing interpretations with AskUserQuestion, don't guess silently. If a simpler approach exists or the request looks wrong, say so before building. Don't over-plan: skip a plan when the path is obvious; for genuinely multi-step work draft a short one (a task list or plan mode). On non-trivial design, use plan mode before committing.
- Simplicity first. Minimum code for the stated problem — no speculative features, single-use abstractions, unrequested configurability, or handling for impossible cases. 200 lines that could be 50 → rewrite.
- Surgical changes. Touch only what the request requires; prefer Edit over rewrite; match existing style; don't reformat adjacent code. Remove only the symbols your change orphaned — flag other dead code, don't delete it. Every changed line should trace to the request.
- Verify, don't assume done. Turn the task into a checkable goal (e.g. "add validation" → write failing tests for bad input, then make them pass). Run the check; loop until green. Report what ran and what was skipped. Before declaring done on substantial changes, review them — delegate to the code-reviewer agent.
- Route questions by breadth. A scoped codebase or library question — a single-fact lookup, "where is X", "what does Y do", a small count — goes to the ask skill (cheap, isolated subcontext); the Explore agent is for broad multi-location fan-out, not quick facts.
- Capture durable context to auto-memory. Project-specific environment and setup conventions the repo doesn't already record — e.g. e2e runs against a local mail catcher, not a real SMTP server; a service needs a local Redis to test — and corrections you'd otherwise re-explain next session are worth a memory note so future sessions inherit them. Skip what the code, git history, or rules files already state.

<!-- tier:2 -->
Mastersoft code hygiene standards:
- Types at boundaries. Validate/parse external input (HTTP, DB, queue, FFI, file) into typed domain models; no `any` or untyped maps internally; explicit types on public APIs.
- Errors. Handle only what the layer can act on, else propagate; no silent fallbacks or empty catches; message = what failed + safe identifier + actionable hint.
- No magic values / hardcoded env. Named constants; URLs/paths/ports/timeouts in config; never inline secrets or keys.
- Concurrency & resources. Every async call has a timeout + cancellation; bounded retries with backoff + jitter; no blocking I/O in an async runtime; close/release files, sockets, cursors.
- Tests. Hit real adapters where feasible, mock only external I/O; one behavior per test; never weaken an assertion to make it pass.
- Comments. No comments in the code body — neither block nor trailing. Code self-documents the what; the WHY lives in the commit message, a doc, or a docstring. Docstrings and public-API/reference docs are the only allowed form. No commented-out code; no TODO / FIXME / XXX in merged diffs (track those in issues).
- Shape & security. Functional-core / imperative-shell; composition over inheritance; no dead code; parameterized queries; encode outputs by context; least privilege; never log secrets or PII.
- Git messages stay short, whoever writes them. Commits: Conventional Commits subject only (`<type>: summary`, no scope except `chore(release):`); a body appears only when the WHY is not obvious from subject + diff, at most 3 short lines, never a file list, change rundown, or test results — renames, typos, formatting, dependency bumps, and small single-purpose diffs never get one. Merge requests (GitLab) and pull requests (GitHub) follow one rule: commit-style title, body empty or 1–2 lines plus `Closes #N`; headed sections only when the user asks or a breaking change / migration needs flagging; a repo template keeps only the sections that apply. Issues: a descriptive title and only the sections that carry information. The CLI follows `git remote get-url origin`: GitLab host → `glab`, github.com → `gh`.

<!-- tier:3 -->
Be brief: lead with the answer, cut filler and preamble. Write code, documentation, and security notes normally.
