# glab — Common Workflows

## Contents
- [Fork & MR Flow](#fork--mr-flow)
- [MR Review Flow](#mr-review-flow)
- [Approval Rules & Code Owners](#approval-rules--code-owners)
- [Merge Train (GitLab Premium+)](#merge-train-gitlab-premium)
- [Draft MRs](#draft-mrs)
- [Issue Triage Flow](#issue-triage-flow)
- [Multi-Host (rare)](#multi-host-rare)
- [CI/CD from the Command Line](#cicd-from-the-command-line)
- [JSON Output for Scripting](#json-output-for-scripting)
- [Releases (used by the `release` skill)](#releases-used-by-the-release-skill)

## Fork & MR Flow

```bash
# 1. Fork upstream project
glab repo fork group/subgroup/project --clone

# 2. (or, if you already have a clone) add the fork as origin and upstream as upstream
# git remote rename origin upstream && git remote add origin git@gitlab.example.org:<you>/project.git

# 3. Create feature branch, make changes, push
git checkout -b feat/my-change
git add . && git commit -m "feat: add feature"
git push -u origin feat/my-change

# 4. Create MR targeting upstream main (cross-fork)
glab mr create --target-branch main --source-branch feat/my-change \
  --title "feat: add feature" --label "type/feature" --yes
```

## MR Review Flow

```bash
# 1. List open MRs assigned to me
glab mr list --assignee=@me

# 2. Check out the MR locally for testing
glab mr checkout 42

# 3. Run tests / verify the change locally

# 4. Approve or request changes via a comment
glab mr approve 42
# or
glab mr note create 42 -m "Approach LGTM but please add a regression test for the edge case at X."

# 5. Merge once pipeline + approvals are green
glab mr merge 42 --squash --remove-source-branch --yes

# 6. Branch cleanup happens via --remove-source-branch (above) or manually:
git fetch --prune origin
```

> `glab mr merge` defaults to `--auto-merge=true` while a pipeline is running. The merge happens automatically once checks pass. Pass `--auto-merge=false` to merge immediately (rare — usually wait).

## Approval Rules & Code Owners

GitLab MRs respect **approval rules** (per-project) and **code owners** (`.gitlab/CODEOWNERS`).

- `glab mr view 42` shows the rules status (`Approved by:`, `Approvals required:`, blocking discussions, etc.).
- If a merge is blocked, **read the rules first** before asking the user to re-approve — usually a missing approver, an unresolved discussion, or a failing pipeline.
- `glab mr approve 42` adds the current user's approval, subject to whether they're in an applicable approval rule.

## Merge Train (GitLab Premium+)

When a merge train is configured on the target branch, `glab mr merge` enqueues the MR on the train instead of merging directly.

```bash
# Add to merge train and let GitLab serialize
glab mr merge 42 --yes

# View the train state
glab api projects/:fullpath/merge_trains
```

There's no first-class `glab` subcommand for merge train inspection — drop to `glab api` for visibility.

## Draft MRs

GitLab uses a `Draft:` title prefix (not `[WIP]`). `glab` handles the prefix for you when you pass `--draft` or `--wip`.

```bash
# Create as draft
glab mr create --draft --title "feat: WIP authentication rework" --yes

# Mark ready for review
glab mr update 42 --ready

# Convert back to draft
glab mr update 42 --draft
```

## Issue Triage Flow

```bash
# Triage queue: open bugs with no assignee (glab has no native "unassigned"
# filter — query the API; assignee_id=None returns unassigned issues)
glab api "projects/:fullpath/issues?state=opened&labels=type/bug&assignee_id=None"

# Pick one and assign yourself
glab issue update 15 --assignee=+@me --label "issue/confirmed"

# Comment with reproduction notes
glab issue note 15 --message "Reproduced on main@a1b2c3d. Linked MR follows."

# Link the MR that will fix it
glab issue update 15 --linked-mr 123

# Close when done (or let the autoclose keyword in the MR close it on merge)
glab issue close 15
```

## Multi-Host (rare)

The common case is single-host (auto-resolved from git remote). For multi-host setups:

```bash
# Configure multiple hosts
glab auth login --hostname gitlab.com --token "$GITLAB_TOKEN_COM"
glab auth login --hostname gitlab.example.org --token "$GITLAB_TOKEN_EXAMPLE"

# Inspect everything
glab auth status --all

# Operate against a specific host (when not inside its repo)
glab mr list --hostname gitlab.example.org --repo group/project
```

## CI/CD from the Command Line

Quick reference (full playbook in `ci.md`):

```bash
# Watch the current branch's pipeline live
glab ci status --live

# Pick a failing job and stream its log
glab ci trace some-job-name

# Re-run a flake (with confirmation)
glab ci retry some-job-name

# Lint .gitlab-ci.yml before pushing config changes
glab ci lint
```

## JSON Output for Scripting

`--output ndjson` + `--paginate` is the easiest pipeline:

```bash
# All open issues across all pages, filtered with jq
glab api projects/:fullpath/issues --paginate --output ndjson \
  | jq -c 'select(.state == "opened") | {iid, title, labels}'

# All MRs targeting main, JSON
glab mr list --target-branch main --output json | jq '.[].title'
```

## Releases (used by the `release` skill)

```bash
# Create a release from an annotated tag that already exists locally and is pushed
git tag -a v1.6.0 -m "v1.6.0" && git push origin v1.6.0
glab release create v1.6.0 --name "v1.6.0" --notes-file CHANGELOG-1.6.0.md

# Create a release and the tag at once (tag will point at the given ref)
glab release create v1.6.0 --ref main --notes "First cut" --tag-message "v1.6.0"

# Upload an asset with a display label (label is appended after '#', not a flag)
glab release upload v1.6.0 'dist/binary.zip#Binary release'
```
