---
name: glab
description: GitLab CLI (glab) for MRs, issues, labels, CI/CD pipelines, releases, and auth. Use proactively when the user asks to open an MR, file/triage an issue, drive a pipeline, or manage GitLab (not on your own initiative — these publish). For local git ops use commit/release.
model: sonnet
effort: medium
allowed-tools: Bash(glab:*), Bash(git:*), Bash(command:*), Read, Glob, Grep, AskUserQuestion
argument-hint: "[subcommand] [flags]"
---

# glab — GitLab Command-Line Interface

Run `glab` commands or explain usage. Route `$ARGUMENTS` to the appropriate operation.

## Context

- glab installed: !`command -v glab >/dev/null 2>&1 && echo "yes" || echo "MISSING"`
- Git remote: !`git remote get-url origin 2>/dev/null || echo "no remote"`
- Current branch: !`git branch --show-current 2>/dev/null || echo "not a repo"`
- glab auth status: !`{ glab auth status 2>&1 || echo "glab not configured"; } | head -5`

## Prerequisite Check

```bash
command -v glab >/dev/null 2>&1
```

If missing: `brew install glab` (macOS) or see https://gitlab.com/gitlab-org/cli for other platforms.

## Authentication Model

- glab stores credentials in `~/.config/glab-cli/config.yml` (or the OS keyring with `--use-keyring`).
- glab auto-resolves the target host from the git remote — **no per-command `--login` / `--hostname` flag needed** in the common case.
- Environment overrides (take precedence over stored config): `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN`.
- For self-managed multi-host setups, pass `--hostname <host>` on commands that need to target a non-default host (rare in practice).

## Skill Boundaries

- **Commits**: Always prefer the `commit` skill over glab for staging and committing. glab is for GitLab API operations (MRs, issues, labels, pipelines, releases), not for local git work.
- **Releases**: Use the `release` skill for versioning, changelogs, and tagging. The release skill itself shells out to `glab release create` to publish.
- **CI ops live here**, not in `commit` or `release`. Driving a pipeline, tracing a job, retrying a failed stage — all via this skill.
- **Non-interactive only**: glab falls back to interactive prompts when required flags are missing on `auth login`, `mr create`, `issue create`, `release create`, `mr note`, `issue note`. Claude Code runs in a non-interactive shell — **always pass all required flags explicitly** and use `--yes` to skip confirmation prompts where supported. Never invoke bare `glab auth login`, `glab mr create`, or `glab release create` without title/description/notes flags.

## Routing

1. **Help / explain** — Arguments contain "help", "-h", "how to", "explain", or "usage":
   - Run `glab [subcommand] -h` and present the output with practical guidance.
   - If no subcommand specified, run `glab -h`.
2. **Execute** — Arguments map to a glab subcommand:
   - Build the command, execute it, return output.
3. **API Fallback** — Operation not supported by a top-level glab subcommand (rare):
   - Use `glab api <endpoint>` — same stored auth, no token extraction needed.
4. **Workflow** — Arguments describe an intent ("create an MR", "merge !5", "what's wrong with my pipeline"):
   - Detect current context (branch, remote, auth status)
   - **Always ask for target branch** when creating MRs — never assume master/main
   - Translate intent into the correct `glab` invocation or API call
   - Confirm with user before executing publishing or destructive operations

## Command Reference

Full flag tables for every subcommand live in **`references/command-reference.md`**
(auth, MRs, issues, labels, CI/CD, releases, other entities, global flags). Load it
when you need exact flags; the routing, boundaries, and worked examples below cover
the common paths without it.

## Branch Detection & Selection

When creating an MR, **always ask the user for the target branch**. Never assume `master` or `main`.

### Detect Available Branches

```bash
git branch -r --sort=-committerdate | head -10
```

### Prompt User for Target

Use `AskUserQuestion`:

```
"Which branch should this MR target?"
Options: [main, dev, staging, Other (custom)]
```

If user says "to dev" or "against staging" in the initial request, use that branch directly.

## MR Description Guidelines

**Default: minimal body.** Title + commits already show *what* and *which files*. Do not assemble a multi-section AI-style description unless the user explicitly asks for one, or there is a non-obvious tradeoff a reviewer cannot infer from the diff.

### Principles

- **Title**: short, imperative, describes the outcome. Same conventions as commit subjects (`feat:`, `fix:`, etc.) — no scope.
- **Body**: default empty or 1-2 lines. Add sections **only** when:
  1. The user explicitly requested a detailed description.
  2. There is a non-obvious decision, tradeoff, or constraint a reviewer cannot infer from title + commits.
  3. There is a breaking change, migration step, or follow-up to flag.
- **Never** restate commit subjects, list changed files, or re-summarize the diff. The MR view already shows all of that.
- **Link issues** with `Closes #N` when relevant — that's worth one line on its own.
- **Omit empty sections.** A body with empty "Approach" / "Verification" / "Notes" headings is worse than no body.

### Title Examples

| Bad | Good |
|-----|------|
| `Update user.ts, auth.ts, and middleware.ts` | `feat: add session-based authentication` |
| `Fix bug` | `fix: prevent double-charge on retry` |
| `Changes for review` | `refactor: extract validation into shared module` |

### Worked Examples

User says: "Create an MR from my current branch" or "Open an MR".

1. **Check** — `glab auth status` (authenticated to the right host)
2. **Detect current branch** — `git branch --show-current`
3. **Ask for target branch** — User chooses (`main`, `dev`, `develop`, etc.). Never assume.
4. **Detect commits** — `git log <base>..HEAD --oneline`
5. **Labels** — `glab label list`; infer applicable labels from change scope
6. **Decide body**:
   - Default → `--fill` (title + body from commits, no extra prose) or `--description "1-2 lines"` if a single line of WHY helps.
   - Repo has `.gitlab/merge_request_templates/<name>.md` → `--template <name>` (the repo decided the structure, follow it).
   - User explicitly asked for a detailed description, or a real tradeoff needs flagging → build sections from `assets/pr-template.md`.
7. **Confirm** — Present target branch, title, body, and labels before creating
8. **Execute** — non-interactive `glab mr create`

**Default (most MRs) — auto-fill from commits, no extra prose:**

```bash
glab mr create --target-branch main --fill --yes
```

**One-line WHY when it adds something the commits don't:**

```bash
glab mr create --target-branch main \
  --title "feat: add session-based authentication" \
  --label "type/feature,topic/api" \
  --description "Server-side sessions for immediate token revocation on password change. Closes #42." \
  --yes
```

**Multi-section description — only on explicit user request or genuine tradeoff to flag:**

```bash
glab mr create --target-branch main \
  --title "refactor: switch session store from Postgres to Redis" \
  --label "type/refactoring,topic/api,pr/breaking" \
  --description "## Why
Per-request write amplification under load (see #87). Redis TTL matches existing JWT expiry (24h).

## Notes
Breaking: existing sessions invalidated on deploy — coordinate with mobile rollout." \
  --yes
```

If you reach for multi-section and it is **not** one of these two cases, default back to `--fill` or a one-liner.

## Issue Description Guidelines

Pick the template matching the issue type. If `.gitlab/issue_templates/<name>.md` exists in the repo, pass `--template <name>`; otherwise build the body from one of:

| Type | Template | Sections | Label |
|------|----------|----------|-------|
| **Bug** | `assets/issue-template-bug.md` | Description, Reproduction, Environment, Logs | `type/bug` |
| **Feature** | `assets/issue-template-feature.md` | Goal, Motivation, Proposed Approach, Acceptance Criteria | `type/feature` |
| **Task / Chore** | `assets/issue-template-task.md` | Goal, Scope | `type/enhancement` |
| **Proposal** | `assets/issue-template-proposal.md` | Problem, Options, Recommendation, Open Questions | `type/proposal` |

### Issue Title Convention

Plain-language descriptive (no `feat:`/`fix:` prefix — that's for MRs/commits).

| Bad | Good |
|-----|------|
| `fix: login broken` | `Login fails with 500 on expired OAuth token` |
| `feat: add geofence` | `Geofence event generation + GeoFenceState tracking` |
| `Bug` | `Ingest worker _reclaim_stale does not reprocess messages` |
| `Set up staging` | `Staging server setup (Supervisor configs)` |

### Worked Examples

**Bug:**

```bash
glab issue create \
  --title "GeoFenceStateFactory duplicate key on signal-created rows" \
  --label "type/bug,topic/api" \
  --description "## Description
Factory raises IntegrityError when a signal creates a row before the factory runs.

## Reproduction
1. Send AP10 signal for a new device
2. Call init_geofence_states management command
3. Observe: duplicate key error on geofence_state table

## Environment
- Branch: main@a1b2c3d
- Python 3.12 / Django 5.1" \
  --yes
```

**Feature:**

```bash
glab issue create \
  --title "Geofence event generation + GeoFenceState tracking" \
  --label "type/feature,topic/api" \
  --description "## Goal
Generate enter/exit events when device signals cross geofence boundaries.

## Motivation
Core requirement for the alarm feed — no geofence events means no alerts.

## Acceptance Criteria
- [ ] Entry/exit events persisted on boundary crossing
- [ ] GeoFenceState tracks current in/out per device-geofence pair" \
  --yes
```

### Principles

- **Never verbose.** One sentence per section is often enough.
- **Descriptive title.** Should tell a reader exactly what the issue is about without opening it.
- **Correct template.** Bug → reproduction + environment. Feature → goal + acceptance criteria. Task → goal + scope checklist. Proposal → problem + options.
- **Omit empty sections.**
- **Always apply labels.** Every issue gets at least a `type/` label. Add `topic/` labels when the affected area is clear.

## Label Awareness

### Standard label set

See `assets/labels.md` for the full reference. Labels follow `namespace/name` convention:

- **`type/`** — bug, feature, enhancement, proposal, docs, refactoring, testing
- **`issue/`** — confirmed, duplicate, needs-feedback, critical
- **`proposal/`** — accepted, rejected
- **`status/`** — blocked
- **`pr/`** — wip, breaking
- **`topic/`** — ui, api, mobile, security, deployment (extend per repo)

### Auto-assigning labels

1. **Check existing labels** — `glab label list` to see what's available in the repo.
2. **Match from context** — Infer applicable labels from title, description, and affected area.
3. **If no labels exist** — Propose creating the standard set from `assets/labels.md` and ask for approval before running `glab label create`.
4. **If labels exist but don't match the standard set** — Adapt to whatever the repo uses. Extrapolate from existing label names rather than forcing the standard set.
5. **Apply via flags** — `--label "type/bug,topic/api"` on create commands.

### Creating labels

```bash
glab label create --name "type/bug" --color "#ee0701" --description "Something is broken"
```

Always ask the user before bulk-creating labels on a repo.

## CI/CD Operations

See `references/ci.md` for the full playbook. Quick guidance:

- **Status check** — `glab ci status --live` (real-time) or `--compact` for one-shot summary.
- **Triage a failure** — `glab ci status` → identify failing job → `glab ci trace <job>` to read the log.
- **Lint** — `glab ci lint` before pushing changes to `.gitlab-ci.yml`. Safe, read-only.
- **Retry / cancel / delete** — **always confirm with the user before running.** These are destructive or publishing operations.
- **Trigger a manual job** — `glab ci trigger <job-name>` — confirm first.

## GitLab API Fallback

When a top-level glab subcommand doesn't expose what you need, drop to `glab api`. It uses the same stored auth — no manual token extraction needed.

### Path placeholders

These resolve from the current repo context:

| Placeholder | Resolves to |
|-------------|-------------|
| `:fullpath` | URL-encoded `group/subgroup/project` |
| `:id` | numeric project ID |
| `:branch` | current branch |
| `:user`, `:username` | authenticated user |
| `:namespace`, `:group`, `:repo` | parts of the project path |

### Common operations

**Edit an MR description:**

```bash
glab api --method PUT projects/:fullpath/merge_requests/<iid> \
  --field description="Updated body"
```

**Edit an issue title or body:**

```bash
glab api --method PUT projects/:fullpath/issues/<iid> \
  --field title="New title" --field description="New body"
```

**Bulk add labels to an issue:**

```bash
glab api --method PUT projects/:fullpath/issues/<iid> \
  --field add_labels="type/bug,topic/api"
```

**Paginated listing as NDJSON:**

```bash
glab api projects/:fullpath/issues --paginate --output ndjson \
  | jq 'select(.state == "opened")'
```

**GraphQL:**

```bash
glab api graphql -f query='
  query { project(fullPath: "group/subgroup/repo") { name, issuesEnabled } }
'
```

### `--field` vs `--raw-field`

- `--field key=value` — type-coerces booleans, numbers, `null` (`--field key:=null`).
- `--raw-field key=value` — always sends as string.

## Common Issues

### "not authenticated" / 401
**Cause:** Token expired, revoked, missing scopes, or wrong hostname for the current repo.
**Fix:** `glab auth status --all` to inspect; re-run `glab auth login --hostname <host> --token <new>` with `api` scope.

### MR or issue create hangs
**Cause:** A required text input was omitted, dropping glab into an editor or prompt.
**Fix:** Always pass `--title`, `--description` (string, not `-`), and `--yes`. Never use `--description -` from Claude Code.

### Merge "blocked"
**Cause:** Approval rules, code owners, or unresolved discussions blocking the MR.
**Fix:** `glab mr view <id>` and read the "Approval rules" / "Discussions" lines. Resolve discussions with `glab mr note resolve <discussion-id> <id>` (experimental) or via the UI.

### `glab mr merge` waits instead of merging immediately
**Cause:** `--auto-merge` defaults to `true` when a pipeline is running.
**Fix:** Pass `--auto-merge=false` to merge now (rare — usually you want it to wait).

### `glab api` returns "404 not found"
**Cause:** Wrong path encoding or placeholder. `:fullpath` does URL-encoding for you; literal `/` separators won't.
**Fix:** Use `:fullpath` in place of `group/subgroup/repo`, or URL-encode manually (`%2F` between segments).

### Multiple GitLab hosts
**Cause:** glab uses the host matching the current git remote. If you're not in a repo, it defaults to `gitlab.com`.
**Fix:** Pass `-R <host>/<group>/<project>` or `--hostname <host>` to target a specific instance.

## Additional Resources

- **`assets/pr-template.md`** — MR body (Context, Approach, Verification, Notes)
- **`assets/issue-template-bug.md`** — Bug report
- **`assets/issue-template-feature.md`** — Feature request
- **`assets/issue-template-task.md`** — Task / chore
- **`assets/issue-template-proposal.md`** — Proposal
- **`assets/labels.md`** — Standard label set (type/, issue/, proposal/, status/, pr/, topic/)
- **`assets/gitlab-repo-templates/`** — Drop-in templates a repo can commit to `.gitlab/merge_request_templates/` and `.gitlab/issue_templates/` for native `--template` support
- **`references/command-reference.md`** — full flag tables for every subcommand (auth, MRs, issues, labels, CI/CD, releases, global flags)
- **`references/workflows.md`** — MR review flow, approval rules, merge train, fork flow
- **`references/ci.md`** — Pipeline/job ops, trace, retry, lint
- **`references/testing.md`** — Troubleshooting, test protocols, success criteria

## Help

### Synopsis
Explain and execute GitLab CLI (glab) commands for managing MRs, issues, pipelines, releases, and authentication.

### Examples
- `glab -h` (show glab help)
- `glab mr list --state open` (list open MRs)
- `glab mr create --target-branch main --title "feat: my feature" --label "type/feature" --yes` (create MR)
- `glab mr create --fill --fill-commit-body --yes` (auto-fill from commits)
- `glab issue create --title "Login fails on expired token" --label "type/bug" --description "..." --yes`
- `glab ci status --live` (watch pipeline)
- `glab ci trace <job-name>` (stream failing job log)
- `glab release create v1.0.0 --notes-file CHANGELOG.md` (publish release)
- `glab auth login --hostname gitlab.example.org --token "$GITLAB_TOKEN"`

### Checklist
- Verify `glab` is installed and authenticated (`glab auth status`).
- **Always ask for target branch** when creating MRs — never assume master/main.
- Pass `--yes` (and explicit `--title` / `--description`) to avoid interactive prompts that hang.
- Prefer `--template <name>` if the repo has `.gitlab/merge_request_templates/` or `.gitlab/issue_templates/`.
- For operations not exposed by a subcommand, use `glab api` — no token extraction needed.
- Confirm destructive operations (merge, close, delete, cancel, retry) before executing.
- Return actionable output with links where available.

## Flags

- `--explain` Append rationale for the chosen command and flags
- `--dry-run` Show the command that would be executed without running it
