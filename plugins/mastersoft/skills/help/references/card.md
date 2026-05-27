# Mastersoft plugin — reference



## Skills

| Skill | Purpose |
|---|---|
| `/mastersoft:ack-lints` | Defer / suppress / clear lint signals for the current repo. |
| `/mastersoft:android-testing` | Build, install, test, drive Android apps via skill tools (not raw `adb`). |
| `/mastersoft:ask` | Fast read-only Q&A about codebase / libraries / concepts. |
| `/mastersoft:audit` | Static security audit with severity ratings + mitigations. |
| `/mastersoft:audit-deps` | Run native dependency audit (`npm`/`pip`/`cargo`/…); records timestamp so the `security-audit-due` lint goes quiet. |
| `/mastersoft:codex` | Orchestrate OpenAI Codex CLI non-interactively. |
| `/mastersoft:doc` | Author a design doc (`adr`, `prd`) under `docs/<type>/` from a template. `doc <type> "<title>"`. Registry-driven (rfc/postmortem/runbook/onboarding add later). |
| `/mastersoft:commit` | Atomic Conventional Commits with adaptive quality gates. |
| `/mastersoft:handoff` | Save conversation-only context for the next chat. |
| `/mastersoft:help` | This card. |
| `/mastersoft:init-rules` | Scaffold `AGENTS.md` + a `CLAUDE.md` that imports it, `.claude/rules/`, `docs/adr/`, `docs/prd/` for a fresh repo. |
| `/mastersoft:investigate` | Read-only root-cause diagnosis + stack-trace triage. |
| `/mastersoft:promote-patterns` | Triage Claude Code auto-memory entries; route each to repo rules, user-global rules, or leave in auto-memory. |
| `/mastersoft:refresh-rules` | Audit + refresh rule files via the `rule-auditor` agent; section-by-section diff gated by `AskUserQuestion`, then a final re-audit pass over edited entries. |
| `/mastersoft:release` | Version bump + changelog + adaptive workflow: tagged (git tag + Gitea release) or untagged/changelog-anchored, auto-detected and recorded in the rules file. |
| `/mastersoft:tea` | Gitea/Forgejo `tea` CLI for PRs, issues, labels, repos, auth. |
| `/mastersoft:verify` | Semantic verify of rule files against actual repo state via the read-only `rule-auditor` agent (Haiku). |
| `/mastersoft:vet` | Read-only static code review with severity ratings. |

## Lint signal catalog

Each per-prompt signal is emitted as a two-line bullet:

```
- [SIGNAL id=<id> severity=<info|warn|high> fix=<command>]
  <prose body>
```

Stable `id` values:

| id | severity | trigger | suggested fix |
|---|---|---|---|
| `no-rules-file` | info | No `CLAUDE.md` at repo root (no project rules loaded; Claude Code reads only `CLAUDE.md`). Fires on prompt #1, exempt from the first-prompt diet. | `/mastersoft:init-rules` |
| `rule-file-oversize` | warn | `CLAUDE.md` or imported rule file > `claude_max_lines` (default 200) | `/mastersoft:refresh-rules` |
| `claude-md-large` | info | `CLAUDE.md` > 100 lines and no `.claude/rules/` yet | `/mastersoft:refresh-rules` |
| `rule-edited-midsession` | info | Rule file mtime > session start (cached rules outdated) | `/clear`, `/compact`, or restart |
| `stale-path-refs` | warn | Path references in rule files point at missing files/dirs | `/mastersoft:refresh-rules` |
| `refresh-overdue` | info | No `last-refresh-at` recorded within `refresh_interval_days` | `/mastersoft:refresh-rules` |
| `security-audit-due` | high | Lockfile changed since last audit OR cadence elapsed | `/mastersoft:audit-deps` |
| `verify-due` | info | Other lints fired AND `verify_min_age_days` elapsed | `/mastersoft:verify` |
| `patterns-to-promote` | info | Auto-memory has `patterns_promote_threshold`+ uncodified feedback/project entries and the dir was touched since last triage | `/mastersoft:promote-patterns` |
| `rule-file-stale` | info | `CLAUDE.md`/`AGENTS.md`/@-import untouched > `rule_stale_commits`/`rule_stale_days` while repo moved | `/mastersoft:verify` |
| `brief-deprecated` | info | `BRIEF.md` present in repo (deprecated pattern — no longer injected or linted by the plugin) | `/mastersoft:refresh-rules` |

Signal **categories** (classify each signal; shown in the `id`): `rules` (CLAUDE/AGENTS staleness, size, refs, refresh), `audit` (security-audit-due), `patterns` (patterns-to-promote), `verify` (verify-due). `/mastersoft:ack-lints defer` acks the whole repo's signals for the session window — it is not category-scoped.

## Suppression mechanisms

| Mechanism | Scope | How |
|---|---|---|
| `MASTERSOFT_QUIET=1` (or `=all`, `=true`) | Shell process | Suppress preamble + signals entirely. CI-friendly. |
| `MASTERSOFT_QUIET=lints` | Shell process | Keep ORG preamble; suppress lint signals only. |
| `.claude/.mastersoft-lints-ack` | Per repo, ~4h TTL | Defer lint signals for the session window. Touched by `/mastersoft:ack-lints defer`. |
| `.claude/.mastersoft-lints-suppress` | Per repo, indefinite | Disable lint signals in this repo until the file is deleted. |
| `MASTERSOFT_SKIP_PUSH_CHECK=1` | Shell process | Skip the `git push` confirmation prompt (for unattended scripts). |

## Env vars and their `ORG_RULES.md` keys

| Env var | Frontmatter key | Default | Effect |
|---|---|---|---|
| `MASTERSOFT_CLAUDE_MAX_LINES` | `claude_max_lines` | `200` | Trigger `rule-file-oversize` past this line count. |
| `MASTERSOFT_REFRESH_INTERVAL_DAYS` | `refresh_interval_days` | `60` | Trigger `refresh-overdue` past this many days. |
| `MASTERSOFT_VERIFY_MIN_AGE_DAYS` | `verify_min_age_days` | `7` | Gate `verify-due` signal. |
| `MASTERSOFT_VERIFY_MODE` | `verify_mode` | `suggest` | `off` disables the `verify-due` chain. |
| `MASTERSOFT_AUDIT_INTERVAL_DAYS` | `audit_interval_days` | `14` | Trigger `security-audit-due` past cadence. |
| `MASTERSOFT_AUDIT_ENABLED` | `audit_enabled` | `true` | Master switch for `security-audit-due`. |
| `MASTERSOFT_LINTS_ACK_HOURS` | `lints_ack_hours` | `4` | TTL of `.mastersoft-lints-ack` defer. |
| `MASTERSOFT_LINT_SCAN_MAX_AGE_MS` | — | `3600000` | Max age of the cached git lint scan before a re-scan (env only). |
| `MASTERSOFT_PATTERNS_PROMOTE_THRESHOLD` | `patterns_promote_threshold` | `3` | Auto-memory entry count that triggers the `patterns-to-promote` signal. |
| `MASTERSOFT_RULE_STALE_COMMITS` | `rule_stale_commits` | `40` | CLAUDE.md/AGENTS.md untouched commits → `rule-file-stale`. |
| `MASTERSOFT_RULE_STALE_DAYS` | `rule_stale_days` | `120` | CLAUDE.md/AGENTS.md untouched days → `rule-file-stale`. |

Precedence per key: env var > `ORG_RULES.md` frontmatter > built-in default. Unknown frontmatter keys are reported once per session via `systemMessage`.

## Where rules live

| Layer | Source of truth | Audience |
|---|---|---|
| Harness | claude.ai org managed-settings + `hooks/suggest-push.js` | Claude Code itself |
| Lint | `plugins/mastersoft/ORG_RULES.md` frontmatter + `hooks/lint-engine.js` | The lint engine |
| Model | `plugins/mastersoft/ORG_RULES.md` body + per-repo `CLAUDE.md` | The model at prompt time |

## Updating org rules

1. Edit `plugins/mastersoft/ORG_RULES.md` (frontmatter for thresholds, body for prose).
2. Bump `plugins/mastersoft/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` to the same new version.
3. Open a PR. Users pick up changes on `/plugin marketplace update mastersoft` + `/reload-plugins`.

## Reporting bugs

`SECURITY.md` for security. `.github/ISSUE_TEMPLATE/` otherwise. Repo: `git.mastersoft.it/mastersoft/claude-plugins`.
