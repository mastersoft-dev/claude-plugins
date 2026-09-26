# GitHub (gh)

Checked against gh 2.100. `gh api` takes `--jq`.

## State of the PR

```bash
gh pr view <n> --json number,url,headRefOid,baseRefName,state,mergeable,mergeStateStatus
gh pr checks <n> --json name,state,bucket,link
```

`bucket` is `pass`, `fail`, `pending`, `skipping` or `cancel`. `link` points at the job (`…/actions/runs/<run id>/job/<job id>`). `mergeStateStatus` `DIRTY` means conflicts; `BLOCKED` means required reviews or checks are missing.

## Logs and retry

```bash
gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs | tail -200   # available as soon as the job ends
gh run view <run id> --log-failed                                     # whole run, only once the run ends
gh run rerun <run id> --failed
```

## Threads

```bash
gh api graphql -f query='query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{author{login __typename} body url}}}}}}}' -F o=<owner> -F n=<repo> -F num=<n>
gh api repos/<owner>/<repo>/issues/<n>/comments --jq '.[] | {user: .user.login, type: .user.type, body, created_at}'
```

- A finding is a review thread with `isResolved: false`. Review bots also post summary comments on the PR itself, which the second call lists.
- Bot: `author.__typename == "Bot"` in GraphQL (the login has no `[bot]` suffix there); `user.type == "Bot"` in REST.
- Reply: `gh api graphql -f query='mutation($id:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$b}){comment{url}}}' -F id=<thread id> -f b='<reply>'`
- Resolve: `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread id>`

`gh pr comment` posts on the PR, not in the thread: don't use it for replies.

## Merge

```bash
gh api repos/<owner>/<repo> --jq '{merge: .allow_merge_commit, squash: .allow_squash_merge, rebase: .allow_rebase_merge, delete_branch: .delete_branch_on_merge}'
gh pr merge <n> --merge|--squash|--rebase [--delete-branch]
```

When only one method is allowed, use it. When several are, go by the rules files, and ask if they don't say.

After the merge, the target runs for the merge commit:

```bash
gh pr view <n> --json mergeCommit --jq .mergeCommit.oid
gh run list --commit <sha> --json databaseId,name,status,conclusion
```

## Watch skeleton

Adapt, don't copy blindly.

```bash
N=<pr>; seen=$(mktemp); err=$(mktemp); fails=0
while :; do
  c=$(gh pr checks "$N" --json name,bucket,link 2>"$err") || {
    fails=$((fails+1)); [ "$fails" -eq 3 ] && echo "CLI_ERROR $(tr -s ' \n' ' ' < "$err" | cut -c1-200)"
    sleep 90; continue; }
  fails=0
  printf '%s' "$c" | jq -r '.[] | select(.bucket != "pending") | "CHECK \(.name) \(.bucket) \(.link)"' \
    | while read -r line; do grep -qxF "$line" "$seen" || { echo "$line"; echo "$line" >> "$seen"; }; done
  if [ "$(printf '%s' "$c" | jq 'length > 0 and all(.[]; .bucket != "pending")')" = true ]; then
    echo "PIPELINE $(printf '%s' "$c" | jq -r 'if any(.[]; .bucket == "fail") then "failed" elif any(.[]; .bucket == "cancel") then "canceled" else "success" end')"; exit 0
  fi
  sleep 90
done
```

A PR with no checks yet returns an empty list: the loop keeps waiting until checks for the new head appear. With `--json`, `gh pr checks` exits 0 even when checks fail or are pending, so a non-zero exit is a real CLI or network error.
