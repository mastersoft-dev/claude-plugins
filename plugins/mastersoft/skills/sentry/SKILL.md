---
name: sentry
description: Triage Sentry issues for this repo via sentry-cli — list unresolved errors, rank by impact, pull the latest event's stack trace, and propose repo-aware fixes. Self-hosted friendly (SENTRY_URL). Read-only by default; --fix gates resolve/mute behind confirmation. Use when the user wants to review Sentry errors, on schedule, or on demand. For deep single-issue root cause use investigate.
allowed-tools: Read, Grep, Glob, Bash(sentry-cli:*), Bash(curl:*), Bash(command:*), Bash(git:*), AskUserQuestion
argument-hint: "[query] [--limit N] [--org <slug>] [--project <slug>] [--fix]"
---

# Sentry

Triage the current repo's Sentry issues with `sentry-cli`, then use the model to
turn the top errors into repo-aware fix proposals. Read-only by default: it never
resolves or mutes an issue unless `--fix` is passed and confirmed.

## Tool reality (classic `sentry-cli`, `@sentry/cli`)

The classic binary the org uses (`sentry-cli`, subcommand `issues`) can **list**
and **mute/resolve/unresolve** — nothing else:

- `sentry-cli issues list -o <org> -p <project> --query "is:unresolved" --max-rows <N>`
  (also `--pages`, `--status`, `-i <id>`). **No `--json`, no `--sort`, no
  per-issue detail** — output is a table.
- `sentry-cli issues {resolve|mute|unresolve} -i <id> -o <org> -p <project>`.
- `sentry-cli info` — verifies auth and prints the resolved server URL + default
  org/project (token value is **not** printed).

There is **no stack-trace / issue-detail command** in this CLI (that lives only
in the newer unified `sentry` CLI). So the root-cause step pulls the latest
event via the Sentry **REST API** with `curl`, against the same host + token —
which works on self-hosted identically.

## Config resolution

`sentry-cli` resolves, in precedence order: CLI flags → `SENTRY_*` env
(`SENTRY_URL`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`) →
`.sentryclirc` (repo root, then `~/.sentryclirc`). Self-hosted **requires** the
host: `SENTRY_URL=https://sentry.example.com/` or `[defaults] url=` in
`.sentryclirc`.

## Context

- sentry-cli: !`command -v sentry-cli >/dev/null 2>&1 && sentry-cli --version || echo "MISSING"`
- repo `.sentryclirc`: !`test -f .sentryclirc && echo "present" || echo "absent (using env / ~/.sentryclirc)"`
- auth + resolved server/org/project: !`sentry-cli info 2>&1 | grep -vi token | head -12 || echo "not authenticated"`
- git remote: !`git remote get-url origin 2>/dev/null || echo "no remote"`

## Procedure

1. **Repo root** — `git rev-parse --show-toplevel`. Abort if not a git repo.

2. **Tool availability** — `command -v sentry-cli`. If missing, print a one-line
   install hint (`brew install getsentry/tools/sentry-cli`,
   `npm i -g @sentry/cli`, or `curl -sL https://sentry.io/get-cli/ | bash`) and stop.

3. **Config** — read the Context block. If `sentry-cli info` shows no valid auth
   or no default org/project, resolve org/project from `$ARGUMENTS`
   (`--org`/`--project`), else `AskUserQuestion` once, then suggest persisting
   them in the repo `.sentryclirc` `[defaults]` so it is not re-asked. On
   self-hosted, confirm the server URL is the on-prem host, not `sentry.io`.

4. **List** — build the query. Default `is:unresolved`; append any free-text
   `$ARGUMENTS` terms (Sentry search syntax; space-separated terms are ANDed).
   Respect `--limit N` via `--max-rows N` (default 15):
   ```
   sentry-cli issues list -o <org> -p <project> --query "is:unresolved <extra>" --max-rows <N>
   ```
   Parse the printed table rows (short-id, title/culprit, and the count/last-seen
   columns as rendered by the CLI).

5. **Rank + triage** — order by events × recency. Group near-duplicates by
   culprit. Flag **recently-surfaced** issues with the `firstSeen:` search
   property (e.g. add `firstSeen:-7d` to the query) so new problems stand out
   from long-standing noise.

6. **Diff-aware prioritization** — `git diff --name-only HEAD~10..HEAD` (and the
   working tree) to get recently-touched files; **surface issues whose culprit
   path matches code you just changed** first — that is the highest-signal set.

7. **Root cause (top-N, default 3)** — for each, pull the latest event's full
   payload (stack trace) via REST. Sentry documents this as "Retrieve Latest
   Event for Issue" (scope `event:read`):
   ```
   curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
     "$SENTRY_URL/api/0/issues/<id>/events/latest/"
   ```
   `$SENTRY_URL` is the on-prem host on self-hosted, `https://sentry.io` on SaaS.
   If an instance does not expose it, fall back to the org-scoped events list
   `/api/0/organizations/<org>/issues/<id>/events/` and take the first. Read the
   repo files at the top in-app frames, then state root cause + a concrete fix.
   For anything gnarly, hand off: `/mastersoft:investigate <issue>`.

8. **Output**:
   ```
   ## Sentry triage — <org>/<project> (<server>)

   | # | issue | events | last seen | culprit | new? |
   |---|-------|-------:|-----------|---------|------|
   ...
   (drop any column the CLI table / REST data doesn't actually provide)

   ## Proposed fixes (top N)
   1. <short-id> <title>
      - Root cause: <file:line> — <why>
      - Fix: <concrete change>
   ```

9. **`--fix` mode (optional)** — only after a fix is applied and the user
   confirms via `AskUserQuestion` (Apply / Skip), resolve or mute:
   ```
   sentry-cli issues resolve -i <id> -o <org> -p <project>
   ```
   Add `-n`/`--next-release` to mark it resolved in the next release, or use
   `sentry-cli issues mute -i <id> -o <org> -p <project>` instead. Never
   auto-resolve/mute without explicit confirmation — these are outward-facing
   mutations.

## Refusal cases

- Not a git repo → "Run inside a git repo."
- `sentry-cli` missing → print install hint and stop.
- No auth / no org+project resolvable → print what to set (`SENTRY_AUTH_TOKEN`,
  `SENTRY_URL` for self-hosted, `[defaults]` in `.sentryclirc`) and stop.

## Notes

- **Secrets**: never print the auth token or paste it into `.sentryclirc` in a
  committed file. Prefer `SENTRY_AUTH_TOKEN` in the environment; if
  `.sentryclirc` carries `[auth] token=`, ensure it is gitignored — warn if it
  is tracked. Redact tokens from any command output shown.
- **Least privilege**: a read-only triage needs a token with `event:read`,
  `project:read`, `org:read` only. `--fix` (resolve/mute) additionally needs
  `event:write` / `project:write` — request those only if the user wants `--fix`.
- **Self-hosted**: Seer and AI features are irrelevant here — this path is pure
  REST + CLI, no LLM-provider key needed.
