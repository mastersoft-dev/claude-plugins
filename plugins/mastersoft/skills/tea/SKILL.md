---
name: tea
description: Gitea/Forgejo CLI (tea) for PRs, issues, labels, repos, and auth. Use proactively when the user asks to open a PR, file/triage an issue, or manage Gitea (not on your own initiative — these publish). For local git ops use commit/release.
model: sonnet
effort: medium
allowed-tools: Bash(tea:*), Bash(git:*), Bash(command:*), Read, Glob, Grep, AskUserQuestion
argument-hint: "[subcommand] [flags]"
---

# Tea CLI — Gitea/Forgejo Command-Line Interface

Run `tea` commands or explain usage. Route `$ARGUMENTS` to the appropriate operation.

## Context

- Tea installed: !`command -v tea >/dev/null 2>&1 && echo "yes" || echo "MISSING"`
- Git remote: !`git remote get-url origin 2>/dev/null || echo "no remote"`
- Current branch: !`git branch --show-current 2>/dev/null || echo "not a repo"`
- Tea logins: !`tea login list 2>/dev/null || echo "tea not configured"`

## Prerequisite Check

```bash
command -v tea >/dev/null 2>&1
```

If missing: install from https://gitea.com/gitea/tea/releases or `brew install tea`.

## Login Resolution

Tea's default login may not match the current repo's remote. When the default login host differs from the git remote host, tea attempts an interactive prompt — which **hangs in Claude Code's non-interactive shell**.

**Always resolve the correct login before running entity commands:**

1. Parse git remote: `git remote get-url origin` → extract hostname
2. Match against `tea login list` → find the login whose URL matches the remote host
3. Pass `--login <name>` explicitly on **all** entity subcommands (`issue`, `pr`, `label`, `comment`, etc.)

**Exception:** `tea whoami` does **not** accept `--login`. It always uses the default login. To verify auth for a non-default login, use `tea login list` and check the entry exists.

**Example resolution:**
```
Remote: git@git.example.com:myorg/myrepo.git → host = git.example.com
Login list shows: git.example.com (URL: https://git.example.com)
→ Use --login git.example.com on all commands
```

## Skill Boundaries

- **Commits**: Always prefer the `commit` skill over tea for staging and committing. Tea is for Gitea API operations (PRs, issues, labels, etc.), not for local git work.
- **Releases**: Use the `release` skill for versioning, changelogs, and tagging.
- **Non-interactive only**: Tea falls back to interactive prompts when required flags are missing (`tea login add`, `tea issue create`, `tea pr create`, `tea comment`, `tea pr review`). Claude Code runs in a non-interactive shell — **always pass all required flags explicitly** to avoid hanging on stdin. Never invoke bare `tea login add`, `tea issue create`, or `tea pr create` without `--title`, `--description`, etc.

## Routing

1. **Help / explain** — Arguments contain "help", "-h", "how to", "explain", or "usage":
   - Run `tea [subcommand] -h` and present the output with practical guidance.
   - If no subcommand specified, run `tea -h`.
2. **Execute** — Arguments map to a tea subcommand:
   - Build the command, execute it, return output.
3. **API Fallback** — Operation not supported by tea CLI (e.g., edit PR/issue):
   - Use Gitea API directly with token from the tea config file (path varies by OS — see "Configuration File" section below).
4. **Workflow** — Arguments describe an intent ("create a PR", "merge PR #5"):
   - Detect current context (branch, remote, login)
   - **Always ask for target branch** when creating PRs — never assume master/main
   - Translate intent into the correct `tea` invocation or API call
   - Confirm with user before executing

## Command Reference

### Setup & Authentication

#### `tea login add`

Add a Gitea login. Without flags, runs interactively (unusable in Claude Code — always pass flags).

| Flag | Purpose |
|------|---------|
| `--name, -n <name>` | Login identifier |
| `--url, -u <url>` | Server URL (default: `https://gitea.com`). Env: `$GITEA_SERVER_URL` |
| `--token, -t <token>` | Access token (from Settings > Applications). Env: `$GITEA_SERVER_TOKEN` |
| `--user <user>` | Username for basic auth (auto-creates token). Env: `$GITEA_SERVER_USER` |
| `--password, --pwd <pass>` | Password for basic auth. Env: `$GITEA_SERVER_PASSWORD` |
| `--otp <code>` | OTP token if 2FA is enabled. Env: `$GITEA_SERVER_OTP` |
| `--scopes <scopes>` | Comma-separated token scopes. Env: `$GITEA_SCOPES` |
| `--ssh-key, -s <path>` | SSH key path (overrides auto-discovery) |
| `--oauth, -o` | Use interactive OAuth2 flow |
| `--insecure, -i` | Disable TLS verification |

#### Other login commands

| Command | Purpose |
|---------|---------|
| `tea login list` | List configured logins |
| `tea login default [name]` | Get or set the default login |
| `tea login delete <name>` | Remove a login |
| `tea whoami` | Show current authenticated user |

### Pull Requests (`tea pr`)

#### `tea pr list`

List PRs. Default: open PRs in current repo.

| Flag | Purpose |
|------|---------|
| `--state <state>` | Filter: `all\|open\|closed` (default: open) |
| `--fields, -f <fields>` | Comma-separated fields: `index,state,author,author-id,url,title,body,mergeable,base,base-commit,head,diff,patch,created,updated,deadline,assignees,milestone,labels,comments` |

#### `tea pr create`

Create a pull request in the current repo. Draft PRs are defined by adding either `WIP:` or `[WIP]` before the name. `[WIP]` is the preferred formula.

| Flag | Purpose |
|------|---------|
| `--head <branch>` | Source branch (default: current). Cross-repo: `<user>:<branch>` |
| `--base, -b <branch>` | Target branch (default: repo default) |
| `--title, -t <title>` | PR title |
| `--description, -d <text>` | PR body |
| `--assignees, -a <users>` | Comma-separated usernames |
| `--labels, -L <labels>` | Comma-separated label names |
| `--milestone, -m <name>` | Milestone to assign |
| `--deadline, -D <timestamp>` | Deadline |
| `--allow-maintainer-edits` | Allow maintainers to push to head (default: true) |

#### `tea pr merge <index>`

Merge a pull request.

| Flag | Purpose |
|------|---------|
| `--style, -s <style>` | `merge\|rebase\|squash\|rebase-merge` (default: merge) |
| `--title, -t <text>` | Merge commit title |
| `--message, -m <text>` | Merge commit message |

#### `tea pr checkout <index>`

Locally checkout a PR branch.

| Flag | Purpose |
|------|---------|
| `--branch, -b` | Create a local branch if it doesn't exist yet |

#### `tea pr approve <index> [comment]`

Approve a PR. Optional comment as positional argument.

#### `tea pr reject <index> <reason>`

Request changes. Reason is **required** as positional argument.

#### `tea pr review <index>`

Interactive review — **unusable in Claude Code**. Use `tea pr approve` or `tea pr reject` instead.

#### `tea pr clean <index>`

Delete local & remote feature branches for a closed/merged PR.

| Flag | Purpose |
|------|---------|
| `--ignore-sha` | Find local branch by name instead of commit hash |

#### Other PR commands

| Command | Purpose |
|---------|---------|
| `tea pr <index>` | Show PR details |
| `tea pr close <index>` | Close without merging |
| `tea pr reopen <index>` | Reopen a closed PR |

### Issues (`tea issue`)

#### `tea issue list`

List issues. Default: open issues in current repo.

| Flag | Purpose |
|------|---------|
| `--state <state>` | Filter: `all\|open\|closed` (default: open) |
| `--kind, -K <kind>` | Return `issues`, `pulls`, or `all` (default: issues) |
| `--keyword, -k <text>` | Search string filter |
| `--labels, -L <labels>` | Comma-separated label filter |
| `--milestones, -m <names>` | Comma-separated milestone filter |
| `--author, -A <user>` | Filter by author |
| `--assignee, -a <user>` | Filter by assignee |
| `--mentions, -M <user>` | Filter by mentioned user |
| `--owner, --org <owner>` | Filter by owner/org |
| `--from, -F <date>` | Activity after this date |
| `--until, -u <date>` | Activity before this date |
| `--fields, -f <fields>` | Comma-separated fields: `index,state,kind,author,author-id,url,title,body,created,updated,deadline,assignees,milestone,labels,comments,owner,repo` |

#### `tea issue create`

Create an issue.

| Flag | Purpose |
|------|---------|
| `--title, -t <title>` | Issue title |
| `--description, -d <text>` | Issue body |
| `--assignees, -a <users>` | Comma-separated usernames |
| `--labels, -L <labels>` | Comma-separated label names |
| `--milestone, -m <name>` | Milestone to assign |
| `--deadline, -D <timestamp>` | Deadline |

#### `tea issue edit <index> [<index>...]`

Edit one or more issues. Use empty string to unset a property (e.g., `--milestone ""`).

| Flag | Purpose |
|------|---------|
| `--title, -t <title>` | New title |
| `--description, -d <text>` | New body |
| `--add-assignees, -a <users>` | Usernames to add |
| `--add-labels, -L <labels>` | Labels to add (takes precedence over `--remove-labels`) |
| `--remove-labels <labels>` | Labels to remove |
| `--milestone, -m <name>` | Milestone to assign |
| `--deadline, -D <timestamp>` | Deadline |

#### Other issue commands

| Command | Purpose |
|---------|---------|
| `tea issue <index>` | Show issue details |
| `tea issue close <index>` | Close an issue |
| `tea issue reopen <index>` | Reopen an issue |

### Other Entities

#### `tea comment <index> [body]`

Add a comment to an issue or PR. Always pass body as positional argument (interactive prompt unusable in Claude Code).

| Command | Purpose |
|---------|---------|
| `tea repo` | Show current repo details |
| `tea repos list` | List repositories |
| `tea branch list` | List branches |
| `tea label list` | List labels |
| `tea milestone list` | List milestones |
| `tea release list` | List releases |
| `tea notification list` | Show notifications |
| `tea open` | Open current repo in browser |

### Global Flags

These flags are available on most subcommands:

| Flag | Purpose |
|------|---------|
| `--login, -l <name>` | Use a specific Gitea login |
| `--repo, -r <owner/repo>` | Override repository context |
| `--remote, -R <name>` | Discover login from git remote |
| `--output, -o <format>` | Output format: `simple\|table\|csv\|tsv\|yaml\|json` |
| `--page, -p <n>` | Page number (default: 1) |
| `--limit, --lm <n>` | Items per page (default: 30) |
| `--debug, --vvv` | Enable debug mode |

## Authentication Guide

### Where to Find Your Token

1. Log in to your Gitea/Forgejo web instance
2. Go to **Settings** → **Applications** (URL: `<instance>/user/settings/applications`)
3. Under **Manage Access Tokens**, enter a token name
4. Select scopes (at minimum: `repo` for PR/issue operations)
5. Click **Generate Token** — copy it immediately (shown only once)

### Adding a Login

```bash
# Interactive (recommended for first setup)
tea login add

# Direct with token
tea login add --name=myinstance --url=https://gitea.example.com --token=<TOKEN>

# Via basic auth (auto-creates a token)
tea login add --name=myinstance --url=https://gitea.example.com --user=myuser --password=mypass
```

### Configuration File

Path varies by OS. The config stores login entries with their tokens under a `logins:` list:

- **macOS** — `~/Library/Application Support/tea/config.yml` (NOT under `~/.config/`; tea uses the native macOS app-support convention)
- **Linux / BSD** — `$XDG_CONFIG_HOME/tea/config.yml` (typically `~/.config/tea/config.yml`)
- **Windows** — `%APPDATA%\tea\config.yml`

**Extracting the token for API fallback** (resolves the config path on macOS, Linux/BSD, and Windows — env-aware via `APPDATA` / `XDG_CONFIG_HOME`):

```bash
python3 -c "
import yaml, os
cfg = next((p for p in (
    os.path.join(os.environ.get('APPDATA',''), 'tea', 'config.yml'),                                      # Windows
    os.path.expanduser('~/Library/Application Support/tea/config.yml'),                                     # macOS
    os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'tea', 'config.yml') # Linux/BSD
) if p and os.path.exists(p)), None)
with open(cfg) as f: c = yaml.safe_load(f)
print(next((l.get('token','') for l in c.get('logins', []) if 'your-host.example.com' in l.get('url','')), ''))
"
```

Do NOT grep the config file with naive regex — YAML nested structure + token values with special characters break that.

If the path isn't obvious, run `tea login list` to see configured logins, then find the file via `find ~ -path "*/tea/config.yml" 2>/dev/null`.

### Verifying Auth

```bash
tea whoami            # Show current user
tea login list        # List all configured logins
```

## Branch Detection & Selection

When creating a PR, **always ask the user for the target branch**. Never assume `master` or `main`.

### Detect Available Branches

```bash
# List remote branches (sorted by recent activity)
git branch -r --sort=-committerdate | head -10

# Common patterns: master, main, dev, develop, staging, release/*
```

### Prompt User for Target

Use `AskUserQuestion` to let user choose from common branches or specify custom:

```
"Which branch should this PR target?"
Options: [main, dev, staging, Other (custom)]
```

If user says "to dev" or "against staging" in the initial request, use that branch directly.

## PR Description Guidelines

When creating a PR via `tea pr create`, use the template in `assets/pr-template.md`.

### Principles

- **Concise over verbose.** Every sentence must earn its place. If a section adds no insight beyond what the diff and commits already show, drop it.
- **Title**: Short, imperative, describes the outcome — not the implementation. Same conventions as commit summaries (`feat:`, `fix:`, etc.) but scoped to the whole PR.
- **Body focuses on the "why"**: Commits already explain *what* changed and in *which files*. The PR description adds context that commits cannot: the motivation, the trade-offs, and reviewer guidance.
- **Never repeat commit messages** or list files changed — that's noise. The diff is self-explanatory.
- **Link to issues/tickets** when they exist (`Closes #42`).
- **Omit empty sections** — if there's nothing noteworthy for "Notes", drop it entirely.

### Title Examples

| Bad | Good |
|-----|------|
| `Update user.ts, auth.ts, and middleware.ts` | `feat: add session-based authentication` |
| `Fix bug` | `fix: prevent double-charge on retry` |
| `Changes for review` | `refactor: extract validation into shared module` |

### Body Anti-Patterns

| Anti-pattern | Why it's bad |
|--------------|-------------|
| "Changed `login()` in `auth.ts` to accept a token" | Restates the diff — reviewer already sees this |
| Bullet list of every file touched | Adds no insight beyond `git diff --stat` |
| Copy-pasting all commit messages | Duplicates what's already in the commit log |
| Empty body / "See commits" | Misses the opportunity to explain *why* |

### Body Structure

Follow `assets/pr-template.md`:

1. **Context** — Why does this change exist? Problem, user need, or business goal. Link issue if applicable.
2. **Approach** — Why this solution? Key decisions and trade-offs. Skip if obvious.
3. **Verification** — How was it tested? Be specific enough to reproduce.
4. **Notes** — Reviewer attention points, uncertainties, follow-ups, breaking changes. Omit if nothing to flag.

### Worked Example

User says: "Create a PR from my current branch" or "Open a PR"

1. **Check** — `tea login list` (installed + authenticated)
2. **Resolve login** — Match git remote host to a tea login entry
3. **Detect current branch** — `git branch --show-current`
4. **Ask for target branch** — User chooses base branch (master, main, dev, develop, etc.). Never assume.
5. **Detect commits** — `git log <base>..HEAD --oneline`
6. **Labels** — `tea label list --login <name>`; infer applicable labels from change scope
7. **Draft** — Title from overall intent; body from template, focusing on why
8. **Confirm** — Present target branch, title, body, and labels to user before creating
9. **Execute** — `tea pr create --login <name> --base <chosen-base> --head <branch> --title "<title>" --description "<body>" --labels "<labels>"`

**Note**: All examples use `--base main` for illustration. In practice, **always ask the user** which branch to target (see "Branch Detection & Selection").

**Feature PR:**

```bash
tea pr create --base main --head feat/session-auth \
  --title "feat: add session-based authentication" \
  --labels "type/feature,topic/api" \
  --description "## Context
Server-side sessions for immediate token revocation on password change. Closes #42.

## Approach
Redis-backed over DB to avoid write amplification per request. TTL matches existing JWT expiry (24h).

## Verification
- [x] Auth test suite passes
- [x] Added integration test for revocation flow"
```

**Bug fix PR:**

```bash
tea pr create --base main --head fix/duplicate-key \
  --title "fix: GeoFenceStateFactory duplicate key on signal-created rows" \
  --labels "type/bug,topic/api" \
  --description "## Context
Factory raises IntegrityError when a signal creates a GeoFenceState row before the management command runs. Closes #41.

## Approach
Switch to get_or_create with a unique constraint check instead of bulk_create.

## Verification
- [x] Reproduced with concurrent signal + management command
- [x] No IntegrityError after fix"
```

**Refactor PR:**

```bash
tea pr create --base main --head refactor/ingest-dispatch \
  --title "refactor: harden geofence and telemetry dispatch in ingest worker" \
  --labels "type/refactoring,topic/api" \
  --description "## Context
Ingest worker silently drops signals when geofence check raises. Needs isolation per dispatch target.

## Verification
- [x] Existing ingest test suite passes
- [x] Manually verified fault injection on geofence dispatch"
```

**Docs PR:**

```bash
tea pr create --base main --head docs/pep758 \
  --title "docs: record PEP 758 except syntax as runtime decision" \
  --labels "type/docs" \
  --description "## Context
Team decided to adopt PEP 758 except* syntax. Recording the decision for future reference."
```

## Issue Description Guidelines

When creating an issue via `tea issue create`, pick the template matching the issue type.

### Template Selection

| Type | Template | Sections | Label |
|------|----------|----------|-------|
| **Bug** | `assets/issue-template-bug.md` | Description, Reproduction, Environment, Logs | `type/bug` |
| **Feature** | `assets/issue-template-feature.md` | Goal, Motivation, Proposed Approach, Acceptance Criteria | `type/feature` |
| **Task / Chore** | `assets/issue-template-task.md` | Goal, Scope | `type/enhancement` |
| **Proposal** | `assets/issue-template-proposal.md` | Problem, Options, Recommendation, Open Questions | `type/proposal` |

### Issue Title Convention

Issue titles are **plain-language descriptive** (no `feat:`/`fix:` prefix — that's for PRs/commits).

| Bad | Good |
|-----|------|
| `fix: login broken` | `Login fails with 500 on expired OAuth token` |
| `feat: add geofence` | `Geofence event generation + GeoFenceState tracking` |
| `Bug` | `Ingest worker _reclaim_stale does not reprocess messages` |
| `Set up staging` | `Staging server setup (Supervisor configs)` |

### Worked Examples

**Bug:**

```bash
tea issue create \
  --title "GeoFenceStateFactory duplicate key on signal-created rows" \
  --labels "type/bug,topic/api" \
  --description "## Description
Factory raises IntegrityError when a signal creates a row before the factory runs.

## Reproduction
1. Send AP10 signal for a new device
2. Call init_geofence_states management command
3. Observe: duplicate key error on geofence_state table

## Environment
- Branch: main@a1b2c3d
- Python 3.12 / Django 5.1"
```

**Feature:**

```bash
tea issue create \
  --title "Geofence event generation + GeoFenceState tracking" \
  --labels "type/feature,topic/api" \
  --description "## Goal
Generate enter/exit events when device signals cross geofence boundaries.

## Motivation
Core requirement for the alarm feed — no geofence events means no alerts.

## Acceptance Criteria
- [ ] Entry/exit events persisted on boundary crossing
- [ ] GeoFenceState tracks current in/out per device-geofence pair"
```

**Task / Chore:**

```bash
tea issue create \
  --title "Staging server setup (Supervisor configs)" \
  --labels "type/enhancement,topic/deployment" \
  --description "## Goal
Configure Supervisor processes for ingest worker, web, and beat on staging.

## Scope
- [ ] Supervisor conf for each service
- [ ] Env file with staging credentials
- [ ] Smoke test after deploy"
```

**Proposal:**

```bash
tea issue create \
  --title "Geofence dispatch delivery guarantee (post-MVP)" \
  --labels "type/proposal" \
  --description "## Problem
Ingest worker fires geofence checks synchronously; dropped signals lose events.

## Options
1. **Celery task per signal** — simple, retryable, adds Redis dependency
2. **Transactional outbox** — no new deps, more complex, guaranteed delivery

## Recommendation
Option 2. We already have PostgreSQL; outbox avoids adding Redis for a single use case."
```

### Principles

- **Never verbose.** One sentence per section is often enough. If a field adds nothing, drop it.
- **Descriptive title.** Should tell a reader exactly what the issue is about without opening it.
- **Correct template.** Bug → reproduction + environment. Feature → goal + acceptance criteria. Task → goal + scope checklist. Proposal → problem + options.
- **Omit empty sections.** No logs? Drop it. Approach obvious? Skip it. Only one option? Skip Options, go straight to recommendation.
- **Always apply labels.** Every issue gets at least a `type/` label. Add `topic/` labels when the affected area is clear.

## Label Awareness

### Standard label set

See `assets/labels.md` for the full reference. Labels follow `namespace/name` convention (from go-gitea/gitea):

- **`type/`** — bug, feature, enhancement, proposal, docs, refactoring, testing
- **`issue/`** — confirmed, duplicate, needs-feedback, critical
- **`proposal/`** — accepted, rejected
- **`status/`** — blocked
- **`pr/`** — wip, breaking
- **`topic/`** — ui, api, mobile, security, deployment (extend per repo)

### Auto-assigning labels

When creating issues or PRs, the skill should:

1. **Check existing labels** — `tea label list` to see what's available in the repo.
2. **Match from context** — Infer applicable labels from the title, description, and affected area.
3. **If no labels exist** — Propose creating the standard set from `assets/labels.md` and ask for approval before running `tea label create`.
4. **If labels exist but don't match the standard set** — Adapt to whatever the repo uses. Extrapolate from existing label names and patterns rather than forcing the standard set.
5. **Apply via flags** — `--labels "type/bug,topic/api"` on create commands.

### Creating labels

```bash
tea label create --name "type/bug" --color "#ee0701" --description "Something is broken"
```

Always ask the user before bulk-creating labels on a repo.

## Common Issues

### "unauthorized" or 401 errors
**Cause:** Token is expired, revoked, or lacks required scopes.
**Fix:** Generate a new token at `<instance>/user/settings/applications` with appropriate scopes, then `tea login edit <name>` or re-add the login.

### "repository does not exist" when inside a repo
**Cause:** The git remote URL doesn't match any configured login.
**Fix:** Check `git remote -v` and ensure the remote host matches a `tea login list` entry. Use `--login` or `--repo` flags to override.

### tea detects wrong remote / login
**Cause:** Multiple remotes configured (e.g., `origin` + `upstream`).
**Fix:** Use `--remote <name>` to specify which git remote to use, or `--login <name>` to pick the instance directly.

### "tea pr checkout" fails
**Cause:** Local branch with the same name already exists.
**Fix:** Delete or rename the conflicting local branch first.

### Command hangs or TTY error (`huh: could not open a new TTY`)
**Cause:** Tea dropped into interactive mode waiting for stdin. This happens in two scenarios:
1. Missing required flags on commands that prompt interactively (`tea login add`, `tea issue create`, `tea pr create`, `tea comment`, `tea pr review`).
2. **Default login doesn't match git remote host.** When multiple logins exist and the default login's URL doesn't match the current repo's git remote, tea tries to interactively ask which login to use.
**Fix:** Always pass `--login <name>` explicitly on entity commands (see Login Resolution). Use `tea pr approve`/`tea pr reject` instead of `tea pr review`. For `tea whoami`, it only works with the default login — verify non-default logins via `tea login list`.

## Gitea API Fallback

When tea doesn't support an operation, use the Gitea API directly with the token from tea's config.

### When to Use API Instead of Tea CLI

| Operation | Tea Support | Recommendation |
|-----------|-------------|----------------|
| Edit PR/issue description | ❌ No | Use API |
| Edit PR/issue title | ❌ No | Use API |
| Bulk operations (labels, assignees) | Limited | Use API for efficiency |
| Create PR/issue | ✅ Yes | Prefer tea CLI |
| List/view entities | ✅ Yes | Prefer tea CLI |
| Merge/close/reopen | ✅ Yes | Prefer tea CLI |

### Extract Token for a Login

```bash
# Helper: extract a login's token. Use yaml.safe_load, never naive grep —
# YAML nesting + special-char tokens break regex (see Configuration File above).
# Resolves the config path on macOS, Linux/BSD, and Windows:
TEA_TOKEN=$(python3 -c "
import yaml, os
cfg = next((p for p in (
    os.path.join(os.environ.get('APPDATA',''), 'tea', 'config.yml'),
    os.path.expanduser('~/Library/Application Support/tea/config.yml'),
    os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'tea', 'config.yml')
) if p and os.path.exists(p)), None)
with open(cfg) as f: c = yaml.safe_load(f)
print(next((l.get('token','') for l in c.get('logins', []) if '<login-name>' in l.get('url','')), ''))
")
```

Replace `<login-name>` with the login identifier (e.g., `git.example.com`). Use `$TEA_TOKEN` in API calls.

### Common API Operations

All examples use `$TEA_TOKEN` — extract once, reuse in multiple calls.

#### Edit PR Description

```bash
TEA_TOKEN=$(python3 -c "
import yaml, os
cfg = next((p for p in (
    os.path.join(os.environ.get('APPDATA',''), 'tea', 'config.yml'),
    os.path.expanduser('~/Library/Application Support/tea/config.yml'),
    os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'tea', 'config.yml')
) if p and os.path.exists(p)), None)
with open(cfg) as f: c = yaml.safe_load(f)
print(next((l.get('token','') for l in c.get('logins', []) if '<login>' in l.get('url','')), ''))
")
curl -s -X PATCH "https://<host>/api/v1/repos/<owner>/<repo>/pulls/<index>" \
  -H "Authorization: token $TEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Updated description"}'
```

#### Edit Issue Description/Title

```bash
curl -s -X PATCH "https://<host>/api/v1/repos/<owner>/<repo>/issues/<index>" \
  -H "Authorization: token $TEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "New title", "body": "Updated description"}'
```

#### Add Comment (works for both PRs and issues)

```bash
curl -s -X POST "https://<host>/api/v1/repos/<owner>/<repo>/issues/<index>/comments" \
  -H "Authorization: token $TEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Comment text"}'
```

#### Bulk Add Labels

```bash
curl -s -X POST "https://<host>/api/v1/repos/<owner>/<repo>/issues/<index>/labels" \
  -H "Authorization: token $TEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"labels": [1, 2, 3]}'  # Label IDs from tea label list
```

### API Reference & Discovery

**Swagger UI**: `https://<your-instance>/api/swagger` — Interactive API explorer with request builder

**OpenAPI spec**: `https://<your-instance>/swagger.v1.json` — Machine-readable spec for code generation

**Quick endpoint lookup**:
```bash
# Search Swagger spec for endpoints matching a pattern
curl -s https://<host>/swagger.v1.json | jq '.paths | keys[] | select(contains("pulls"))'
```

**Pro tip**: When tea doesn't support an operation, check Swagger for the endpoint, test it interactively, then script it with `$TEA_TOKEN`.

## Additional Resources

- **`assets/pr-template.md`** — PR body (Context, Approach, Verification, Notes)
- **`assets/issue-template-bug.md`** — Bug report (Description, Reproduction, Environment, Logs)
- **`assets/issue-template-feature.md`** — Feature request (Goal, Motivation, Approach, Acceptance Criteria)
- **`assets/issue-template-task.md`** — Task/chore (Goal, Scope)
- **`assets/issue-template-proposal.md`** — Proposal (Problem, Options, Recommendation, Open Questions)
- **`assets/labels.md`** — Standard label set (type/, issue/, proposal/, status/, pr/, topic/)
- **`references/workflows.md`** — Common multi-step workflows (fork flow, review flow, release flow)
- **`references/testing.md`** — Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Explain and execute Gitea CLI (tea) commands for managing PRs, issues, repos, and authentication.

### Examples
- `tea -h` (show tea help and explain commands)
- `tea pr list --state open` (list open pull requests)
- `tea pr create --base main --title "feat: my feature" --labels "type/feature"` (create a PR with template body + labels)
- `tea issue create --title "Login fails on expired token" --labels "type/bug"` (file a bug)
- `tea login add` (add a new Gitea instance login)

### Checklist
- Verify `tea` is installed and authenticated (`tea login list`).
- Resolve correct login from git remote host (see Login Resolution).
- Pass `--login <name>` on all entity commands when default login doesn't match.
- **Always ask for target branch** when creating PRs — never assume master/main.
- For operations tea doesn't support (edit PR/issue), use Gitea API with token from config.
- Use context-aware defaults when inside a git repo.
- Pick the right template (PR vs bug vs feature) and apply labels.
- Confirm destructive operations (merge, close) before executing.
- Return actionable output with links where available.

## Flags

- `--explain` Append rationale for the chosen command and flags
- `--dry-run` Show the command that would be executed without running it
