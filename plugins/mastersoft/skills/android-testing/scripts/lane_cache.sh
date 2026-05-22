#!/usr/bin/env bash
# lane_cache.sh — read/write/invalidate per-window sticky lane decisions.
#
# Why: diagnose_tree.py costs ~2s (one full uiautomator dump). Re-running it
# per action wastes time when the lane is stable. Cache the decision keyed
# by (package, activity); invalidate when the foreground changes.
#
# Storage: flat files under $TMPDIR/android-skill-state/. One file per
# package, content is `lane=A|B|C\nactivity=<top activity at probe time>`.
# No JSON; bash-readable.
#
# Subcommands:
#   get <pkg>           → prints "lane=X activity=Y" if cached, exit 0
#                         else exit 1 (not cached)
#   set <pkg> <lane> <activity>
#                       → stores entry, exit 0
#   invalidate <pkg>    → removes the entry, exit 0 (no-op if absent)
#   foreground          → prints current top resumed activity (helper)
#   stale-check <pkg>   → exit 0 if cache matches current foreground,
#                         exit 1 if foreground changed (cache stale)
#   clear-all           → removes all cached lanes
#   list                → prints all cached entries, one per line

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  lane_cache.sh get <pkg>
  lane_cache.sh set <pkg> <lane> <activity>
  lane_cache.sh invalidate <pkg>
  lane_cache.sh foreground [--serial S]
  lane_cache.sh stale-check <pkg> [--serial S]
  lane_cache.sh clear-all
  lane_cache.sh list

The cache lives under $TMPDIR/android-skill-state/lane-<pkg>; one file per
app. No JSON, no consent file. Re-probe via diagnose_tree.py is required
when stale-check returns non-zero.
EOF
}

STATE_DIR="${TMPDIR:-/tmp}/android-skill-state"
mkdir -p "$STATE_DIR"

# adb auto-discovery (only needed for foreground / stale-check).
find_adb() {
    if command -v adb >/dev/null 2>&1; then command -v adb; return 0; fi
    local cand
    for cand in \
        "${ANDROID_HOME:-}/platform-tools/adb" \
        "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
        "$HOME/Library/Android/sdk/platform-tools/adb" \
        "$HOME/Android/Sdk/platform-tools/adb" \
        "/opt/homebrew/bin/adb"
    do
        [[ -n "$cand" && -x "$cand" ]] && { echo "$cand"; return 0; }
    done
    return 1
}

resolve_serial() {
    local serial="${1:-}"
    if [[ -z "$serial" && -n "${ANDROID_SERIAL:-}" ]]; then
        serial="$ANDROID_SERIAL"
    fi
    if [[ -z "$serial" ]]; then
        local f="$STATE_DIR/serial"
        [[ -f "$f" ]] && serial="$(cat "$f")"
    fi
    echo "$serial"
}

cmd_get() {
    local pkg="$1"
    local f="$STATE_DIR/lane-$pkg"
    [[ -f "$f" ]] || return 1
    cat "$f"
}

cmd_set() {
    local pkg="$1" lane="$2" activity="$3"
    local f="$STATE_DIR/lane-$pkg"
    {
        echo "lane=$lane"
        echo "activity=$activity"
        echo "ts=$(date +%s)"
    } > "$f"
}

cmd_invalidate() {
    local pkg="$1"
    rm -f "$STATE_DIR/lane-$pkg"
}

cmd_foreground() {
    local serial
    serial="$(resolve_serial "${1:-}")"
    local adb
    adb="$(find_adb)" || { echo "lane_cache: adb not found" >&2; return 127; }
    local cmd=("$adb")
    [[ -n "$serial" ]] && cmd+=(-s "$serial")
    cmd+=(shell dumpsys activity activities)
    "${cmd[@]}" 2>/dev/null \
        | grep -E 'topResumedActivity' | head -1 \
        | sed -nE 's/.*ActivityRecord\{[^ ]+ [^ ]+ ([^ /]+)\/([^ }]+).*/\1\/\2/p'
}

cmd_stale_check() {
    local pkg="$1"
    local serial
    serial="$(resolve_serial "${2:-}")"

    local f="$STATE_DIR/lane-$pkg"
    [[ -f "$f" ]] || { echo "no-cache" >&2; return 1; }

    local cached_activity
    cached_activity=$(grep -E '^activity=' "$f" | head -1 | cut -d= -f2-)
    [[ -n "$cached_activity" ]] || { echo "cache-corrupt" >&2; return 1; }

    local current
    current=$(cmd_foreground "$serial")
    if [[ -z "$current" ]]; then
        echo "no-foreground" >&2
        return 1
    fi
    if [[ "$current" == "$pkg/$cached_activity" || "$current" == "$cached_activity" ]]; then
        return 0
    fi
    echo "stale: cached=$pkg/$cached_activity current=$current" >&2
    return 1
}

cmd_clear_all() {
    rm -f "$STATE_DIR"/lane-* 2>/dev/null || true
}

cmd_list() {
    for f in "$STATE_DIR"/lane-*; do
        [[ -f "$f" ]] || continue
        local pkg
        pkg=$(basename "$f" | sed 's/^lane-//')
        local lane activity
        lane=$(grep -E '^lane=' "$f" | head -1 | cut -d= -f2)
        activity=$(grep -E '^activity=' "$f" | head -1 | cut -d= -f2-)
        echo "pkg=$pkg lane=$lane activity=$activity"
    done
}

[[ $# -gt 0 ]] || { usage; exit 64; }
SUB="$1"; shift

case "$SUB" in
    get)         [[ $# -ge 1 ]] || { usage; exit 64; }; cmd_get "$1" ;;
    set)         [[ $# -ge 3 ]] || { usage; exit 64; }; cmd_set "$1" "$2" "$3" ;;
    invalidate)  [[ $# -ge 1 ]] || { usage; exit 64; }; cmd_invalidate "$1" ;;
    foreground)
        SERIAL=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --serial) SERIAL="$2"; shift 2 ;;
                *) echo "lane_cache: unknown arg: $1" >&2; exit 64 ;;
            esac
        done
        cmd_foreground "$SERIAL"
        ;;
    stale-check)
        [[ $# -ge 1 ]] || { usage; exit 64; }
        PKG="$1"; shift
        SERIAL=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --serial) SERIAL="$2"; shift 2 ;;
                *) echo "lane_cache: unknown arg: $1" >&2; exit 64 ;;
            esac
        done
        cmd_stale_check "$PKG" "$SERIAL"
        ;;
    clear-all)   cmd_clear_all ;;
    list)        cmd_list ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "lane_cache: unknown subcommand: $SUB" >&2; usage; exit 64 ;;
esac
