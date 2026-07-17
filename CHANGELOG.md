# Changelog

All notable user-facing changes to the Mastersoft Claude Code plugin are
documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
