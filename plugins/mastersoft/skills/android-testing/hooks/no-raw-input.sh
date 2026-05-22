#!/usr/bin/env bash
# no-raw-input.sh — PreToolUse hook for the android-testing skill.
#
# Scoped to the skill's lifecycle (only fires while the skill is active),
# this hook intercepts Bash calls and DENIES the precise anti-pattern of
# raw `adb shell input tap|swipe|text` invocations. The skill ships a
# faster, more reliable batch path (`ui_run_flow.py`) that the LLM should
# reach for instead. The hook's denial message points at the right op so
# the LLM can self-correct without further prompting.
#
# Semantically precise — only fires on the three input subcommands that
# have a direct one-to-one daemon op (tap → tap_point/tap, swipe → swipe,
# text → type). KEYCODE events stay allowed: `adb shell input keyevent`
# is still legitimate for KEYCODE_BACK / KEYCODE_HOME during recovery.
#
# Reads the PreToolUse JSON event from stdin and emits a JSON response.
# Exit 0 + no body = allow. Exit 0 + JSON body with permissionDecision
# = decision applied.

set -euo pipefail

# Read stdin without crashing if the harness sends nothing for some reason.
INPUT="$(cat 2>/dev/null || true)"

if [[ -z "$INPUT" ]]; then
    exit 0
fi

# Tool name + Bash command. `jq` is broadly available on macOS via brew /
# Homebrew but may not be on every host. Fall back to grep when missing —
# the hook must never crash the harness.
if command -v jq >/dev/null 2>&1; then
    TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")"
    CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")"
else
    # Crude fallback: rely on the JSON shape to extract the command field.
    TOOL="Bash"
    CMD="$(printf '%s' "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi

if [[ "$TOOL" != "Bash" ]] || [[ -z "$CMD" ]]; then
    exit 0
fi

# Pattern match: `adb [-s X] shell input <subcmd>` where subcmd is one
# of the three with a daemon equivalent. Allow `keyevent` (BACK/HOME).
# Allow indirect uses where `input` appears inside a command we did not
# write (e.g., `grep input`) — the regex requires `shell input` adjacency.
if echo "$CMD" | grep -qE '\badb\b([[:space:]]+-[sePH][[:space:]]+[^[:space:]]+)*[[:space:]]+(shell|exec-out)[[:space:]]+input[[:space:]]+(tap|swipe|text)\b'; then
    REASON="The android-testing skill ships ui_run_flow.py with daemon ops that replace this exact call. Use one of:
  • {\"op\":\"tap_point\",\"args\":{\"x\":X,\"y\":Y}}     instead of  adb shell input tap X Y
  • {\"op\":\"swipe\",\"args\":{\"x1\":..,\"y1\":..,\"x2\":..,\"y2\":..,\"duration_ms\":..}}  instead of  adb shell input swipe ...
  • {\"op\":\"type\",\"args\":{\"target\":\"<sel>\",\"text\":\"...\"}}     instead of  adb shell input text ...

Wrap the next several actions in ONE ui_run_flow.py --stdin batch with wait_for chained between ops. Pre-flight with --require-anchor 'desc=\"<expected anchor>\"'. See SKILL.md → DO THIS by default + references/execution-mode.md."

    # PreToolUse deny shape per Claude Code hooks docs.
    if command -v jq >/dev/null 2>&1; then
        jq -nc --arg r "$REASON" '{
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: $r
            }
        }'
    else
        # Hand-formed JSON — keep the message single-line so we don't have
        # to escape newlines.
        ESC_REASON="$(printf '%s' "$REASON" | tr '\n' ' ' | sed 's/"/\\"/g')"
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESC_REASON"
    fi
    exit 0
fi

exit 0
