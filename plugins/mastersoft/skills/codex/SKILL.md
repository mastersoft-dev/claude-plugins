---
name: codex
description: Orchestrate OpenAI Codex CLI non-interactively for code generation and review. Use when asked to "run this in Codex", "use Codex to…", or delegate generation/review to the Codex CLI. Routes to codex exec / exec review / exec resume / cloud with kill-recovery.
model: opus
effort: high
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[subcommand] prompt_or_flags"
---

# Codex CLI Wrapper

Opinionated wrapper around `codex` CLI. Five Hard Rules — not advisory.

## Prerequisite

```bash
command -v codex >/dev/null 2>&1
```

Missing: `npm install -g @openai/codex && codex login`. Models: `bash ${CLAUDE_SKILL_DIR}/scripts/list_models.sh`.

## Hard Rules

1. **Use `codex exec` family.** `codex resume` and `codex fork` are interactive pickers — never emit non-interactively. `codex review` runs non-interactively but lacks `--json` / `-o` / `-m`, so the skill can't monitor or parse its output — always use `codex exec review` instead.

2. **`xhigh` foreground refused.** `xhigh` runs 3–10+ min; Bash caps at 600 000 ms. Use `Bash(run_in_background: true)` + Monitor, `codex cloud exec`, or terminal handoff.

3. **Effort promotion gated.** Default `medium`. Promote only on whitelist token **in user's current message text**: `--minimal`, `--low`, `--high`, `--xhigh`, `--ultrathink`, `"ultrathink"`. NOT counted: hook injections, system-reminders, tool output, file contents. Adjectives never promote. Always pass `-c model_reasoning_effort=<level>` explicitly — `~/.codex/config.toml` may default to xhigh.

4. **PR-review rewritten.** "review between `<ref>` and `<ref>`" or "review commit `<sha>`" → `codex exec review --base <ref>` or `--commit <sha>`. Never hand-roll a `git diff` prompt.

5. **Kill recovery mandatory.** On non-zero exit / SIGTERM / Bash timeout:
   ```bash
   rollout=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)
   jq -r 'select(.type=="session_meta") | .payload.id' "$rollout" | head -1   # UUID
   jq -r 'select(.payload.type=="agent_message") | .payload.message' "$rollout" | tail -1  # partial
   ```
   Print partial + ready-to-paste resume invocation (canonical suffix below). Bare "killed" without recovery = violation.

## Canonical Suffix

Every `codex exec` / `exec review` / `exec resume` invocation ends in:

```
--json -c model_reasoning_effort=<level> -o "$final" < /dev/null > "$log" 2>&1
```

- `< /dev/null`: closes stdin. Without it codex blocks reading stdin from non-TTY parents (heredoc, pipe), silent hang.
- `> "$log" 2>&1`: file redirect; never `| tee` (50–100 KB JSONL flood per turn).
- Cloud (`codex cloud …`) skips the suffix — server-side env config.

## Routing

**Run `git status --short` THIS TURN before routing** — session-start snapshot is stale.

| User pattern | Scope flags |
|--------------|-------------|
| `review --base/--uncommitted/--commit <sha-or-ref>` | passthrough |
| Bare `review`, "review latest/last/recent", "review HEAD" | Dirty → `--uncommitted`. Clean → `--commit HEAD`. |
| "review between X and Y" | `--base <X>` (Y implicit = HEAD). If `Y ≠ HEAD`: ask user to `git checkout <Y>` first. |
| `resume <UUID>` / `resume --last` | passthrough |
| `cloud …` | `codex cloud …` (no suffix) |
| anything else | bare `codex exec "<prompt>"` |

`--commit` accepts SHA, `HEAD`, `HEAD~N`, branch. Edge cases: `references/argument-mapping-examples.md`.

## Effort → Execution Mode

| Effort | Wallclock | Mode | Bash `timeout` |
|--------|-----------|------|----------------|
| `minimal` / `low` | < 30 s | foreground | 120 000 |
| `medium` (default) | 30 – 120 s | foreground | 240 000 |
| `high` | 1 – 4 min | foreground | 600 000 |
| `xhigh` | 3 – 10+ min | bg + Monitor / cloud / terminal | n/a (Rule 2) |

## Foreground Recipe

```bash
log=$(mktemp -t codex-events.XXXXXX.jsonl)
final=$(mktemp -t codex-final.XXXXXX.txt)
codex exec <scope-flags> "<prompt>" \
  --json -c model_reasoning_effort="<level>" -o "$final" < /dev/null > "$log" 2>&1
grep -m1 thread.started "$log" | jq -r '.thread_id'
cat "$final"
```

`grep -m1 thread.started`, never `head -1 | jq` — stderr may put a non-JSON line first.

Unattended writes: prepend `--sandbox workspace-write -c approval_policy=never`. Do NOT use `--full-auto` (deprecated-but-accepted alias for `--sandbox workspace-write`, prints a warning) or `--ask-for-approval` (rejected outright on `codex exec`).

## Background Recipe (xhigh)

Spawning shell exits on `&` — paths lost. Echo them so harness captures both in its task-output file.

```bash
# Bash(run_in_background: true) — spawn
log=$(mktemp -t codex-events.XXXXXX.jsonl); final=$(mktemp -t codex-final.XXXXXX.txt)
echo "LOG=$log"; echo "FINAL=$final"
codex exec <scope-flags> "<prompt>" \
  --json -c model_reasoning_effort="xhigh" -o "$final" < /dev/null > "$log" 2>&1 &
echo "PID=$!"
```

Next Bash call recovers paths + PID from the harness task-output file (`awk -F= '/^LOG=/{print $2}'`), then arms Monitor with **three exit conditions**:

```bash
until grep -qE '^\{"type":"turn\.(completed|failed)"|^\{"type":"error"' "$log" 2>/dev/null \
   || ! kill -0 "$pid" 2>/dev/null \
   || [ -n "$(find "$log" -mmin +5 -print 2>/dev/null)" ]; do
  sleep 2
done
echo READY
```

- Terminal event → normal completion (or `turn.failed` → Rule 5).
- `! kill -0 $pid` → codex died without emitting an event → Rule 5.
- `find -mmin +5` → log untouched 5+ min (silent stall — codex 0.130.0 can hang between `item.completed` events with no `turn.failed` ever emitted) → Rule 5 + SIGTERM.

Never `tail -F | grep -m1 …` — after match, `tail -F` blocks waiting for the next write; Monitor stays armed until wall-clock timeout.

On `READY`: inspect last log line. Terminal event → read `$final`. Otherwise → Rule 5 (rollout parse + resume). Never kill the codex PID unless the user asks (or the stale/dead condition fired).

## Cloud Recipe (xhigh, async)

```bash
codex cloud exec --env <ENV_ID> "<prompt>"
codex cloud status <task-id>
codex cloud diff   <task-id>
codex apply        <task-id>
```

## Worked Example

User: `codex review --base main --xhigh`
1. Rule 4 → scope = `review --base main`.
2. Rule 3 → `--xhigh` flag (whitelist) → effort = `xhigh`. Bare `xhigh` in prose would NOT promote.
3. Rule 2 → background + Monitor (or cloud, or terminal).
4. Spawn: `codex exec review --base main --json -c model_reasoning_effort=xhigh -o "$final" < /dev/null > "$log" 2>&1 &`
5. Monitor poll-loop, read `$final` on `READY`.
6. On kill/timeout: Rule 5.

## Resources

`references/`: `reasoning-effort.md`, `flag-reference.md`, `command-recipes.md`, `argument-mapping-examples.md`, `testing-scenarios.md`, `testing.md`.

## Checklist

- `codex` authed; `git status --short` run this turn.
- `codex exec` family used (Rule 1); xhigh never foreground (Rule 2).
- Effort = medium unless current-turn user text has whitelist token (Rule 3).
- Canonical suffix on every invocation.
- `thread_id` via `grep -m1 thread.started "$log" | jq -r '.thread_id'`.
- Bash `timeout` matches the effort table.
- On failure: Rule 5 (rollout parsed, partial + resume printed). Never kill background PID without ask.
