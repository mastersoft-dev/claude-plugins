#!/usr/bin/env bash
# cleanup.sh — sweep stale state from $TMPDIR/android-skill-*/.
#
# Called at session start (by device_pick.sh) and on demand. Cheap; idempotent.
#
# What gets cleaned:
#   - $TMPDIR/android-skill-state/lane-*  : entries with ts=<epoch> older than
#                                           --lane-max-age-min (default 30)
#   - $TMPDIR/android-skill-*.xml         : XML caches older than
#                                           --xml-max-age-min (default 60)
#   - $TMPDIR/android-skill-ring/<sess>/  : whole session dirs whose newest
#                                           frame is older than
#                                           --ring-max-age-min (default 60)
#   - $TMPDIR/android-skill-event-*       : event files older than 1 hour
#   - $TMPDIR/android-skill-bundle-*      : bundle files older than 1 hour
#   - $TMPDIR/screen_hash.*.png           : leftover screencaps (always)
#
# Per-script eviction is still active (screen_ring.sh handles its own ring),
# this sweeper is the safety net for orphaned data when scripts crash or
# shells don't trap.
#
# Use --dry-run to print what would be removed without removing.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  cleanup.sh [options]

Options:
  --lane-max-age-min N   Stale lane-cache age (default 30)
  --xml-max-age-min N    Stale XML-cache age (default 60)
  --ring-max-age-min N   Orphan ring-dir age (default 60)
  --dry-run              List paths only, don't delete
  --quiet                Suppress per-removal stderr
  -h, --help             This help
EOF
}

LANE_MAX_AGE_MIN=30
XML_MAX_AGE_MIN=60
RING_MAX_AGE_MIN=60
DRY_RUN=0
QUIET=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --lane-max-age-min) LANE_MAX_AGE_MIN="$2"; shift 2 ;;
        --xml-max-age-min) XML_MAX_AGE_MIN="$2"; shift 2 ;;
        --ring-max-age-min) RING_MAX_AGE_MIN="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --quiet) QUIET=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "cleanup: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

TMP="${TMPDIR:-/tmp}"

remove_or_say() {
    local path="$1"
    if (( DRY_RUN )); then
        echo "would remove: $path"
        return
    fi
    rm -rf "$path" 2>/dev/null || true
    (( QUIET )) || echo "cleanup: removed $path" >&2
}

# --- lane cache: prune by ts= header age ---
STATE_DIR="$TMP/android-skill-state"
if [[ -d "$STATE_DIR" ]]; then
    NOW=$(date +%s)
    THRESH=$(( NOW - LANE_MAX_AGE_MIN * 60 ))
    for f in "$STATE_DIR"/lane-*; do
        [[ -f "$f" ]] || continue
        ts=$(grep -E '^ts=' "$f" 2>/dev/null | head -1 | cut -d= -f2)
        if [[ -z "$ts" ]] || [[ ! "$ts" =~ ^[0-9]+$ ]]; then
            # No ts: fall back to file mtime.
            ts=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
        fi
        if (( ts < THRESH )); then
            remove_or_say "$f"
        fi
    done
fi

# --- xml caches: $TMPDIR/android-skill-*.xml older than X min ---
find "$TMP" -maxdepth 1 -name 'android-skill-*.xml' -type f -mmin "+$XML_MAX_AGE_MIN" 2>/dev/null \
    | while IFS= read -r f; do remove_or_say "$f"; done

# --- ring dirs: orphan sessions where newest frame is older than X min ---
RING_BASE="$TMP/android-skill-ring"
if [[ -d "$RING_BASE" ]]; then
    for dir in "$RING_BASE"/*; do
        [[ -d "$dir" ]] || continue
        # Find the newest .png mtime in the dir.
        newest=$(find "$dir" -name '*.png' -type f -print0 2>/dev/null \
                 | xargs -0 stat -f %m 2>/dev/null \
                 | sort -n | tail -1)
        if [[ -z "$newest" ]]; then
            # Empty dir — remove.
            remove_or_say "$dir"
            continue
        fi
        age_min=$(( ( $(date +%s) - newest ) / 60 ))
        if (( age_min > RING_MAX_AGE_MIN )); then
            remove_or_say "$dir"
        fi
    done
fi

# --- event/bundle files: anything older than 1 hour ---
find "$TMP" -maxdepth 1 -name 'android-skill-event*' -type f -mmin +60 2>/dev/null \
    | while IFS= read -r f; do remove_or_say "$f"; done
find "$TMP" -maxdepth 1 -name 'android-skill-bundle*' -type f -mmin +60 2>/dev/null \
    | while IFS= read -r f; do remove_or_say "$f"; done

# --- screen_hash temp files: always remove ---
find "$TMP" -maxdepth 1 -name 'screen_hash.*' -type f -mmin +5 2>/dev/null \
    | while IFS= read -r f; do remove_or_say "$f"; done

(( QUIET )) || echo "cleanup: done" >&2
