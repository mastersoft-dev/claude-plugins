#!/usr/bin/env bash
# state_listener.sh — Lane C composite listener for HIL flows.
#
# Watches for a "completion" signal from any of three sources:
#   1. logcat (--on-logcat REGEX)
#   2. foreground activity change (--on-activity REGEX matches new top
#      resumed activity)
#   3. uiautomator selector becoming visible (--on-selector SEL)
#
# On match, writes a structured event bundle to stdout AND --event-file:
#
#   EVENT host_epoch_ms=<ms> source=<logcat|activity|selector> detail=<...>
#
# On timeout (--timeout-sec, default 600 = 10min), writes a TIMEOUT bundle
# with the last 3 distinct frame paths (via ring_window.sh against
# --ring-dir if given), the current foreground activity, and a fresh
# ui_snapshot dump preview. Caller can then re-evaluate the lane.
#
# Designed to run in the background. With the Monitor tool, set
# `persistent: false` and rely on this script's --timeout-sec for the kill.
# With Bash run_in_background, the script exits on the first match or
# timeout.
#
# Filters use `grep --line-buffered -E` per Claude Code Monitor docs (else
# pipe buffering kills latency).

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  state_listener.sh [options] (at least one --on-* required)

Sources (any combination, OR-joined):
  --on-logcat REGEX        Match logcat line (extended regex via grep -E).
  --on-activity REGEX      Match new topResumedActivity (polled via dumpsys).
  --on-selector SEL        Match a uiautomator selector (e.g. text="Welcome").
  --on-pixel-delta R       Fire when the screen region R (X,Y,W,H or 'full')
                            changes hash from its initial value. Catches UI
                            changes invisible to logcat/activity/selector
                            (e.g. Compose state without log events). Heaviest
                            of the four sources — uses one screencap per poll.
                            Requires screen_hash.sh on PATH (always bundled).

Common options:
  --serial <id>           adb device (defaults to ANDROID_SERIAL or session).
  --pkg PKG               Restrict logcat to this package (recommended).
  --poll-sec N            Activity/selector poll interval (default 2).
  --timeout-sec N         Overall timeout (default 600 = 10 min).
  --event-file PATH       Write the EVENT/TIMEOUT bundle here (one line).
  --ring-dir PATH         If given, the TIMEOUT bundle includes the last 3
                            distinct frame paths via ring_window.sh.
  --bundle-out PATH       Write the full TIMEOUT diagnostic bundle (multi-line).
  -h, --help              This help.

Output: a single line on stdout, prefixed EVENT or TIMEOUT, with key=value
fields. Subsequent diagnostic detail (only for TIMEOUT) goes to --bundle-out
or stderr.

Exit codes:
  0 → matched (EVENT)
  124 → timed out (TIMEOUT)
  1 → setup error
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
PKG=""
ON_LOGCAT=""
ON_ACTIVITY=""
ON_SELECTOR=""
ON_PIXEL_DELTA=""
POLL_SEC=2
TIMEOUT_SEC=600
EVENT_FILE=""
RING_DIR=""
BUNDLE_OUT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        --pkg) PKG="$2"; shift 2 ;;
        --on-logcat) ON_LOGCAT="$2"; shift 2 ;;
        --on-activity) ON_ACTIVITY="$2"; shift 2 ;;
        --on-selector) ON_SELECTOR="$2"; shift 2 ;;
        --on-pixel-delta) ON_PIXEL_DELTA="$2"; shift 2 ;;
        --poll-sec) POLL_SEC="$2"; shift 2 ;;
        --timeout-sec) TIMEOUT_SEC="$2"; shift 2 ;;
        --event-file) EVENT_FILE="$2"; shift 2 ;;
        --ring-dir) RING_DIR="$2"; shift 2 ;;
        --bundle-out) BUNDLE_OUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "state_listener: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

if [[ -z "$ON_LOGCAT" && -z "$ON_ACTIVITY" && -z "$ON_SELECTOR" && -z "$ON_PIXEL_DELTA" ]]; then
    echo "state_listener: at least one --on-* source required" >&2
    usage
    exit 64
fi

# adb auto-discovery
find_adb() {
    if command -v adb >/dev/null 2>&1; then echo "adb"; return 0; fi
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
ADB="$(find_adb)" || { echo "state_listener: adb not found" >&2; exit 127; }

if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB_CMD=("$ADB")
[[ -n "$SERIAL" ]] && ADB_CMD+=(-s "$SERIAL")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_EPOCH=$(date +%s)
DEADLINE=$(( START_EPOCH + TIMEOUT_SEC ))

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

emit_event() {
    local source="$1" detail="$2"
    local ms
    ms=$(now_ms)
    local line="EVENT host_epoch_ms=$ms source=$source detail=$detail"
    printf '%s\n' "$line"
    [[ -n "$EVENT_FILE" ]] && printf '%s\n' "$line" >"$EVENT_FILE"
    cleanup_children
    exit 0
}

emit_timeout() {
    local ms
    ms=$(now_ms)
    local line
    line="TIMEOUT host_epoch_ms=$ms timeout_sec=$TIMEOUT_SEC waited_for=$(printf '%s|%s|%s|pixel=%s' "$ON_LOGCAT" "$ON_ACTIVITY" "$ON_SELECTOR" "$ON_PIXEL_DELTA")"
    printf '%s\n' "$line"
    [[ -n "$EVENT_FILE" ]] && printf '%s\n' "$line" >"$EVENT_FILE"

    # Build the full diagnostic bundle: foreground, fresh dump preview,
    # last 3 frame paths if a ring is given.
    local out_target="${BUNDLE_OUT:-/dev/stderr}"
    {
        echo "==== state_listener TIMEOUT bundle ===="
        echo "host_epoch_ms=$ms"
        echo "waited_logcat=$ON_LOGCAT"
        echo "waited_activity=$ON_ACTIVITY"
        echo "waited_selector=$ON_SELECTOR"
        echo "waited_pixel_delta=$ON_PIXEL_DELTA"
        echo
        echo "-- foreground --"
        "${ADB_CMD[@]}" shell dumpsys activity activities 2>/dev/null \
            | grep -E 'topResumedActivity|ResumedActivity' | head -2 \
            || echo "(unavailable)"
        echo
        echo "-- fresh ui_snapshot (top 15 lines) --"
        ANDROID_SERIAL="$SERIAL" python3 "$SCRIPT_DIR/ui_snapshot.py" --max-lines 15 2>/dev/null \
            || echo "(snapshot failed)"
        echo
        if [[ -n "$RING_DIR" && -d "$RING_DIR" ]]; then
            echo "-- last 3 frame paths (most recent first) --"
            # shellcheck disable=SC2012  # filenames are controlled (timestamped PNGs); ls -t is portable across BSD/GNU
            ls -t "$RING_DIR"/*.png 2>/dev/null | head -3
        fi
        echo "==== end TIMEOUT bundle ===="
    } >"$out_target" 2>/dev/null || true

    cleanup_children
    exit 124
}

# Background watchers — each writes to a fifo; main loop multiplexes.
WATCH_DIR="$(mktemp -d -t state_listener.XXXXXX)"
LOGCAT_PID=""
ACTIVITY_PID=""
SELECTOR_PID=""
PIXEL_PID=""

cleanup_children() {
    [[ -n "$LOGCAT_PID" ]] && kill "$LOGCAT_PID" 2>/dev/null || true
    [[ -n "$ACTIVITY_PID" ]] && kill "$ACTIVITY_PID" 2>/dev/null || true
    [[ -n "$SELECTOR_PID" ]] && kill "$SELECTOR_PID" 2>/dev/null || true
    [[ -n "$PIXEL_PID" ]] && kill "$PIXEL_PID" 2>/dev/null || true
    rm -rf "$WATCH_DIR" 2>/dev/null || true
}
trap 'cleanup_children' EXIT INT TERM

# 1. Logcat watcher
if [[ -n "$ON_LOGCAT" ]]; then
    (
        if [[ -n "$PKG" ]]; then
            PIDS="$("${ADB_CMD[@]}" shell pidof "$PKG" 2>/dev/null | tr -s '[:space:]' ' ')"
            for pid in $PIDS; do
                "${ADB_CMD[@]}" logcat --pid="$pid" -v time 2>/dev/null &
            done
            "${ADB_CMD[@]}" logcat -v time AndroidRuntime:E ActivityManager:I '*:S' 2>/dev/null &
            wait
        else
            "${ADB_CMD[@]}" logcat -v time 2>/dev/null
        fi
    ) | grep --line-buffered -E "$ON_LOGCAT" | while IFS= read -r line; do
        echo "logcat:$line" > "$WATCH_DIR/event"
        break
    done &
    LOGCAT_PID=$!
fi

# 2. Activity watcher (polled)
if [[ -n "$ON_ACTIVITY" ]]; then
    (
        while :; do
            top=$("${ADB_CMD[@]}" shell dumpsys activity activities 2>/dev/null \
                  | grep topResumedActivity | head -1)
            if echo "$top" | grep --line-buffered -E "$ON_ACTIVITY" >/dev/null; then
                echo "activity:$top" > "$WATCH_DIR/event"
                break
            fi
            sleep "$POLL_SEC"
        done
    ) &
    ACTIVITY_PID=$!
fi

# 3. Selector watcher (polls ui_snapshot --query)
if [[ -n "$ON_SELECTOR" ]]; then
    (
        while :; do
            out=$(ANDROID_SERIAL="$SERIAL" python3 "$SCRIPT_DIR/ui_snapshot.py" --query "$ON_SELECTOR" --max-lines 1 2>/dev/null)
            if [[ -n "$out" ]]; then
                echo "selector:$out" > "$WATCH_DIR/event"
                break
            fi
            sleep "$POLL_SEC"
        done
    ) &
    SELECTOR_PID=$!
fi

# 4. Pixel-delta watcher — captures initial hash of region, fires when hash
# changes. Region "full" hashes the whole screen. Heaviest of the four —
# uses one screencap per poll, so we use the configured POLL_SEC interval.
if [[ -n "$ON_PIXEL_DELTA" ]]; then
    (
        REGION_ARGS=()
        if [[ "$ON_PIXEL_DELTA" != "full" ]]; then
            REGION_ARGS=(--region "$ON_PIXEL_DELTA")
        fi
        # Initial hash. If the first screencap fails, retry until the device
        # is reachable rather than dying immediately.
        INITIAL=""
        for _ in 1 2 3 4 5; do
            INITIAL=$(ANDROID_SERIAL="$SERIAL" "$SCRIPT_DIR/screen_hash.sh" "${REGION_ARGS[@]}" 2>/dev/null) && [[ -n "$INITIAL" ]] && break
            sleep "$POLL_SEC"
        done
        if [[ -z "$INITIAL" ]]; then
            echo "pixel:initial_capture_failed" > "$WATCH_DIR/event"
            exit 0
        fi
        while :; do
            sleep "$POLL_SEC"
            CUR=$(ANDROID_SERIAL="$SERIAL" "$SCRIPT_DIR/screen_hash.sh" "${REGION_ARGS[@]}" 2>/dev/null) || continue
            if [[ -n "$CUR" && "$CUR" != "$INITIAL" ]]; then
                echo "pixel:region=$ON_PIXEL_DELTA initial=${INITIAL:0:12} current=${CUR:0:12}" > "$WATCH_DIR/event"
                break
            fi
        done
    ) &
    PIXEL_PID=$!
fi

# Main loop: wait for either a child to write the event file or the deadline.
while :; do
    if [[ -s "$WATCH_DIR/event" ]]; then
        line=$(head -1 "$WATCH_DIR/event")
        source="${line%%:*}"
        detail="${line#*:}"
        emit_event "$source" "$detail"
    fi
    now=$(date +%s)
    if (( now >= DEADLINE )); then
        emit_timeout
    fi
    sleep 1
done
