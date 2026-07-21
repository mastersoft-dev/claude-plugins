# glab — Command Reference

Full flag tables for every `glab` subcommand this skill drives. The SKILL.md body
handles routing, boundaries, and worked examples; consult this file for exact flags.

## Contents
- [Authentication (`glab auth`)](#authentication-glab-auth)
- [Merge Requests (`glab mr`)](#merge-requests-glab-mr)
- [Issues (`glab issue`)](#issues-glab-issue)
- [Labels (`glab label`)](#labels-glab-label)
- [CI/CD (`glab ci`)](#cicd-glab-ci)
- [Releases (`glab release`)](#releases-glab-release)
- [Other Entities](#other-entities)
- [Global Flags](#global-flags)

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
