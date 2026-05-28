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
- glab auth status: !`glab auth status 2>&1 | head -5 || echo "glab not configured"`

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

### Authentication (`glab auth`)

#### `glab auth login`

Authenticate with a GitLab instance. Without flags, prompts interactively (unusable in Claude Code — always pass flags).

| Flag | Purpose |
|------|---------|
| `--hostname <host>` | Target GitLab host (e.g. `gitlab.com`, `gitlab.example.org`). Default: `gitlab.com`. |
| `--token <token>` | Personal access token (`glpat-...`). |
| `--stdin` | Read the token from stdin (use `glab auth login --hostname X --stdin < tokenfile`). |
| `--api-protocol <http\|https>` | API protocol. Default: `https`. |
| `--api-host <host[:port]>` | API host if it differs from `--hostname`. |
| `--git-protocol <ssh\|https>` | Protocol for git clone/push operations. |
| `--use-keyring` | Store token in the OS keyring instead of the config file. |
| `--web` | Browser-based OAuth flow. |
| `--device` | Headless OAuth device flow (GitLab 17.9+). |

```bash
# Non-interactive with a token
glab auth login --hostname gitlab.example.org --token "$GITLAB_TOKEN" \
  --api-protocol https --git-protocol ssh

# Token from a file
glab auth login --hostname gitlab.example.org --stdin < ~/secrets/glab-token
```

#### Other auth commands

| Command | Purpose |
|---------|---------|
| `glab auth status` | Show authenticated user and host (defaults to current context; `--all` for every configured host). |
| `glab auth logout [--hostname <host>]` | Remove stored credentials for a host. |

### Merge Requests (`glab mr`)

#### `glab mr list`

List merge requests. Default: open MRs in current repo.

| Flag | Purpose |
|------|---------|
| `--all` | Include closed and merged MRs |
| `--assignee <user>` | Filter by assignee (`@me` for self) |
| `--reviewer <user>` | Filter by reviewer (`@me` for self) |
| `--source-branch <branch>` | Filter by source branch |
| `--target-branch <branch>` | Filter by target branch |
| `--label <labels>` | Filter by label (comma-separated) |
| `--not-label <labels>` | Exclude these labels |
| `--draft` / `--not-draft` | Draft-only / non-draft only |
| `--search <text>` | Full-text search |
| `--per-page <n>` | Page size |

#### `glab mr create`

Create a merge request. **Drafts use a `Draft:` prefix in the title** (GitLab convention); set with `--draft` (or `--wip`).

| Flag | Purpose |
|------|---------|
| `-s, --source-branch <branch>` | Source branch (default: current) |
| `-b, --target-branch <branch>` | Target branch (default: repo default) |
| `-t, --title <title>` | MR title |
| `-d, --description <text>` | MR body (`-` opens editor — avoid in Claude Code) |
| `-f, --fill` | Auto-fill title and description from commit history; also pushes the branch |
| `--fill-commit-body` | Use each commit body when multiple commits (requires `--fill`) |
| `--draft` / `--wip` | Mark as draft |
| `--template <name>` | Pre-populate body from `.gitlab/merge_request_templates/<name>.md` in the repo (no `.md` needed) |
| `-l, --label <labels>` | Comma-separated label names |
| `-a, --assignee <users>` | Comma-separated usernames |
| `--reviewer <users>` | Comma-separated reviewer usernames |
| `-m, --milestone <name>` | Milestone (global ID or title) |
| `-i, --related-issue <iid>` | Associate with an issue; copies issue title if `--title` omitted |
| `--copy-issue-labels` | Copy labels from the related issue (requires `--related-issue`) |
| `--auto-merge` | Set MR to merge when pipeline and approval checks pass |
| `--squash-before-merge` | Squash on merge |
| `--remove-source-branch` | Remove source branch on merge |
| `--push` | Push committed changes before creating |
| `-y, --yes` | Skip submission confirmation prompt |
| `-w, --web` | Continue creation in browser |

`glab mr create --fill --yes` is the fastest non-interactive path when commits + branch name already describe the change.

#### `glab mr merge <id|branch>`

Merge an MR. **`--auto-merge` defaults to `true`** when a pipeline is currently running — pass `--auto-merge=false` to force immediate merge.

| Flag | Purpose |
|------|---------|
| `--auto-merge` | Wait for pipeline + approval checks before merging (default `true`) |
| `-s, --squash` | Squash commits on merge |
| `-r, --rebase` | Rebase source onto target before merging |
| `-d, --remove-source-branch` | Delete source branch after merge |
| `-m, --message <text>` | Custom merge commit message |
| `--squash-message <text>` | Custom squash commit message |
| `--sha <sha>` | Merge only if source HEAD matches this SHA (safety) |
| `-y, --yes` | Skip confirmation |

#### `glab mr approve <id|branch>`

Approve one or more MRs. No required reason. Respects project approval rules and code owners. Multiple IDs/branches can be passed as positional args.

| Flag | Purpose |
|------|---------|
| `-s, --sha <sha>` | Approve only if the MR's HEAD matches this SHA (safety — protects against approving a moving target). |

#### `glab mr revoke <id|branch>`

Withdraw your approval.

#### `glab mr update <id|branch>`

Edit MR title, description, labels, draft state.

| Flag | Purpose |
|------|---------|
| `-t, --title <text>` | New title |
| `-d, --description <text>` | New body |
| `--draft` / `--ready` | Toggle draft state |
| `-a, --assignee <users>` | Prefix `+` to add, `!`/`-` to remove, otherwise replace |
| `--reviewer <users>` | Same prefix rules |
| `-l, --label <labels>` | Add labels |
| `-u, --unlabel <labels>` | Remove labels |
| `-m, --milestone <name>` | Set milestone (empty string or `0` to unset) |
| `-f, --fill` | Refresh title/body from commits (requires `--yes`) |

#### Other MR commands

| Command | Purpose |
|---------|---------|
| `glab mr view <id|branch>` | Show MR details (`--web` to open in browser) |
| `glab mr diff <id|branch>` | Show MR diff |
| `glab mr checkout <id|branch|url>` | Check out the MR's source branch locally |
| `glab mr close <id|branch>` | Close without merging |
| `glab mr reopen <id|branch>` | Reopen a closed MR |
| `glab mr rebase <id|branch>` | Rebase source onto target |
| `glab mr note create <id|branch> -m "<text>"` | Comment on the MR (`-m` required; bare `glab mr note <id>` form is **deprecated** and exits with an error message pointing at the `create` subcommand) |

### Issues (`glab issue`)

#### `glab issue list`

List issues.

| Flag | Purpose |
|------|---------|
| `--all` | Include closed |
| `--assignee <user>` | Filter by assignee (`@me`) |
| `--author <user>` | Filter by author |
| `--label <labels>` | Filter by labels |
| `--not-label <labels>` | Exclude labels |
| `--milestone <name>` | Filter by milestone |
| `--search <text>` | Full-text search |
| `--confidential` | Confidential issues only |
| `--per-page <n>` | Page size |

#### `glab issue create`

Create an issue.

| Flag | Purpose |
|------|---------|
| `-t, --title <text>` | Issue title |
| `-d, --description <text>` | Issue body (`-` opens editor — avoid) |
| `-l, --label <labels>` | Comma-separated labels |
| `-a, --assignee <users>` | Comma-separated usernames |
| `-m, --milestone <name>` | Milestone |
| `--template <name>` | Pre-populate from `.gitlab/issue_templates/<name>.md` |
| `-c, --confidential` | Make issue confidential |
| `--due-date YYYY-MM-DD` | Due date |
| `--epic <id>` | Add to an epic |
| `--linked-mr <iid>` | MR that resolves this issue |
| `--linked-issues <iids>` | Related issue IIDs (comma-separated) |
| `-w, --weight <n>` | Issue weight (>= 0) |
| `-y, --yes` | Skip confirmation |

#### `glab issue update <id>`

Edit an issue. Same `-l/-u` label add/remove pattern as `mr update`.

| Flag | Purpose |
|------|---------|
| `-t, --title <text>` | New title |
| `-d, --description <text>` | New body |
| `-l, --label <labels>` | Add labels |
| `-u, --unlabel <labels>` | Remove labels |
| `-a, --assignee <users>` | Prefix `+`/`!`/`-` or replace |
| `--unassign` | Unassign all |
| `-m, --milestone <name>` | Empty string or `0` to unset |
| `--due-date YYYY-MM-DD` | Due date |
| `-c, --confidential` / `-p, --public` | Toggle confidentiality |
| `--lock-discussion` / `--unlock-discussion` | Lock state |
| `-w, --weight <n>` | Issue weight |

#### Other issue commands

| Command | Purpose |
|---------|---------|
| `glab issue view <id>` | Show details (`--web` for browser) |
| `glab issue close <id>` | Close |
| `glab issue reopen <id>` | Reopen |
| `glab issue note <id> --message "<text>"` | Comment (use `--message`; bare invocation opens editor) |
| `glab issue subscribe <id>` / `unsubscribe <id>` | Toggle subscription |
| `glab issue delete <id>` | Delete — **destructive, always confirm** |
| `glab issue board` | Issue boards |

### Labels (`glab label`)

| Command | Purpose |
|---------|---------|
| `glab label list` | List labels in current repo |
| `glab label create --name <n> --color <hex> --description <text>` | Create a label (`--color` defaults to `#428BCA`) |

GitLab labels do not enforce a namespace convention; this skill follows the `type/`, `topic/`, `issue/`, `status/`, `pr/`, `proposal/` scheme — see `assets/labels.md`.

### CI/CD (`glab ci`)

Driving GitLab CI/CD pipelines and jobs. See `references/ci.md` for the full playbook.

| Command | Purpose | Safety |
|---------|---------|--------|
| `glab ci status [--live] [--compact]` | Pipeline status for current branch; `--live` for streaming | safe |
| `glab ci list [--status running\|failed\|...]` | List recent pipelines | safe |
| `glab ci get [--pipeline-id <id>]` | Pipeline details | safe |
| `glab ci view [<branch\|tag>]` | Interactive TUI — **only suitable when user has a terminal**; do not invoke from automated workflows | interactive |
| `glab ci trace [<job-id\|job-name>]` | Stream job log in real time | safe (read-only) |
| `glab ci lint` | Validate `.gitlab-ci.yml` | safe |
| `glab ci config compile [<path>]` | Show the fully merged `.gitlab-ci.yml` (with all `include:` directives resolved) | safe |
| `glab ci run [-b <branch>] [--variables KEY:val,...] [--variables-env K:v] [--variables-file K:path] [--variables-from <json>] [-i KEY:val]` | Trigger a new pipeline — **confirm before running**. Variable flags are mutually exclusive with `--mr`. Pipeline inputs (`-i/--input`) use typed `key:type(value)` syntax. | publishing |
| `glab ci retry [<job-id\|job-name>]` | Retry a failed job — **confirm first** | publishing |
| `glab ci trigger [<job-id\|job-name>]` | Trigger a manual job — **confirm first** | publishing |
| `glab ci cancel pipeline <id>...` / `glab ci cancel job <id>...` | Cancel running pipelines or jobs — subcommand required (bare `glab ci cancel` is interactive). **Always confirm** | destructive |
| `glab ci delete <id>` | Delete a pipeline — **always confirm** | destructive |
| `glab job artifact <ref> <job> [-p <path>]` | Download artifacts from the last pipeline (`glab ci artifact` exists as a deprecated alias — prefer `glab job artifact`) | safe |

### Releases (`glab release`)

#### `glab release create <tag> [files...]`

Create or update a GitLab release. **`<tag>` is positional**, not a flag.

| Flag | Purpose |
|------|---------|
| `-n, --name <text>` | Release name/title (defaults to tag) |
| `-N, --notes <text>` | Release notes (Markdown) |
| `-F, --notes-file <path>` | Read notes from a file (`-` for stdin) |
| `-r, --ref <ref>` | Commit SHA, tag, or branch to release from if `<tag>` doesn't exist yet |
| `-T, --tag-message <text>` | Annotated-tag message when creating a new tag |
| `-m, --milestone <names>` | Associated milestones (comma-separated) |
| `--no-close-milestone` | Don't close milestones after release |
| `--no-update` | Fail if release already exists (don't update silently) |
| `-D, --released-at <iso8601>` | Released timestamp (set to a future date for "scheduled" semantics) |
| `-a, --assets-links <json>` | Asset links as JSON string |
| `--use-package-registry` | Upload assets to the project's generic package registry |
| `--package-name <name>` | Package name when using `--use-package-registry` (default `release-assets`) |

Positional `[files...]` accept `path#displayname` to upload assets with a display label.

```bash
glab release create v1.6.0 --name "v1.6.0" --notes-file CHANGELOG-1.6.0.md
glab release create v1.6.0 dist/binary.zip#"Binary release"
```

> GitLab releases do not have a draft state. Setting `--released-at` to a future ISO 8601 timestamp creates an **Upcoming Release**: GitLab displays an "Upcoming Release" badge next to the tag and removes the badge automatically once the date passes (per GitLab's release docs).

#### Other release commands

| Command | Purpose |
|---------|---------|
| `glab release list` | List releases |
| `glab release view <tag>` | Show release details |
| `glab release upload <tag> <file> [<file>...]` | Upload additional assets |
| `glab release delete <tag>` | Delete a release — **always confirm** |
| `glab release download <tag> --asset-name <name>` | Download release assets |

### Other Entities

| Command | Purpose |
|---------|---------|
| `glab repo view [<owner/repo>]` | Show repo details |
| `glab repo clone <owner/repo>` | Clone via configured git protocol |
| `glab repo fork [<owner/repo>]` | Fork a project |
| `glab milestone list` | List milestones |
| `glab snippet create -t <title> <file>...` | Create a snippet (only `create` is exposed by glab; for list/view/delete drop to `glab api snippets`) |
| `glab variable list` / `set <key> <value>` / `update <key> <value>` / `delete <key>` | CI/CD variables (value also accepted via `-v`, or piped on stdin). `-m --masked`, `-p --protected`, `--hidden`, `-s --scope`, `-t --type` available. **Confirm before set/update/delete** — these are production config. |
| `glab token` | Personal / project / group token management — **destructive when revoking** |
| `glab schedule list` | CI/CD schedules |

### Global Flags

Available on most subcommands:

| Flag | Purpose |
|------|---------|
| `-R, --repo <OWNER/REPO\|GROUP/NS/REPO\|URL>` | Override repository context |
| `--hostname <host>` | Override host (rare; auto-resolved from git remote) |
| `-F` / `-O, --output <format>` | Output format. List commands: `text` or `json` only (no `yaml` / `ndjson`). `glab api` additionally supports `ndjson` with `--paginate`. Short-flag varies: `mr list`/`ci status` use `-F`; `issue list` uses `-O` (`-F` there is the unrelated `--output-format details\|ids\|urls`). |
| `--per-page <n>` | Page size |
| `--paginate` | Fetch all pages |

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

When creating an MR, prefer a repo-committed template at `.gitlab/merge_request_templates/<name>.md` (pass `--template <name>`). If absent, build the body from `assets/pr-template.md`.

### Principles

- **Concise over verbose.** Every sentence must earn its place.
- **Title**: Short, imperative, describes the outcome — not the implementation. Same conventions as commit summaries (`feat:`, `fix:`, etc.) but scoped to the whole MR.
- **Body focuses on the "why"**: commits already explain *what* changed and in *which files*. The MR body adds motivation, trade-offs, and reviewer guidance.
- **Never repeat commit messages** or list files changed.
- **Link to issues** with GitLab autoclose syntax: `Closes #42`.
- **Omit empty sections.**

### Title Examples

| Bad | Good |
|-----|------|
| `Update user.ts, auth.ts, and middleware.ts` | `feat: add session-based authentication` |
| `Fix bug` | `fix: prevent double-charge on retry` |
| `Changes for review` | `refactor: extract validation into shared module` |

### Body Structure

Follow `assets/pr-template.md`:

1. **Context** — Why does this change exist? Link issue if applicable.
2. **Approach** — Why this solution? Key decisions and trade-offs. Skip if obvious.
3. **Verification** — How was it tested? Specific enough to reproduce.
4. **Notes** — Reviewer attention points, uncertainties, follow-ups, breaking changes. Omit if nothing to flag.

### Worked Example

User says: "Create an MR from my current branch" or "Open an MR".

1. **Check** — `glab auth status` (authenticated to the right host)
2. **Detect current branch** — `git branch --show-current`
3. **Ask for target branch** — User chooses (`main`, `dev`, `develop`, etc.). Never assume.
4. **Detect commits** — `git log <base>..HEAD --oneline`
5. **Labels** — `glab label list`; infer applicable labels from change scope
6. **Template check** — If `.gitlab/merge_request_templates/` exists in repo, prefer `--template <name>`; otherwise build body from `assets/pr-template.md`
7. **Draft** — Title from overall intent; body focuses on why
8. **Confirm** — Present target branch, title, body, and labels before creating
9. **Execute** — non-interactive `glab mr create`

**Feature MR:**

```bash
glab mr create --target-branch main --source-branch feat/session-auth \
  --title "feat: add session-based authentication" \
  --label "type/feature,topic/api" \
  --description "## Context
Server-side sessions for immediate token revocation on password change. Closes #42.

## Approach
Redis-backed over DB to avoid write amplification per request. TTL matches existing JWT expiry (24h).

## Verification
- [x] Auth test suite passes
- [x] Added integration test for revocation flow" \
  --yes
```

**Bug-fix MR:**

```bash
glab mr create --target-branch main --source-branch fix/duplicate-key \
  --title "fix: GeoFenceStateFactory duplicate key on signal-created rows" \
  --label "type/bug,topic/api" \
  --description "## Context
Factory raises IntegrityError when a signal creates a GeoFenceState row before the management command runs. Closes #41.

## Approach
Switch to get_or_create with a unique constraint check instead of bulk_create.

## Verification
- [x] Reproduced with concurrent signal + management command
- [x] No IntegrityError after fix" \
  --yes
```

**Fast path — auto-fill from commits:**

```bash
glab mr create --target-branch main --fill --fill-commit-body \
  --label "type/refactoring" --yes
```

Use only when the latest commit subject + bodies already form a coherent MR description.

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
**Fix:** `glab mr view <id>` and read the "Approval rules" / "Discussions" lines. Resolve discussions with `glab mr note resolve` (experimental) or via the UI.

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
