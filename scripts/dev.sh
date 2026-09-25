#!/bin/sh
# Run Claude Code on this working copy of the mastersoft plugin.
#
# Managed settings lock the plugin name "mastersoft", so Claude Code ignores a
# --plugin-dir copy with that name. This script syncs plugins/mastersoft into
# $MASTERSOFT_DEV_DIR (default: $TMPDIR/mastersoft-dev), renames the manifest
# to "mastersoft-dev" and starts claude with --plugin-dir on that copy. Skills
# show up as /mastersoft-dev:<name>. Every argument is passed through to claude.
#
# Usage:
#   scripts/dev.sh [claude args...]
#   scripts/dev.sh -p "/mastersoft-dev:help"
set -eu

DEV_NAME=mastersoft-dev
MARKER=.mastersoft-dev-copy
REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="$REPO_ROOT/plugins/mastersoft"
TARGET="${MASTERSOFT_DEV_DIR:-${TMPDIR:-/tmp}/$DEV_NAME}"

for tool in rsync node claude; do
  command -v "$tool" >/dev/null 2>&1 || { echo "dev.sh: $tool not found in PATH; install it, or add the directory that holds it to PATH" >&2; exit 1; }
done

if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET")" ] && [ ! -f "$TARGET/$MARKER" ]; then
  echo "dev.sh: $TARGET is not empty and was not created by dev.sh; set MASTERSOFT_DEV_DIR to another path" >&2
  exit 1
fi

mkdir -p "$TARGET"
touch "$TARGET/$MARKER"
rsync -a --delete \
  --exclude "$MARKER" --exclude .DS_Store --exclude __pycache__ --exclude .mypy_cache --exclude tests \
  "$SOURCE/" "$TARGET/"

node -e '
const fs = require("fs");
const [file, name] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.name = name;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$TARGET/.claude-plugin/plugin.json" "$DEV_NAME"

echo "dev.sh: $SOURCE -> $TARGET as $DEV_NAME" >&2
exec claude --plugin-dir "$TARGET" "$@"
