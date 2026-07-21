# Command Recipes

All recipes use `codex exec …` forms (Rule 1) with the **canonical suffix** from SKILL.md:

## Contents
- [Foreground exec](#foreground-exec)
- [Code review (Rule 4)](#code-review-rule-4)
- [Resume](#resume)
- [Background (xhigh, Rule 2)](#background-xhigh-rule-2)
- [Cloud](#cloud)
- [Kill recovery (Rule 5)](#kill-recovery-rule-5)
- [JSONL `--json` event order](#jsonl---json-event-order)

```
--json -c model_reasoning_effort="<level>" -o "$final" < /dev/null > "$log" 2>&1
```

Boilerplate: `log=$(mktemp -t codex-events.XXXXXX.jsonl)`, `final=$(mktemp -t codex-final.XXXXXX.txt)`. Surface `thread_id` via `grep -m1 thread.started "$log" | jq -r '.thread_id'` (never `head -1 | jq` — first line may be stderr).

## Foreground exec

```bash
codex exec "<prompt>" \
  --json -c model_reasoning_effort="medium" -o "$final" < /dev/null > "$log" 2>&1
```

Unattended writes — prepend `--sandbox workspace-write -c approval_policy=never`.

## Code review (Rule 4)

```bash
codex exec review --uncommitted --json -c model_reasoning_effort="medium" -o "$final" < /dev/null > "$log" 2>&1
codex exec review --base <branch> --json -c model_reasoning_effort="medium" -o "$final" < /dev/null > "$log" 2>&1
codex exec review --commit <SHA>  --json -c model_reasoning_effort="medium" -o "$final" < /dev/null > "$log" 2>&1
```

`--commit` accepts SHA, `HEAD`, `HEAD~N`, branch name. `--base` reviews HEAD-vs-branch (HEAD is implicit, not user-overridable). Model override: `-m <model>` (works on `exec review`; top-level `codex review` rejects `-m`/`--json`/`-o`).

## Resume

```bash
codex exec resume <UUID> --json -c model_reasoning_effort="medium" -o "$final" "continue from where you stopped" < /dev/null > "$log" 2>&1
codex exec resume --last  --json -c model_reasoning_effort="medium" -o "$final" "continue" < /dev/null > "$log" 2>&1
```

Resume rejects `--profile`, `--sandbox`, `--cd`, `--add-dir`, `--output-schema`, `--color`, `--oss` — resumed session uses persisted config. `UUID` = `thread_id` from first `thread.started` event (or `session_meta.payload.id` in rollout).

## Background (xhigh, Rule 2)

`Bash(run_in_background: true)`:

```bash
codex exec "<prompt>" \
  --json -c model_reasoning_effort="xhigh" -o "$final" < /dev/null > "$log" 2>&1 &
echo "PID=$!"
```

Monitor command (poll-loop, three exit conditions):

```bash
until grep -qE '^\{"type":"turn\.(completed|failed)"|^\{"type":"error"' "$log" 2>/dev/null \
   || ! kill -0 "$pid" 2>/dev/null \
   || [ -n "$(find "$log" -mmin +5 -print 2>/dev/null)" ]; do
  sleep 2
done
echo READY
```

Exit reasons:
1. **Terminal event** (`turn.completed` / `turn.failed` / `error`) — normal path.
2. **PID died** (`! kill -0`) — codex crashed without emitting anything.
3. **Log stale 5+ min** (`find -mmin +5`) — silent stall between item events. Codex 0.130.0 can hang indefinitely between `item.completed` events with no `turn.failed` ever surfacing (Responses API stall, rate-limit not propagated to JSONL). Treat as Rule 5 trigger.

Anchor regex to line-start `^\{` so JSONL events match but `aggregated_output` fields containing the literal string `"type":"turn.completed"` (from rg / grep output the agent ran) do NOT false-match.

Never `tail -F | grep -m1 …` — `tail -F` blocks after match waiting for next write; Monitor stays armed until wall-clock timeout.

On match: inspect last line. Terminal event → read `$final`. Stall/dead → Rule 5 (SIGTERM + rollout-parse + resume).

## Cloud

```bash
codex cloud exec --env <ENV_ID> "<prompt>"
codex cloud list | status <task-id> | diff <task-id>
codex apply <task-id>
```

`--env <id>` required. Server-side; no Bash-timeout.

## Kill recovery (Rule 5)

`effort` = level the dead run used (Rule 3 — `medium` by default).

```bash
effort=medium
rollout=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)
uuid=$(jq -r 'select(.type=="session_meta") | .payload.id' "$rollout" | head -1)
partial=$(jq -r 'select(.payload.type=="agent_message") | .payload.message' "$rollout" | tail -1)
printf 'Partial output:\n%s\n\nResume:\n  codex exec resume %s --json -c model_reasoning_effort="%s" -o %s "continue and emit the final result" < /dev/null > %s 2>&1\n' \
  "$partial" "$uuid" "$effort" "$final" "$log"
```

`-o "$final"` writes only at `turn.completed`. On kill, parse the rollout file directly.

## JSONL `--json` event order

Per `codex-rs/exec/src/exec_events.rs`:

1. `thread.started` `{thread_id}` — always first.
2. `turn.started`.
3. `item.started` — long-running items.
4. `item.updated` — incremental.
5. `item.completed` — terminal; carries `item.type` + payload.
6. `turn.completed` `{usage}` — success.
7. `turn.failed` `{error.message}` — rate limit / 4xx / sandbox denial.
8. `error` — unrecoverable stream-level.

Final answer = last `item.completed` with `item.type == "agent_message"` before `turn.completed`:

```bash
jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$log" | tail -1
```
