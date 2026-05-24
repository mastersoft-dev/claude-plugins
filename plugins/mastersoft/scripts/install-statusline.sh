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
# Idempotent. Re-run anytime.

set -eu

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
  PLUGIN_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
fi

SRC="$PLUGIN_ROOT/hooks/statusline-wrapper.js"
DST="$HOME/.claude/mastersoft-statusline-wrapper.js"

if [ ! -f "$SRC" ]; then
  printf '\033[31m✗\033[0m wrapper source not found at %s\n' "$SRC" >&2
  exit 1
fi

mkdir -p "$HOME/.claude"
cp "$SRC" "$DST"

printf '\033[32m✓\033[0m wrapper installed at %s\n' "$DST"
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
echo 'To override with your own statusLine, either:'
echo '  - Edit ~/.claude/settings.json statusLine.command (works only if no managed-settings.json)'
echo '  - OR create ~/.claude/statusline.local.json with {"command":"..."}'
echo
echo 'Reload: /reload-plugins (or restart Claude Code).'
