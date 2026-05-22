#!/usr/bin/env bash
# shellcheck disable=SC2012  # PNG filenames are controlled (timestamped frames); ls -t is portable BSD/GNU and avoids find-printf compat issues
# screen_ring.sh — capture a rolling buffer of Android screencaps to disk.
#
# Lane C primitive. Designed for HIL flows where:
#   - the action takes long (loading screens, network waits)
#   - the model can't tell when it's done from the accessibility tree alone
#   - we want screenshots available for review on demand, but only the few
#     frames around an event ever hit conversation context
#
# Capture every --interval seconds into --out-dir; evict by --max-age-min
# (primary contract) and --session-cap-mb (safety fuse). Intended to be
# launched with Bash run_in_background or via Monitor; foreground use also
# works for testing.
#
# File naming: <out-dir>/<host_epoch_ms>.png
#   The mtime equals the host capture time. ring_window.sh uses both to
#   correlate listener timestamps to frames.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  screen_ring.sh --out-dir <dir> [options]

Options:
  --serial <id>           adb device (defaults to ANDROID_SERIAL or session)
  --out-dir <dir>         REQUIRED. Per-session frame directory.
  --interval <sec>        Capture cadence in seconds (default 0.5 = 2 fps).
  --max-age-min <min>     Delete frames older than this (default 10).
  --session-cap-mb <mb>   Per-session disk cap; oldest evicted when exceeded
                            (default 1024 = 1 GB).
  --max-frames <n>        Hard cap on frame count (default 0 = no cap).
  --pin-window-ms <ms>    Don't evict frames within this window of "now"
                            (default 4000 = ±2s sticky around recent frames).
  --quiet                 Suppress eviction stderr noise.
  --max-duration <sec>    Self-terminate after N seconds (no GNU `timeout` needed).
  -h, --help              This help.

Stops on SIGINT/SIGTERM.
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
OUT_DIR=""
INTERVAL=0.5
MAX_AGE_MIN=10
SESSION_CAP_MB=1024
MAX_FRAMES=0
PIN_WINDOW_MS=4000
QUIET=0
MAX_DURATION=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        --out-dir) OUT_DIR="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --max-age-min) MAX_AGE_MIN="$2"; shift 2 ;;
        --session-cap-mb) SESSION_CAP_MB="$2"; shift 2 ;;
        --max-frames) MAX_FRAMES="$2"; shift 2 ;;
        --pin-window-ms) PIN_WINDOW_MS="$2"; shift 2 ;;
        --quiet) QUIET=1; shift ;;
        --max-duration) MAX_DURATION="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "screen_ring: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

[[ -n "$OUT_DIR" ]] || { echo "screen_ring: --out-dir required" >&2; usage; exit 64; }

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
ADB="$(find_adb)" || { echo "screen_ring: adb not found" >&2; exit 127; }

# Resolve serial via session file if not given.
if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB_CMD=("$ADB")
[[ -n "$SERIAL" ]] && ADB_CMD+=(-s "$SERIAL")

mkdir -p "$OUT_DIR"

trap 'echo "screen_ring: stopping" >&2; exit 0' INT TERM

# Self-kill timer if --max-duration > 0.
if [[ "$MAX_DURATION" != "0" ]]; then
    (
        sleep "$MAX_DURATION"
        echo "screen_ring: --max-duration ${MAX_DURATION}s elapsed; stopping" >&2
        kill -TERM $$
    ) &
fi

# Convert MB to bytes for comparison.
SESSION_CAP_BYTES=$(( SESSION_CAP_MB * 1024 * 1024 ))
PIN_WINDOW_S=$(( (PIN_WINDOW_MS + 999) / 1000 ))

now_ms() {
    python3 -c 'import time; print(int(time.time()*1000))'
}

du_bytes() {
    # macOS du -sk gives KB; convert.
    local kb
    kb=$(du -sk "$OUT_DIR" 2>/dev/null | awk '{print $1}')
    echo $(( kb * 1024 ))
}

evict_old() {
    # Age-primary: delete files with mtime older than $MAX_AGE_MIN.
    # find -mmin works on both BSD (macOS) and GNU find.
    local before
    before=$(ls "$OUT_DIR" 2>/dev/null | wc -l | tr -d ' ')
    find "$OUT_DIR" -name '*.png' -type f -mmin "+$MAX_AGE_MIN" \
        -not -newermt "${PIN_WINDOW_S} seconds ago" -delete 2>/dev/null || true
    if (( ! QUIET )); then
        local after
        after=$(ls "$OUT_DIR" 2>/dev/null | wc -l | tr -d ' ')
        local dropped=$(( before - after ))
        (( dropped > 0 )) && echo "screen_ring: aged out $dropped frame(s)" >&2
    fi
}

evict_size() {
    # Disk-cap safety fuse: evict oldest files until under SESSION_CAP_BYTES.
    # Skip files inside the pin-window (recent enough to be event-relevant).
    local size
    size=$(du_bytes)
    if (( size <= SESSION_CAP_BYTES )); then return 0; fi
    (( QUIET )) || echo "screen_ring: disk cap fired (${size} > ${SESSION_CAP_BYTES} bytes), evicting oldest" >&2
    # ls -t (newest first) reversed via tail-reverse pattern; keep deleting oldest.
    local pin_cutoff_s
    pin_cutoff_s=$(( $(date +%s) - PIN_WINDOW_S ))
    while (( $(du_bytes) > SESSION_CAP_BYTES )); do
        local oldest
        oldest=$(ls -t "$OUT_DIR"/*.png 2>/dev/null | tail -1)
        [[ -z "$oldest" || ! -f "$oldest" ]] && break
        # mtime in seconds (BSD stat). If file is in pin window, stop — we'd be
        # evicting active-flow frames, which defeats the purpose.
        local mtime
        mtime=$(stat -f %m "$oldest" 2>/dev/null || stat -c %Y "$oldest" 2>/dev/null || echo 0)
        if (( mtime > pin_cutoff_s )); then
            (( QUIET )) || echo "screen_ring: disk cap reached but oldest frame is in pin-window; flow may be too long for cap" >&2
            break
        fi
        rm -f "$oldest"
    done
}

evict_count() {
    [[ "$MAX_FRAMES" == "0" ]] && return 0
    local cnt
    cnt=$(ls "$OUT_DIR"/*.png 2>/dev/null | wc -l | tr -d ' ')
    while (( cnt > MAX_FRAMES )); do
        local oldest
        oldest=$(ls -t "$OUT_DIR"/*.png 2>/dev/null | tail -1)
        [[ -z "$oldest" || ! -f "$oldest" ]] && break
        rm -f "$oldest"
        cnt=$(( cnt - 1 ))
    done
}

EVICT_EVERY_N=10  # only evict every N frames to amortize the find/du cost
i=0

(( QUIET )) || echo "screen_ring: capturing every ${INTERVAL}s into $OUT_DIR" >&2

while :; do
    fname="$OUT_DIR/$(now_ms).png"
    "${ADB_CMD[@]}" exec-out screencap -p > "$fname" 2>/dev/null \
        || { (( QUIET )) || echo "screen_ring: screencap failed" >&2; }

    # File can be 0 bytes if device disconnected mid-capture; drop it.
    if [[ ! -s "$fname" ]]; then
        rm -f "$fname"
    fi

    i=$(( i + 1 ))
    if (( i % EVICT_EVERY_N == 0 )); then
        evict_old
        evict_size
        evict_count
    fi

    sleep "$INTERVAL"
done
