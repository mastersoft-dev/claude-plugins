#!/usr/bin/env bash
# no-raw-screencap.sh — PreToolUse hook for the android-testing skill.
#
# Scoped to the skill's lifecycle (only fires while the skill is active),
# this hook DENIES the launder pattern the LLM falls into when it's
# uncertain about screen state:
#
#   1. `adb shell screencap -p /sdcard/cur.png`
#   2. `adb pull /sdcard/cur.png /tmp/cur.png`
#   3. `Read(/tmp/cur.png)`     ← burns 25-50 K tokens of context
#
# Earlier iterations tried softer interventions: prose in SKILL.md,
# inline runtime hints from `ui_snapshot.py` and `describe`, a
# PostToolUse `additionalContext` coaching hook. All of them failed
# empirically — the LLM still reaches for screencap on the first
# uncertain step. The mental model has `screencap → Read` burned in
# as the universal "I don't know what's on screen" hammer. Hard deny
# is the only intervention that actually changes the next action.
#
# Override: `ANDROID_SKILL_ALLOW_RAW_SCREENCAP=1` for genuine pre-flow
# manual capture or composition the daemon's BG trace would miss
# (e.g. capturing the splash screen before the daemon boots).
#
# Reads the PreToolUse JSON event from stdin and emits a JSON response.
# Exit 0 + no body = allow. Exit 0 + JSON body with permissionDecision
# = decision applied.

set -euo pipefail

if [[ "${ANDROID_SKILL_ALLOW_RAW_SCREENCAP:-0}" == "1" ]]; then
    exit 0
fi

INPUT="$(cat 2>/dev/null || true)"
if [[ -z "$INPUT" ]]; then
    exit 0
fi

if command -v jq >/dev/null 2>&1; then
    TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
    CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")"
else
    TOOL="Bash"
    CMD="$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi

if [[ "$TOOL" != "Bash" ]] || [[ -z "$CMD" ]]; then
    exit 0
fi

DENY=0

# Pattern 1: `adb [-s X] (shell|exec-out) screencap` — manual frame
# capture. Includes both `> file.png` redirects and bare invocations
# that pipe into a host-side file write.
if echo "$CMD" | grep -qE '\badb\b([[:space:]]+-[sePH][[:space:]]+[^[:space:]]+)*[[:space:]]+(shell|exec-out)[[:space:]]+screencap\b'; then
    DENY=1
fi

# Pattern 2: `adb pull <path>.{png,jpg,jpeg}` — second half of the
# `screencap > /sdcard/foo && adb pull /sdcard/foo` launder. Even if
# step 1 sneaks through, pulling the frame back is what generates the
# Read target and worth blocking on its own.
if echo "$CMD" | grep -qiE '\badb\b([[:space:]]+-[sePH][[:space:]]+[^[:space:]]+)*[[:space:]]+pull\b[^|;&]*\.(png|jpe?g)\b'; then
    DENY=1
fi

if [[ $DENY -eq 0 ]]; then
    exit 0
fi

REASON="Image avoided — the accessibility tree IS the observation channel.

WRONG (this is what was just attempted):
  • adb shell screencap -p /sdcard/x.png && adb pull /sdcard/x.png /tmp/x.png && Read(/tmp/x.png)
  → ~25-50 K tokens for a question the tree answers in ~100 bytes.

RIGHT — use one of these:
  • {\"op\":\"describe\",\"args\":{\"selectors\":[\"<sel you expect>\"]}}    — \"is X on screen?\" (returns nearby[] on miss)
  • ui_snapshot.py --serial \$SERIAL --max-lines 200                       — \"what's on this screen?\"
  • {\"op\":\"window_sig\",\"args\":{}}                                      — \"did anything change?\"

Tree thin (only \`[u1] id=content\`)? You are likely mid-transition (Compose accessibility lag) or on a non-semantic surface (Canvas, ExoPlayer):
  • Compose lag → use \`wait_for: [\"<expected next-screen anchor>\"]\` on the prior tap. Tree returns the anchor the moment recomposition completes (~500 ms).
  • Non-semantic surface (screensaver, splash, video) → \`tap_point\` with known coords + \`wait_for\` an anchor on the NEXT screen. Or \`KEYCODE_BACK\` / \`KEYCODE_HOME\` to escape.
  • NEVER \`wait_stable_ms\` blind on a transition — empty dumps may appear stable but tell you nothing.

Need a real frame for forensics? \`ui_run_flow.py\` BG-traces every mutation. On flow failure the rc != 0 stderr line prints the trace dir + trace.jsonl index — read those instead of capturing fresh.

Override only when explicitly post-morteming pre-flow state (splash, before daemon boot, manual repro):

  ANDROID_SKILL_ALLOW_RAW_SCREENCAP=1   (export, then retry)

See SKILL.md step 4 + references/failure-modes.md §13 (\"Tree returns only id=content after a transition\")."

if command -v jq >/dev/null 2>&1; then
    jq -nc --arg r "$REASON" '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $r
        }
    }'
else
    ESC_REASON="$(printf '%s' "$REASON" | tr '\n' ' ' | sed 's/"/\\"/g')"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESC_REASON"
fi
exit 0
