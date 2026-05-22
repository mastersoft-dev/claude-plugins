# Troubleshooting

## Skill doesn't trigger

**Symptom:** `codex` is not selected for CLI execution requests.
**Cause:** Prompt sounds like a direct local edit request.
**Solution:** Use explicit CLI intent:
- "Run `codex review` on uncommitted changes."
- "Use Codex CLI to execute this prompt."
- "Run `codex cloud exec --env ...`."

## Skill triggers too often

**Symptom:** `codex` activates for simple local edits.
**Cause:** Prompt mentions AI-assisted coding without CLI orchestration need.
**Solution:** Add anti-triggers:
- "Edit this file directly."
- "Fix this typo locally."
- "Do not run Codex CLI."

## Codex command fails to start

**Symptom:** Non-zero exit immediately or hang on launch.
**Cause:** Missing install, expired auth, wrong flag placement, missing `--skip-git-repo-check` outside a repo.
**Solution:**
1. `command -v codex` and `codex login`.
2. Top-level flags (none for `exec`) must precede the subcommand.
3. Add `--skip-git-repo-check` if cwd isn't a git tree.

## Run killed mid-flight ("hung then killed")

**Symptom:** Codex was clearly running, then nothing returned.
**Cause:** Bash tool's 600 000 ms hard cap fired (xhigh frequently exceeds it), OR the parent Claude Code session was interrupted/resumed and orphaned the subprocess.
**Solution:** Apply Hard Rule 5:
1. `rollout=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)`
2. `uuid=$(jq -r 'select(.type=="session_meta") | .payload.id' "$rollout" | head -1)`
3. `jq -r 'select(.payload.type=="agent_message") | .payload.message' "$rollout" | tail -1` — partial output.
4. Surface `codex exec resume $uuid --json -c model_reasoning_effort=<level> -o "$final" "continue and emit the final result" < /dev/null > "$log" 2>&1` to the user. `-c model_reasoning_effort` is mandatory (Rule 3).

Never report a bare "killed" without these.

## Silent hang with no `thread.started`

**Symptom:** `codex exec` returns nothing. No JSONL events in `$log`. No final in `$final`. Bash tool eventually kills it on timeout.
**Cause:** Codex CLI blocks on stdin read when invoked from a non-TTY parent that leaves stdin open (heredoc, piped prompt, nested shell). No progress event ever appears because codex hasn't started — it's still waiting for input.
**Solution:** Append `< /dev/null` to every codex invocation. Closes stdin at exec time. Mandatory on both foreground and background recipes (background is the worst case — Monitor will wait its full budget for an event that can never come).

## Silent stall between items (event flow stops mid-run)

**Symptom:** `thread.started` + several `item.completed` events fired, then the log stops growing. Process stays alive (`ps` shows low CPU, sleeping state). No `turn.completed` / `turn.failed` / `error` ever lands. Field-confirmed on codex-cli 0.130.0 — process idle 10+ min after `item.completed`, 0.71s CPU used total.
**Cause:** Suspected Responses API stall or rate-limit not propagated as a JSONL event. Codex CLI bug — error path missing for this class of remote stall.
**Solution:** Background Monitor must use three exit conditions, not just terminal-sentinel grep:
```bash
until grep -qE '^\{"type":"turn\.(completed|failed)"|^\{"type":"error"' "$log" 2>/dev/null \
   || ! kill -0 "$pid" 2>/dev/null \
   || [ -n "$(find "$log" -mmin +5 -print 2>/dev/null)" ]; do
  sleep 2
done
echo READY
```
On `READY` with no terminal event in the log: SIGTERM the PID, parse rollout via Rule 5, surface partial + resume invocation.

## `--full-auto` / `--ask-for-approval` rejected

**Cause:** `--ask-for-approval` is `codex` top-level-only and rejected by `codex exec`. `--full-auto` IS accepted by `codex exec` (deprecated alias for `--sandbox workspace-write`) but emits a warning — prefer the explicit form so logs stay clean.
**Solution:** `--sandbox workspace-write -c approval_policy=never` for unattended writes, or `--dangerously-bypass-approvals-and-sandbox` inside an external sandbox.

## Effort silently bumped

**Cause:** Adjectives in the prompt body (`uncompromising`, `production-grade`, `thorough`) were treated as effort signals.
**Solution:** Hard Rule 3 — only the closed keyword whitelist promotes effort. Adjectives ignored.

# Test Protocols

## 1. Triggering tests

**Should trigger:**
- "Run `codex review` on uncommitted changes."
- "Use Codex CLI to execute this prompt."
- "Run `codex cloud exec --env ...`."

**Should NOT trigger:**
- "Edit this file directly."
- "Fix this typo locally."

## 2. Functional tests

See `references/testing-scenarios.md` for the five Hard Rule scenarios and baseline comparison.

# Success criteria

- Triggering accuracy: ≥ 90% true positives, ≤ 10% false positives.
- Hard Rule compliance: 100% on Rules 1, 3, 4, 5; Rule 2 must never be violated.
- Reliability: install/auth/config errors surfaced clearly.
- Efficiency: standard workflows complete in ≤ 5 turns.
