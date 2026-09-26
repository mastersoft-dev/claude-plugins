# GitLab (glab)

Checked against glab 1.116 and a self-hosted GitLab. `glab api` has no `--jq`: pipe to `jq`. `-R OWNER/REPO` resolves against gitlab.com, so on a self-hosted instance call the API with the project id instead.

## Ids

```bash
P=$(glab api "projects/<url-encoded path, e.g. group%2Fproject>" | jq -r .id)
glab api "projects/$P/merge_requests?source_branch=<branch>&state=opened" | jq -r '.[0].iid'
```

## State of the MR

```bash
glab api "projects/$P/merge_requests/<iid>" | jq '{sha, target_branch, detailed_merge_status, has_conflicts, blocking_discussions_resolved, head_pipeline: {id: .head_pipeline.id, status: .head_pipeline.status, web_url: .head_pipeline.web_url}}'
```

`head_pipeline` can lag a few seconds behind a push: find the pipeline by commit instead.

```bash
glab api "projects/$P/pipelines?sha=<head sha>&per_page=1" | jq -r '.[0] | "\(.id) \(.status)"'
glab api "projects/$P/pipelines/<pipeline id>/jobs?per_page=100" | jq -r '.[] | "\(.id) \(.name) \(.status)"'
```

Pipeline and job statuses: `created`, `waiting_for_resource`, `preparing`, `pending`, `running` (not terminal); `success`, `failed`, `canceled`, `skipped`, `manual` (terminal for the watch). `manual` means blocked on a person.

## Logs and retry

```bash
glab api "projects/$P/jobs/<job id>/trace" | tail -200    # plain text; `glab ci trace` streams and may prompt
glab ci retry <job id>
```

## Threads

```bash
glab api "projects/$P/merge_requests/<iid>/discussions?per_page=100"
```

- A finding is a discussion whose notes are `resolvable`; it's open while `resolved` is false. `individual_note: true` notes are not resolvable: that's where review bots post their summary, so read them too.
- A note's `author` has no bot flag. Look the author up once per round: `glab api "users/<author id>" | jq .bot`.
- Reply: `glab api -X POST "projects/$P/merge_requests/<iid>/discussions/<discussion id>/notes" -f body='<reply>'`
- Resolve: `glab api -X PUT "projects/$P/merge_requests/<iid>/discussions/<discussion id>?resolved=true"`

## Merge

```bash
glab api "projects/$P" | jq '{merge_method, squash_option, remove_source_branch_after_merge}'
glab mr merge <iid> --yes [--squash] [--remove-source-branch]
```

- `squash_option`: `always`/`default_on` → squash; `never`/`default_off` → no squash.
- `merge_method` `merge` makes a merge commit. `rebase_merge` and `ff` need the branch rebased onto the target first.
- After the merge, the target pipeline for the merge commit: `glab api "projects/$P/merge_requests/<iid>" | jq -r .merge_commit_sha`, then find the pipeline by that `sha`.

## Watch skeleton

One job line per job as it ends, one pipeline line at the end. Adapt, don't copy blindly.

```bash
P=<project id>; SHA=<head sha>; seen=$(mktemp); err=$(mktemp); fails=0
while :; do
  pl=$(glab api "projects/$P/pipelines?sha=$SHA&per_page=1" 2>"$err") || {
    fails=$((fails+1)); [ "$fails" -eq 3 ] && echo "CLI_ERROR $(tr -s ' \n' ' ' < "$err" | cut -c1-200)"
    sleep 90; continue; }
  fails=0
  id=$(printf '%s' "$pl" | jq -r '.[0].id // empty'); st=$(printf '%s' "$pl" | jq -r '.[0].status // "none"')
  if [ -n "$id" ]; then
    glab api "projects/$P/pipelines/$id/jobs?per_page=100" 2>/dev/null \
      | jq -r '.[] | select(.status | test("^(success|failed|canceled|skipped|manual)$")) | "JOB \(.name) \(.status) \(.id)"' \
      | while read -r line; do grep -qxF "$line" "$seen" || { echo "$line"; echo "$line" >> "$seen"; }; done
  fi
  case $st in success|failed|canceled|skipped|manual) echo "PIPELINE $st $id"; exit 0;; esac
  sleep 90
done
```

To watch threads in the same command, count the open resolvable discussions on each poll and print `THREADS <n>` when the number changes.
