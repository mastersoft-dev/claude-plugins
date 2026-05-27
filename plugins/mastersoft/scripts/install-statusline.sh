#!/bin/sh
# Install the mastersoft statusline wrapper.
#
# Wrapper at ~/.claude/mastersoft-statusline-wrapper.js mediates statusline:
#   1. Reads ~/.claude/statusline.local.json {command: "..."} (override slot)
#   2. Reads ~/.claude/settings.json statusLine.command (skips self-references)
#   3. Falls back to latest mastersoft statusline.js in plugin cache
#
# Use this script to bootstrap manually. On every session start the plugin's
# SessionStart hook also refreshes the wrapper file from the installed plugin
# version, so this script is only required for first-time setup before the
# plugin is loaded.
#
# Flags:
#   --apply        Patch ~/.claude/settings.json with the statusLine block
#                  automatically (requires jq). Atomic write via temp file.
#                  Skipped if a statusLine entry already exists; use
#                  ~/.claude/statusline.local.json to override in that case.
#   --dry-run      (default) Copy wrapper + print the JSON to paste manually.
#   -h, --help     Show this help.
#
# Idempotent. Re-run anytime.

set -eu

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      printf '\033[31m✗\033[0m unknown arg: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
  PLUGIN_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
fi

if [ -z "${HOME:-}" ]; then
  printf '\033[31m✗\033[0m HOME is unset; cannot locate ~/.claude/\n' >&2
  exit 1
fi

SRC="$PLUGIN_ROOT/hooks/statusline-wrapper.js"
DST="$HOME/.claude/mastersoft-statusline-wrapper.js"
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SRC" ]; then
  printf '\033[31m✗\033[0m wrapper source not found at %s\n' "$SRC" >&2
  exit 1
fi

mkdir -p "$HOME/.claude"
cp "$SRC" "$DST"
printf '\033[32m✓\033[0m wrapper installed at %s\n' "$DST"

STATUSLINE_BLOCK='{"type":"command","command":"node ~/.claude/mastersoft-statusline-wrapper.js","padding":0}'

case "$MODE" in
  apply)
    if ! command -v jq >/dev/null 2>&1; then
      printf '\033[31m✗\033[0m --apply requires jq. Install jq or use the default dry-run.\n' >&2
      exit 1
    fi
    if [ ! -f "$SETTINGS" ]; then
      printf '{}\n' > "$SETTINGS"
      printf '\033[33m·\033[0m created empty %s\n' "$SETTINGS"
    fi
    # Validate that settings.json is parseable BEFORE attempting to read or
    # patch it. Trying to recover from a malformed file silently would either
    # mask the user's broken state or corrupt it further.
    if ! jq empty "$SETTINGS" >/dev/null 2>&1; then
      printf '\033[31m✗\033[0m %s is not valid JSON. Fix it by hand, then re-run --apply.\n' "$SETTINGS" >&2
      exit 1
    fi
    # Detect existing statusLine.command — skip if already mastersoft.
    EXISTING=$(jq -r '.statusLine.command // ""' "$SETTINGS")
    case "$EXISTING" in
      *mastersoft-statusline-wrapper.js*)
        printf '\033[32m✓\033[0m statusLine already wired to mastersoft wrapper. Nothing to do.\n'
        exit 0
        ;;
      "")
        TMP=$(mktemp "${SETTINGS}.XXXXXX")
        # Clean up the temp file on any error path until we successfully rename.
        trap 'rm -f "$TMP"' EXIT
        jq --argjson sl "$STATUSLINE_BLOCK" '. + {statusLine: $sl}' "$SETTINGS" > "$TMP"
        mv "$TMP" "$SETTINGS"
        trap - EXIT
        printf '\033[32m✓\033[0m statusLine block written to %s\n' "$SETTINGS"
        printf '   Run /reload-plugins or restart Claude Code to pick up.\n'
        ;;
      *)
        printf '\033[33m·\033[0m statusLine already set to a non-mastersoft command:\n'
        printf '     %s\n' "$EXISTING"
        printf '   Refusing to overwrite. To use mastersoft alongside your custom one,\n'
        printf '   create ~/.claude/statusline.local.json with {"command":"..."} to override at\n'
        printf '   runtime via the wrapper, or edit ~/.claude/settings.json by hand.\n'
        exit 0
        ;;
    esac
    ;;
  dry-run)
    echo
    echo 'Add this block to ~/.claude/settings.json (or managed-settings.json):'
    echo
    cat <<'JSON_EOF'
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/mastersoft-statusline-wrapper.js",
    "padding": 0
  }
JSON_EOF
    echo
    echo 'Or re-run with --apply to patch ~/.claude/settings.json directly (needs jq).'
    echo
    echo 'To override with your own statusLine, either:'
    echo '  - Edit ~/.claude/settings.json statusLine.command (works only if no managed-settings.json)'
    echo '  - OR create ~/.claude/statusline.local.json with {"command":"..."}'
    echo
    echo 'Reload: /reload-plugins (or restart Claude Code).'
    ;;
esac
