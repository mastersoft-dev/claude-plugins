# glab — CI/CD Playbook

`glab ci` drives pipelines and jobs. Below is the read-first, mutate-with-confirmation policy this skill follows.

## Contents
- [Quick reference](#quick-reference)
- [Confirmation policy](#confirmation-policy)
- [Triage protocol (failing pipeline)](#triage-protocol-failing-pipeline)
- [Linting `.gitlab-ci.yml`](#linting-gitlab-ciyml)
- [Variables (use sparingly)](#variables-use-sparingly)
- [Schedules](#schedules)
- [Common issues](#common-issues)

## Quick reference

| Intent | Command | Class |
|--------|---------|-------|
| What's running on my branch right now? | `glab ci status --live` (or `--compact`) | read-only |
| What ran recently? | `glab ci list --status failed` | read-only |
| Details for a specific pipeline | `glab ci get --pipeline-id <id>` | read-only |
| Stream a job's log | `glab ci trace <job-id\|job-name>` | read-only |
| Validate `.gitlab-ci.yml` | `glab ci lint` | read-only |
| Inspect merged CI config | `glab ci config compile [<path>]` | read-only |
| Download artifacts | `glab job artifact <ref> <job>` (the legacy `glab ci artifact` is a deprecated alias) | read-only |
| Re-run a failed job | `glab ci retry <job-id\|job-name>` | publishing (confirm) |
| Trigger a manual job | `glab ci trigger <job-id\|job-name>` | publishing (confirm) |
| Start a new pipeline | `glab ci run --branch <b>` | publishing (confirm) |
| Cancel running pipeline/job | `glab ci cancel pipeline <id>` or `glab ci cancel job <id>` (subcommand required) | destructive (always confirm) |
| Delete a pipeline | `glab ci delete <id>` | destructive (always confirm) |

`glab ci view` is an **interactive TUI** — use only when the user has a real terminal. Never invoke from a hook, agent, or scripted workflow.

## Confirmation policy

Before invoking any **publishing** or **destructive** command, present the planned action and ask the user to confirm via `AskUserQuestion`:

> "Retry job `test:unit` on pipeline #12345? This consumes CI minutes and re-runs against the current HEAD." → [Yes, retry] [Cancel]

For **destructive** commands (cancel, delete) the answer must be an affirmative `Yes` — never assume.

## Triage protocol (failing pipeline)

```
1. glab ci status                          # overview, which job failed
2. glab ci status --live                   # if a pipeline is still running and you need to watch
3. glab ci trace <failing-job>             # read the log
4. <fix locally> or <inspect .gitlab-ci.yml>
5. glab ci lint                            # if you edited .gitlab-ci.yml
6. git push                                # let CI run again
   # OR (only when the failure is a known flake):
   glab ci retry <failing-job>             # after user confirms
```

Do not "retry until green." If a job fails twice, **stop and read the log** — flake-retry loops mask real bugs.

## Linting `.gitlab-ci.yml`

`glab ci lint` validates the YAML against the project's GitLab instance (so includes, components, and rules are evaluated server-side). Run it before pushing changes to `.gitlab-ci.yml`.

```bash
# Lint .gitlab-ci.yml in the current directory
glab ci lint

# Lint a specific file (positional, not a flag)
glab ci lint .gitlab/ci-experimental.yml

# Simulate pipeline creation with --dry-run, optionally with a ref
glab ci lint --dry-run --ref refs/heads/feature
```

## Variables (use sparingly)

`glab variable` manages project CI/CD variables. Treat as production config — **always confirm before mutating**.

```bash
glab variable list                                          # safe
glab variable set MY_KEY "<value>" --masked --protected     # confirm before; value can also be stdin or -v
cat secret.txt | glab variable set MY_KEY --masked          # value from stdin (safer than CLI arg)
glab variable delete MY_KEY                                 # destructive — confirm
```

Never log a variable value. Never paste a secret into the conversation.

## Schedules

```bash
glab schedule list
glab schedule run <id>                    # positional id; confirm before
```

## Common issues

### "no pipeline found for current branch"
**Cause:** The latest push hasn't triggered a pipeline yet, or `.gitlab-ci.yml` has `rules:` excluding this branch.
**Fix:** `git log -1` to confirm the push reached the remote, then `glab ci list --per-page 5` to see what's running. Inspect `.gitlab-ci.yml` rules if nothing fires.

### `glab ci trace` exits immediately
**Cause:** Job already finished — there's nothing to stream live.
**Fix:** `glab ci get --pipeline-id <id>` and pull the artifact log via the API, or re-run with `glab ci retry` (confirm first).

### Retry triggers the wrong job
**Cause:** `<job-name>` collides across stages.
**Fix:** Pass the numeric `<job-id>` from `glab ci status` instead of the name.

### Pipeline stuck on a manual job
**Cause:** A `when: manual` job is blocking the pipeline.
**Fix:** `glab ci trigger <job-name>` (with confirmation). If the job shouldn't be manual, edit `.gitlab-ci.yml`.

### `glab ci view` looks frozen
**Cause:** It's a TUI; the harness can't drive it.
**Fix:** Don't invoke `ci view` from Claude Code. Use `ci status`, `ci trace`, `ci list` instead.
