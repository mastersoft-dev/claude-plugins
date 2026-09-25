# Changelog

All notable user-facing changes to the Mastersoft Claude Code plugin are
documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `/mastersoft:help` prints the reference card directly instead of failing
  and searching the plugin cache for it.
- `/mastersoft:recall` runs its session index again: the `hindsight` agent was
  calling `/scripts/recall.js` and fell back to reading transcripts by hand.
- `/mastersoft:doc` reads the type and title from the right arguments and finds
  its templates without a fallback.
- `/mastersoft:codex` — the background recipe keeps the log path when the skill
  is invoked with three or more arguments.

## [3.6.0] — 2026-09-24

### Added

- Org rules now keep commit messages, GitLab merge requests, GitHub pull
  requests and issues short in every session, not only when `/mastersoft:commit`
  or `/mastersoft:glab` runs: subject-only commits by default, MR/PR bodies of
  one line at most unless you ask for more.

### Changed

- Push confirmation now asks only for protected branches (`main`, `master`,
  `develop`, `dev`, `staging`, `production`, `release/*` by default); pushes
  to feature branches go straight through, so unattended runs don't stall.
  Tune the list with `push_protected_branches` in `ORG_RULES.md` or
  `MASTERSOFT_PUSH_PROTECTED_BRANCHES` (`*` restores asking on every branch).
  Chained commands (`git commit … && git push`) and the push done by
  `glab mr create --fill` are covered too; when the destination can't be read
  reliably (a `cd` or branch switch earlier in the same command, shell
  variables, wildcards) it asks.
- `/mastersoft:glab` — opening an MR no longer asks for the target branch up
  front: it detects the base branch and shows it in a single confirmation.
  Repo templates are filled with only the sections that apply, and the bundled
  MR/issue templates are much thinner.

### Fixed

- Skills that delegate to agents (`ask`, `audit`, `adversary`, `investigate`,
  `recall`, `verify`, `refresh-rules`) use the current `Agent` tool, and
  context7 works when installed as a plugin.
- `/mastersoft:audit-deps` detects Bun's `bun.lock`, tells Yarn classic from
  Berry, and explains the missing `poetry export` on Poetry 2.
- `/mastersoft:codex` matches codex-cli 0.156 (removed `--full-auto` and
  `--profile-v2`, new `max` effort).
- `/mastersoft:sentry` reports missing authentication and fetches the latest
  event with the numeric issue id.
- Hook commands work when the plugin path contains spaces.

## [3.5.1] — 2026-07-20

### Fixed

- `/mastersoft:commit` — Italian commit subjects now use the past participle
  (`spostato`, `disabilitato`) instead of drifting to the imperative.
- `/mastersoft:release` — version bump now applies correct precedence (a
  `BREAKING CHANGE` forces a major bump even alongside `feat:` commits), and
  workflow detection no longer silently picks the wrong shape on ambiguous repos.
- `/mastersoft:doc` — the doc-type registry resolves reliably (it could return
  an empty type list and refuse to author anything).
- `/mastersoft:sentry` — "recently surfaced" filtering no longer hides
  long-standing high-impact issues, and the stack-trace pull works when
  credentials live only in `.sentryclirc`.
- Reliability and least-privilege fixes across `verify`, `refresh-rules`,
  `codex`, `ask`, `audit`, `handoff`, and `init-rules` from a plugin-wide
  skill-authoring review.

## [3.5.0] — 2026-07-17

### Features

- `/mastersoft:sentry` — triage Sentry issues via `sentry-cli` (self-hosted
  friendly): list unresolved errors, rank by impact, pull the latest event's
  stack trace, and propose repo-aware fixes. Read-only by default; `--fix` gates
  resolve/mute behind confirmation.

## [3.4.0] — 2026-06-10

### Features

- `/mastersoft:recall` and the `hindsight` agent — look back over your past
  Claude Code sessions: recap recent ones, or search past sessions for a topic
  with resume ids.

## [3.3.1] — 2026-06-03

### Breaking Changes

- Migrated Git-hosting tooling from Gitea to GitLab: the `tea` integration is
  replaced by `glab`, and the release workflow now targets GitLab.

### Features

- `/mastersoft:glab` — GitLab CLI skill for merge requests, issues, labels,
  CI/CD pipelines, releases, and auth.

### Bug Fixes

- Hygiene lint signals no longer re-fire after `audit-deps`, `refresh-rules`, or
  `verify` record a run.

## [3.2.2] — 2026-05-29

### Bug Fixes

- Statusline honors a nested `statusLine.command` in the wrapper override.
- `refresh-rules` hardened against isolated contexts, the `brief-deprecated`
  loop, and signal fatigue.

## [3.2.0] — 2026-05-28

### Features

- `/mastersoft:adversary` and the `devils-advocate` agent — red-team / pre-mortem
  of a plan, design, or decision, ranked by likelihood × impact.
- Lint toast now enumerates the active signals with each one's fix command; added
  auto-memory promotion signals (`patterns-to-promote`, `memory-review-due`).

## [3.1.3] — 2026-05-27

### Changed

- Tuned model and reasoning-effort defaults across the plugin agents.

## [3.1.1] — 2026-05-27

### Bug Fixes

- Lint signals are sorted by severity before the output budget cap, so a
  high-severity signal is never dropped by lower-priority ones.
- `brief-deprecated` restored on the first prompt and moved to its own
  `migration` category, so a `rules` defer no longer silences it.

## [3.1.0] — 2026-05-27

### Features

- BRIEF.md deprecation is surfaced as a lint signal, and dependency-lockfile
  detection for the security-audit signal was widened to more stacks.

## [3.0.0] — 2026-05-27

### Features

- Rule-hygiene layer: lint-engine signals for stale, oversized, or drifted rule
  files, plus refresh/verify cadence.
- Adaptive release workflow — tagged vs untagged/changelog-anchored,
  auto-detected per repo.

---

Versions 2.8.x and earlier predate this changelog — see the git history.
