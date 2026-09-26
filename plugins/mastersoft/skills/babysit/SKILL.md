---
name: babysit
description: Shepherd a merge request or pull request until it is ready to merge, merged or deployed. Watches the pipeline, fixes red jobs, answers the review bot's threads and repeats. GitLab (glab) and GitHub (gh). Use when the user asks to babysit, shepherd or watch an MR/PR until it is green. For a single look at a pipeline use glab.
argument-hint: "[MR/PR number or URL] [--until ready|merged|deployed]"
allowed-tools: Read, Grep, Glob, Monitor, Bash(git:*), Bash(glab:*), Bash(gh:*), Bash(command:*)
---

# Babysit

Take the MR/PR in `$ARGUMENTS` (default: the one for the current branch) from wherever it is to its stop point. Rounds of **watch → fix → answer the bot → push** repeat until the stop condition holds, and every round leaves the branch in a state you could hand to a reviewer.

## Context

- Remote: !`git remote get-url origin 2>/dev/null || echo "no remote"`
- Branch: !`git branch --show-current 2>/dev/null || echo "not a repo"`
- CLIs: !`command -v glab gh 2>/dev/null || echo "neither glab nor gh on PATH"`

## 1. Set up

1. **Forge.** Read it from the remote host: a GitLab host → `glab`, `github.com` → `gh`. Then read `references/gitlab.md` or `references/github.md`, which list the verified commands and endpoints. Any other forge (Gitea, Forgejo, Bitbucket…) → ask the user which CLI or API to use, then apply the same procedure.
2. **Target.** The MR/PR number or URL from `$ARGUMENTS`, else the open one whose source branch is the current branch. None → stop and say so. Opening an MR is not this skill's job.
3. **Stop point.** `--until` from `$ARGUMENTS`; else what the repo's `AGENTS.md`/`CLAUDE.md` say, then the user's `CLAUDE.md` (for example "babysitting stops at ready to merge", "merge when green"); else `ready`.
   - `ready`: the pipeline for the head commit is green, the last review round from the bot brought nothing new, and there are no conflicts with the target branch. Never merge.
   - `merged`: `ready`, then merge with the repo's method: the project settings (`references/<forge>.md`), else what the rules files say, else ask. Remove the source branch when the repo does that.
   - `deployed`: `merged`, then watch the target branch's pipeline for the merge commit until it ends, and treat a red one like a red MR pipeline.
4. **Gates.** Find the repo's local gates (format, lint, typecheck, tests) in `AGENTS.md`/`CLAUDE.md`, `CONTRIBUTING.md` or the manifest scripts. You run them before every push.

## 2. Watch

Write a `Monitor` watch for the head commit yourself, with the forge's commands from the reference. The command:

- polls every 60–120 s, never in a tight loop;
- prints one line per change: a job finishing (name + status), the pipeline finishing, a new review thread or note;
- matches **every** terminal state: success, failed, canceled, skipped and manual/blocked, never only the happy path;
- survives a failed CLI call instead of exiting on it, and prints one `CLI_ERROR` line after three failures in a row, so an outage doesn't read as a slow pipeline;
- exits on its own once the pipeline is terminal, with a final `PIPELINE <status>` line;
- sets `timeout_ms` to 1800000. On the expiry notice, check the state and start a new watch if the pipeline is still running.

Keep working while it runs (read the diff, check threads already open). Don't poll by hand in a foreground loop.

## 3. Handle what the round brings

1. **Red job.** Read its log (`references/<forge>.md`) and find the cause in it. A failure in code the branch touches → fix it. A transient failure outside the branch (runner lost, registry or network error, a timeout in a step the branch doesn't affect) → retry that job once. If the same job fails again, it's a real failure: read the log and fix it. Name the cause with the log line that proves it; "flaky" also needs a log line.
2. **Bot threads.** List the unresolved threads and the notes the bot posted since the last round. Tell bots from people by the API's flag, never by name (`references/<forge>.md`). For each bot finding:
   - it's right → fix it, reply in the thread with what changed, resolve the thread;
   - it's wrong → reply in the thread with the evidence (`file:line`, a doc, a test). Leave the thread open for the user: a disagreement you raised is theirs to settle;
   - resolve a thread only after replying in it.
   Human comments: never reply to them or resolve them on your own. List them in the report, with the reply you'd suggest.
3. **Conflicts with the target branch.** Merge or rebase: say which and why in one line. Resolve the conflicts, check that `git diff --check` is clean, then run the gates.
4. **Push.** Run the gates, and any e2e check the user asked for. Any gate red → stop: no commit, no push, and explain why. Otherwise commit, one concern per commit, and push once for the whole round.
   - The branch is on origin, so add commits: no amend and no force-push.
   - A rebase is pushed with `--force-with-lease`, and only when you declared it, the MR is not merged and you are its only author.
   - Never push to the target branch.
5. Back to step 2 on the new head commit.

## 4. Stop

- **Stop point reached** → report.
- **Caps.** After 3 rounds with fixes, stop and hand over with the state and what's left. A bot point that comes back for a third round: reply once more with your position, leave the thread open, and don't fix around it again.
- **Blocked** → stop and report what blocks. Examples: a manual or blocked job, a permission error, a job still red after its retry with a cause outside the branch, required approvals missing at `merged`.
- **Non-interactive run** (`claude -p`): the run waits for background watches for 10 minutes at most. Do one round, then report the state, and say that the babysit is not finished.

## Report

Put a short report in the reply:

- MR/PR URL, head SHA, stop point reached (or where it stopped);
- pipeline: id, status, URL;
- per round, one line: what failed or was raised, what you did, commits pushed;
- threads still open, each with why (your pushback, a human comment), and any suggested reply;
- `Blocked on:` what the user has to do, if anything.
