# Changelog

All notable user-facing changes to the Mastersoft Claude Code plugin are
documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/mastersoft:glab`'s MR review flow names `claude --worktree <MR URL>` and
  `/code-review !N --comment` as alternatives to a manual checkout.

### Changed

- `android-testing` says that its two guard hooks stay registered for the rest of
  the session once the skill loads, as Claude Code now keeps skill hooks, and the
  hooks return at once on commands without `adb`.
- The `rule-auditor` agent starts without the user, project and local CLAUDE.md
  files (`omitClaudeMd`, Claude Code 2.1.271+), and reads the rule files it audits
  from disk.
- `security-auditor` and `system-architect` keep their memory per project
  (`memory: local`, in `.claude/agent-memory-local/`) instead of across every
  project, so notes about one codebase stay out of the others. Notes saved under
  `~/.claude/agent-memory/` no longer load.
- `/mastersoft:codex` says that `ultrathink` also asks Claude Code for deeper
  reasoning on that turn, and points to `--xhigh` for codex alone.
- `/mastersoft:glab` waits for a running pipeline with `glab ci status --wait` in
  the background instead of the blocking `--live` view.
- `/mastersoft:vet` says that it reviews what it is handed without running git,
  instead of claiming that it has no git access.
- `scripts/dev.sh` rewrites `mastersoft:` agent names to `mastersoft-dev:` in the
  copy it loads, so its skills start the copy's agents.
- Plugin hooks run in exec form, `node` with the script path in `args`, so the
  path reaches node as one argument with no shell quoting.

### Removed

- The `claude-md-large` signal for a root rules file over 100 lines.
  `rule-file-oversize` still fires past `claude_max_lines` and now names
  `/doctor`, which trims what Claude can derive from the codebase.

### Fixed

- The `android-testing` raw-screencap override reaches the hook: it goes in the
  `env` block of `.claude/settings.local.json`, which the running session applies
  on save, or in the environment `claude` starts with. An `export` in a Bash call
  never reached it.
- `android-testing` runs its scripts and flows without permission prompts in
  default mode: flows go as `--ops '<json>'` instead of a JSON heredoc, scripts
  run by their path, and the serial is written out, as each Bash call starts a
  new shell.
- `android-testing` Lane C stays within the Bash limits: the listener runs in the
  foreground under a 540 s timeout instead of a `wait` of up to 600 s, and the
  frame ring and the logcat tail run as background tasks stopped with `TaskStop`,
  instead of through PID variables lost between Bash calls. The listener's notes
  no longer mention the removed Monitor `persistent` option.
- `android-testing` batches accept `force_dump` on `snapshot`, as the flow
  reference documents: the batch validator rejected it with exit 64.
- `android-testing`'s `ui_run_flow.py` answers a flow that isn't a JSON object,
  such as a bare `[...]` list of ops, with the expected shape instead of a Python
  traceback.
- The `android-testing` wizard flow template runs as written: its notes moved out
  of the JSON, which neither the JSON nor the YAML parser accepted.
- The `ask-explore` agent searches with the Glob and Grep tools on macOS and Linux
  too: with Bash in its tool list Claude Code left them out there. It no longer
  has Bash, so its read-only contract holds. `/mastersoft:doc` names its search
  steps without the Glob tool.
- The `tech-writer` stage references no longer ask questions a subagent can't put
  to the user: they record assumptions and open questions instead, and the
  self-review stage states why it runs in one context.
- `/mastersoft:codex` waits for a background xhigh run with a background Bash loop
  instead of a Monitor watch, which expires after at most 30 minutes, and its
  troubleshooting notes say that a Bash timeout moves the call to the background
  instead of killing it.
- `/mastersoft:refresh-rules` applies nothing when a question closes on the
  auto-continue timeout, and lists the group as pending.
- Skills that pre-approve PowerShell scope it to the same commands as their Bash
  rules, such as `PowerShell(git *)`: a bare `PowerShell` approved every command
  on Windows. `/mastersoft:adversary` no longer pre-approves PowerShell, which it
  doesn't use.
- `/mastersoft:commit` works in a repository with no commits yet: `git diff HEAD`
  and `git log` failed there and aborted the skill before it loaded.
- `/mastersoft:sentry` reads the `.sentryclirc` token in the same Bash call as the
  API request, since an `export` doesn't reach the next call.
- `/mastersoft:ask`, `audit`, `adversary` and `help` no longer switch the session
  to their own model and effort for the rest of the turn: the model they meant is
  already set on the agent they start.
- Skills start their agents by the scoped `mastersoft:<agent>` name that Claude
  Code documents for plugin agents, so an agent of the same name from another
  plugin or from the user can't take their place.
- `/mastersoft:recall` runs as a `hindsight` fork that finishes in the same turn
  (`context: fork`, `background: false`): in an interactive session the agent it
  started ran in the background and reported in a later turn.
- `/mastersoft:verify` runs without permission prompts in default mode:
  `rule-auditor` runs git from the working directory, as Claude Code asks for
  approval on `cd <dir> && git` and `git -C <dir>`, and the findings describe JSON
  content in words, as the permission check refuses a heredoc with a `{` followed
  by a quote.
- The protected-branch push check stops waiting for git after 3 seconds and asks
  for confirmation: a git call that hung ran the hook into its timeout, and Claude
  Code runs the command when a PreToolUse hook times out.
- The protected-branch push check also covers the PowerShell tool, the only shell
  tool on Windows without Git Bash, including `Set-Location` before a push and a
  push inside `pwsh -Command`.
- Sessions forked with `--fork-session`, `/fork` or `/branch` get the org rules at
  start: Claude Code reports them as `fork` rather than `resume` since 2.1.214.

## [3.7.0] — 2026-09-25

### Changed

- `/mastersoft:init-rules` keeps project rules in `AGENTS.md`, which every coding
  agent reads. A repo with no rules gets them drafted by the native `/init`; a repo
  with only `CLAUDE.md` is offered a `git mv` to `AGENTS.md`. The `CLAUDE.md`
  pointer to `@AGENTS.md` is written only on request.
- `/mastersoft:init-rules` no longer suggests a `/schedule` routine for
  `/mastersoft:verify`: cloud routines don't load plugins.
- `/mastersoft:recall` lists every reason a session can be missing: pruning after
  `cleanupPeriodDays`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `--no-session-persistence`
  and `claude project purge`.

### Added

- `agents-md-shadowed` lint signal: an `AGENTS.md` that a `CLAUDE.md` file keeps
  from loading, with the two ways to load it.
- `/mastersoft:recall` warns when the newest transcripts have no records it can
  read, since the transcript format is internal to Claude Code and can change.

### Fixed

- `/mastersoft:help` prints the reference card in every permission mode instead
  of failing and searching the plugin cache for it.
- `/mastersoft:release`, `/mastersoft:sentry` and `/mastersoft:glab` load in
  default permission mode again: their context commands used `$(…)` and
  `{ …; }`, which the permission check refuses, so the skill aborted.
- `/mastersoft:recall` runs its session index without a permission prompt: the
  `hindsight` agent's `recall.js` calls are pre-approved.
- `/mastersoft:promote-patterns` resolves its paths with two plain `state.js`
  calls, which its `allowed-tools` pre-approve, instead of `$(…)` assignments
  that asked for permission.
- `/mastersoft:init-rules` renames `CLAUDE.md` to `AGENTS.md` without a permission
  prompt: Claude Code never pre-approves `mv` with flags, so the old `mv -n` rules
  never matched.
- `/mastersoft:verify` saves its findings and the verify time without permission
  prompts. In an interactive session the audit agent ran in the background and
  reported in a later turn, where the skill's `allowed-tools` no longer applied;
  verify now runs as a forked `rule-auditor` that waits in the invoking turn, and
  `write-findings` reads the finding blocks, since the permission check refuses
  JSON in a heredoc.
- The rule audit behind `/mastersoft:verify` and `/mastersoft:refresh-rules` no
  longer reports a missing `CLAUDE.md` pointer for an `AGENTS.md` that Claude Code
  loads on its own.
- `/mastersoft:recall` runs its session index again: the `hindsight` agent was
  calling `/scripts/recall.js` and fell back to reading transcripts by hand.
- `/mastersoft:doc` reads the type and title from the right arguments and finds
  its templates without a fallback.
- `/mastersoft:codex` — the background recipe keeps the log path when the skill
  is invoked with three or more arguments.
- Lint signals count `AGENTS.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` as
  project rules: `no-rules-file` no longer fires in a repo that has them, and the
  size, staleness and stale-reference checks also scan `AGENTS.md`. They follow
  the Project instructions setting and ignore `~/.claude/CLAUDE.md` at the home
  directory.
- Claude Code paths follow Claude Code's rules. Project slugs turn every
  non-alphanumeric character into `-`; the lint signals, `state.js`, the
  statusline and its wrapper honor `CLAUDE_CONFIG_DIR` and
  `CLAUDE_CODE_PLUGIN_CACHE_DIR`, and `install-statusline.sh --apply` patches the
  `settings.json` Claude Code reads; auto memory comes from `autoMemoryDirectory` or
  the main checkout's dir that every worktree shares. With auto memory off, the
  memory signals stay quiet and `/mastersoft:promote-patterns` says so.
- `/mastersoft:recall` finds sessions started in the repo's subdirectories and
  worktrees, for the current repo and for `--project`, which now also matches repo
  paths with spaces or other punctuation.
- `/mastersoft:recall` no longer lists set-aside `.orphaned-…` transcripts as extra
  sessions.
- A project path whose name is past 200 characters resolves to its hashed dir
  only when exactly one matches, instead of the first one found;
  `state.js claude-project-slug` prints that hashed name.
- Settings are read where Claude Code reads them: `.claude/settings.json` from the
  session's directory, `.claude/settings.local.json` from the repository root (the
  main checkout in a worktree), and managed settings (`remote-settings.json`,
  `managed-settings.json` and its drop-ins) first. The lint signals follow
  `managed-only` and rule files in parent directories, and say when the
  agents-md plugin is disabled; init-rules and the rule auditor read the same
  mode.
- `/mastersoft:recall` still counts a subdirectory whose first transcript has no
  working directory.
- Lint signals stay quiet in a session opened at the home directory, which is no
  project: its scan reported lockfiles and memory of unrelated folders there.

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
