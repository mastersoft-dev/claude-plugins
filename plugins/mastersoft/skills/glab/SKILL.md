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
- **GitHub remotes**: this skill drives GitLab only. When `origin` is on github.com, use `gh` with the same title/body conventions (a GitHub "pull request" is a GitLab "merge request").
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
   - Opening an MR → follow **Opening an MR** below
   - Translate intent into the correct `glab` invocation or API call
   - Confirm with user before executing publishing or destructive operations

## Command Reference

Full flag tables for every subcommand live in **`references/command-reference.md`**
(auth, MRs, issues, labels, CI/CD, releases, other entities, global flags). Load it
when you need exact flags; the routing, boundaries, and worked examples below cover
the common paths without it.

## Opening an MR

"Open the MR" (or "the PR" — same thing on GitLab) is the go-ahead. One confirmation, not a questionnaire.

1. **Target branch** — the one the user named; else the remote default (`git symbolic-ref --short refs/remotes/origin/HEAD`, drop the `origin/` prefix). If the branch was cut from a long-lived branch other than the default (`dev`, `develop`, `staging` — the one with the most recent `git merge-base` with `HEAD`), target that. The choice is shown in the confirmation, never applied silently.
2. **Push first** — if the branch has no upstream or is ahead of it, `git push -u origin HEAD`, so the push is an explicit step (`glab mr create --fill` would otherwise push on its own). The org hook only asks when the branch is protected.
3. **Title** — commit style (`feat: …`, no scope). One commit → its subject. Several → one line on the outcome.
4. **Body** — empty, or one line of WHY, plus `Closes #N` when it closes an issue. Headed sections only when the user asks, or to flag a breaking change / migration. Never restate commits, list files, or add Verification / Testing sections.
5. **Repo template** (`.gitlab/merge_request_templates/`) — read it, keep only the sections that apply, one line each, and pass the result via `--description`. Never combine `--template` with `--yes`: it submits the raw placeholders.
6. **Labels** — `glab label list`; apply the obvious `type/` label when the repo has one. Label creation is a separate request.
7. **Confirm once** — target, title, body, labels in one message; on OK, run it.

```bash
git push -u origin HEAD
glab mr create --fill --target-branch main --title "fix: prevent double-charge on retry" --yes
glab mr create --fill --target-branch main --title "feat: add session-based auth" \
  --description "Closes #42" --label "type/feature" --yes
```

`--fill` takes the description from the commits (empty for subject-only commits); an explicit `--description` replaces it.

| Bad title | Good title |
|-----|------|
| `Update user.ts, auth.ts, and middleware.ts` | `feat: add session-based authentication` |
| `Fix bug` | `fix: prevent double-charge on retry` |
| `Changes for review` | `refactor: extract validation into shared module` |

A multi-section example (breaking change) lives in `references/examples.md`.

## Issue Description Guidelines

Pick the template matching the issue type — the repo's `.gitlab/issue_templates/<name>.md` if present, else one of the assets below. Keep only the sections that carry information and pass the body via `--description` (never `--template` with `--yes`, which submits the placeholders). A small task can be a title plus one line.

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

Worked bug / feature examples: `references/examples.md`.

### Principles

- **Never verbose.** One sentence per section is often enough.
- **Descriptive title.** Should tell a reader exactly what the issue is about without opening it.
- **Right template, minimal fill.** Bug → description + reproduction (environment/logs only when relevant). Feature → goal (+ acceptance criteria when non-obvious). Task → goal. Proposal → problem + options.
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

When no subcommand exposes what you need, use `glab api <endpoint>` — same stored auth, no token extraction. Path placeholders (`:fullpath`, `:id`, `:branch`), edit/label/paginate/GraphQL recipes, and `--field` vs `--raw-field`: `references/api.md`.

## Common Issues

### "not authenticated" / 401
**Cause:** Token expired, revoked, missing scopes, or wrong hostname for the current repo.
**Fix:** `glab auth status --all` to inspect; re-run `glab auth login --hostname <host> --token <new>` with `api` scope.

### MR or issue create hangs
**Cause:** A required text input was omitted, dropping glab into an editor or prompt.
**Fix:** Always pass `--fill` or `--title` + `--description` (string, not `-`), plus `--yes`. Never use `--description -` from Claude Code.

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

- **`assets/pr-template.md`** — MR body skeleton (one line of WHY; optional Notes for breaking changes)
- **`assets/issue-template-bug.md`** — Bug report
- **`assets/issue-template-feature.md`** — Feature request
- **`assets/issue-template-task.md`** — Task / chore
- **`assets/issue-template-proposal.md`** — Proposal
- **`assets/labels.md`** — Standard label set (type/, issue/, proposal/, status/, pr/, topic/)
- **`assets/gitlab-repo-templates/`** — Drop-in templates a repo can commit to `.gitlab/merge_request_templates/` and `.gitlab/issue_templates/` (the skill reads and fills them)
- **`references/command-reference.md`** — full flag tables for every subcommand (auth, MRs, issues, labels, CI/CD, releases, global flags)
- **`references/workflows.md`** — MR review flow, approval rules, merge train, fork flow
- **`references/ci.md`** — Pipeline/job ops, trace, retry, lint
- **`references/api.md`** — `glab api` placeholders and recipes
- **`references/examples.md`** — worked MR / issue examples
- **`references/testing.md`** — Troubleshooting, test protocols, success criteria

## Help

### Synopsis
Explain and execute GitLab CLI (glab) commands for managing MRs, issues, pipelines, releases, and authentication.

### Examples
- `glab -h` (show glab help)
- `glab mr list --state open` (list open MRs)
- `glab mr create --fill --target-branch main --title "feat: my feature" --label "type/feature" --yes` (create MR after `git push`)
- `glab issue create --title "Login fails on expired token" --label "type/bug" --description "..." --yes`
- `glab ci status --live` (watch pipeline)
- `glab ci trace <job-name>` (stream failing job log)
- `glab release create v1.0.0 --notes-file CHANGELOG.md` (publish release)
- `glab auth login --hostname gitlab.example.org --token "$GITLAB_TOKEN"`

### Checklist
- Verify `glab` is installed and authenticated (`glab auth status`).
- Target branch = user's choice, else the detected base, shown in the single confirmation.
- Push with `git push` before `glab mr create --fill`, so the push is explicit.
- Pass `--yes` plus `--fill` or explicit `--title` / `--description` to avoid interactive prompts that hang.
- Repo templates (`.gitlab/merge_request_templates/`, `.gitlab/issue_templates/`) are read and filled with only the applicable sections, then passed via `--description`.
- For operations not exposed by a subcommand, use `glab api` — no token extraction needed.
- Confirm destructive operations (merge, close, delete, cancel, retry) before executing.
- Return actionable output with links where available.

## Flags

- `--explain` Append rationale for the chosen command and flags
- `--dry-run` Show the command that would be executed without running it
