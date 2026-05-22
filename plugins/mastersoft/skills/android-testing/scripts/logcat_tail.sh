#!/usr/bin/env bash
# logcat_tail.sh — package-aware, restart-safe logcat tailer with optional crash summary.
#
# Why not `adb logcat --pid=$(pidof X)`? Three reasons:
#   1. App restarts (or crash-then-relaunch) change the PID; `--pid` keeps
#      tailing a dead PID.
#   2. Some packages run multiple processes (services, isolated, WebView).
#      `pidof` may return more than one PID.
#   3. Crashes are often logged from system processes (`AndroidRuntime`,
#      `ActivityManager`, `DEBUG`) outside the app's own PID.
#
# This script:
#   * Resolves all PIDs for the package every $POLL seconds (default 2).
#   * Spawns one `adb logcat --pid=<pid>` per known PID; prefixes lines with
#     the PID; drops tailers when the PID dies; spawns new ones on restart.
#   * Always also runs a system-tag watcher restricted to crash-relevant tags.
#   * Optional `--summarize-crashes` post-processes the captured stream and
#     emits a compact crash summary on stop.
#   * Optional `--until <regex>` stops the tail when a matching line is seen.
#
# Output: streamed to stdout (or to --output FILE if given).

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  logcat_tail.sh --pkg <package> [options]

Options:
  --serial <id>           adb device (defaults to ANDROID_SERIAL or session)
  --pkg <package>         REQUIRED. App package id, e.g. com.example.myapp
  --poll <sec>            PID re-resolution interval in seconds (default 2)
  --output <file>         Tee captured stream to FILE
  --grep <regex>          Only emit lines matching this egrep regex (filter at source).
                           Reduces --output file size and downstream parsing cost.
                           Applied before --until matching.
  --grep <regex>          Only emit lines matching this egrep regex (filter at source).
                           Reduces --output file size and downstream parsing cost.
                           Applied before --until matching.
  --grep <regex>          Only emit lines matching this egrep regex (filter at source).
                           Reduces --output file size and downstream parsing cost.
                           Applied before --until matching.
  --grep <regex>          Only emit lines matching this egrep regex (filter at source).
                           Reduces --output file size and downstream parsing cost.
                           Applied before --until matching.
  --grep <regex>          Only emit lines matching this egrep regex (filter at source).
                           Reduces --output file size and downstream parsing cost.
                           Applied before --until matching.
  --until <regex>         Stop when a captured line matches the egrep regex.
                           On match, prints "MATCH host_epoch_ms=<ms> regex=<pat> line=<...>"
                           to stdout — host-side timestamp lets Lane C ring_window.sh
                           correlate the event to a screencap frame.
  --match-file <path>     On --until match, also write the host_epoch_ms to this file
                           (single line). Useful when stdout is otherwise consumed.
  --summarize-crashes     Print a compact crash summary after the tailer ends
  --since <spec>          Pass-through to `adb logcat -T` (default: now)
  --max-duration <sec>    Self-terminate after N seconds (no GNU `timeout` needed)
  -h, --help              This help

Environment:
  ANDROID_SERIAL          Used if --serial not given.

Stops on SIGINT/SIGTERM, or on first --until match.
EOF
}

PKG=""
SERIAL="${ANDROID_SERIAL:-}"
POLL=2
OUTPUT=""
UNTIL=""
GREP_FILTER=""
SUMMARIZE=0
SINCE=""
MAX_DURATION=0
MATCH_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pkg) PKG="$2"; shift 2 ;;
        --serial) SERIAL="$2"; shift 2 ;;
        --poll) POLL="$2"; shift 2 ;;
        --output) OUTPUT="$2"; shift 2 ;;
        --until) UNTIL="$2"; shift 2 ;;
        --grep) GREP_FILTER="$2"; shift 2 ;;
        --match-file) MATCH_FILE="$2"; shift 2 ;;
        --summarize-crashes) SUMMARIZE=1; shift ;;
        --since) SINCE="$2"; shift 2 ;;
        --max-duration) MAX_DURATION="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "logcat_tail: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

[[ -n "$PKG" ]] || { echo "logcat_tail: --pkg is required" >&2; usage; exit 64; }

# Locate adb (PATH first, then common SDK locations).
find_adb() {
    if command -v adb >/dev/null 2>&1; then echo "adb"; return 0; fi
    local cand
    for cand in \
        "${ANDROID_HOME:-}/platform-tools/adb" \
        "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
        "$HOME/Library/Android/sdk/platform-tools/adb" \
        "$HOME/Android/Sdk/platform-tools/adb" \
        "/usr/local/opt/android-platform-tools/bin/adb" \
        "/opt/homebrew/bin/adb"
    do
        [[ -n "$cand" && -x "$cand" ]] && { echo "$cand"; return 0; }
    done
    return 1
}
ADB_BIN="$(find_adb)" || { echo "logcat_tail: adb not found on PATH or in common SDK paths" >&2; exit 127; }

# Resolve serial via session file if not given.
if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB=("$ADB_BIN")
[[ -n "$SERIAL" ]] && ADB+=(-s "$SERIAL")

if [[ -z "$SINCE" ]]; then
    # Default: now. Format must be MM-DD HH:MM:SS.mmm; use device clock for safety.
    SINCE="$("${ADB[@]}" shell "date '+%m-%d %H:%M:%S.000'" 2>/dev/null || echo "")"
fi

# Bash 3.2 has no associative arrays. Track (device-pid -> shell-pid) as a
# colon-delimited flat string so the script runs on stock macOS bash.
# State format: ":<dpid>=<spid>:<dpid>=<spid>:"
CHILDREN_STATE=":"
SYSTEM_TAILER_PID=""
CAPTURE_FILE="$(mktemp -t logcat_tail.XXXXXX)"
trap 'cleanup' EXIT INT TERM

children_get() {
    # Arg: device pid. Echoes shell pid (empty if absent).
    local pid="$1" rest
    [[ "$CHILDREN_STATE" == *":${pid}="* ]] || return 0
    rest="${CHILDREN_STATE#*:"${pid}"=}"
    echo "${rest%%:*}"
}

children_set() {
    # Args: device pid, shell pid.
    children_unset "$1"
    CHILDREN_STATE="${CHILDREN_STATE}${1}=${2}:"
}

children_unset() {
    local pid="$1" before rest
    [[ "$CHILDREN_STATE" == *":${pid}="* ]] || return 0
    before="${CHILDREN_STATE%%:"${pid}"=*}"
    rest="${CHILDREN_STATE#*:"${pid}"=}"
    rest="${rest#*:}"
    CHILDREN_STATE="${before}:${rest}"
}

children_dpids() {
    # Echo each device pid on its own line.
    local s="${CHILDREN_STATE#:}" entry
    while [[ -n "$s" ]]; do
        entry="${s%%:*}"
        s="${s#*:}"
        [[ "$s" == "$entry" ]] && s=""
        [[ -z "$entry" ]] && continue
        echo "${entry%%=*}"
    done
}

children_spids() {
    # Echo each shell pid on its own line.
    local s="${CHILDREN_STATE#:}" entry
    while [[ -n "$s" ]]; do
        entry="${s%%:*}"
        s="${s#*:}"
        [[ "$s" == "$entry" ]] && s=""
        [[ -z "$entry" ]] && continue
        echo "${entry#*=}"
    done
}

summarize_crashes() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local fatal anr native
    fatal=$(grep -nE 'FATAL EXCEPTION:' "$file" || true)
    anr=$(grep -nE 'ANR in ' "$file" || true)
    native=$(grep -nE 'signal [0-9]+ \(SIG(SEGV|ABRT|BUS|FPE|ILL)' "$file" || true)
    if [[ -z "$fatal" && -z "$anr" && -z "$native" ]]; then
        echo "logcat_tail: no crashes captured" >&2
        return 0
    fi
    echo "" >&2
    echo "==== logcat_tail: crash summary ====" >&2
    if [[ -n "$fatal" ]]; then
        echo "-- Java FATAL EXCEPTION(s) --" >&2
        while IFS= read -r hit; do
            local lineno=${hit%%:*}
            sed -n "${lineno},$((lineno + 12))p" "$file" >&2
            echo "" >&2
        done <<<"$fatal"
    fi
    if [[ -n "$anr" ]]; then
        echo "-- ANR(s) --" >&2
        echo "$anr" >&2
    fi
    if [[ -n "$native" ]]; then
        echo "-- Native crash signal(s) --" >&2
        while IFS= read -r hit; do
            local lineno=${hit%%:*}
            sed -n "${lineno},$((lineno + 8))p" "$file" >&2
            echo "" >&2
        done <<<"$native"
    fi
    echo "====================================" >&2
}

cleanup() {
    # Stop all child tailers.
    local spid
    while IFS= read -r spid; do
        [[ -n "$spid" ]] && kill "$spid" 2>/dev/null || true
    done < <(children_spids)
    [[ -n "${SYSTEM_TAILER_PID:-}" ]] && kill "$SYSTEM_TAILER_PID" 2>/dev/null || true
    if (( SUMMARIZE )); then
        summarize_crashes "$CAPTURE_FILE"
    fi
    rm -f "$CAPTURE_FILE"
}

emit() {
    # Tee a line to stdout, capture file, and optional --output.
    local line="$1"
    # --grep: drop non-matching lines before any emit. Crash summary still works
    # because matching lines (FATAL EXCEPTION etc.) are not filtered if regex permits.
    if [[ -n "$GREP_FILTER" ]] && ! [[ "$line" =~ $GREP_FILTER ]]; then
        return 0
    fi
    printf '%s\n' "$line"
    printf '%s\n' "$line" >>"$CAPTURE_FILE"
    [[ -n "$OUTPUT" ]] && printf '%s\n' "$line" >>"$OUTPUT"
    if [[ -n "$UNTIL" ]] && [[ "$line" =~ $UNTIL ]]; then
        # Emit a structured match line on stdout: lets ring_window.sh correlate
        # the listener event to the host-side screencap timeline. Includes host
        # epoch milliseconds because device logcat timestamps and host file mtimes
        # don't share a clock.
        local host_ms
        host_ms=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0)
        printf 'MATCH host_epoch_ms=%s regex=%s line=%s\n' "$host_ms" "$UNTIL" "$line"
        if [[ -n "$MATCH_FILE" ]]; then
            printf '%s\n' "$host_ms" >"$MATCH_FILE"
        fi
        echo "logcat_tail: --until matched at host_epoch_ms=$host_ms; stopping" >&2
        kill -TERM $$
    fi
}

start_pid_tailer() {
    local pid="$1"
    [[ -n "$(children_get "$pid")" ]] && return 0
    # `--pid` is supported on Android 7+ logcat; format is just the integer.
    {
        "${ADB[@]}" logcat -T "$SINCE" --pid="$pid" -v time 2>/dev/null \
        | while IFS= read -r line; do emit "[pid=$pid] $line"; done
    } &
    children_set "$pid" "$!"
    echo "logcat_tail: attached pid=$pid" >&2
}

start_system_tailer() {
    [[ -n "$SYSTEM_TAILER_PID" ]] && return 0
    # Crash-relevant tags surface fatal events that are NOT under the app's PID:
    #   AndroidRuntime  -> Java FATAL EXCEPTION
    #   ActivityManager -> ANR ("am_anr"), Process kills
    #   DEBUG           -> native (tombstone) crashes
    #   ActivityTaskManager -> task death on Android 10+
    {
        "${ADB[@]}" logcat -T "$SINCE" -v time \
            AndroidRuntime:E ActivityManager:I ActivityTaskManager:I DEBUG:I '*:S' 2>/dev/null \
        | while IFS= read -r line; do
            # AndroidRuntime:E is rare and always crash-relevant — keep every
            # line so stack frames (which don't mention the package) survive.
            # Other system tags only kept when they match the package or
            # mention a crash/ANR/native-signal marker.
            if [[ "$line" == *"AndroidRuntime"* ]]; then
                emit "[sys] $line"
            elif [[ "$line" == *"$PKG"* ]] \
              || [[ "$line" == *"FATAL EXCEPTION"* ]] \
              || [[ "$line" == *"ANR in"* ]] \
              || [[ "$line" == *"signal "*"(SIGSEGV"* ]] \
              || [[ "$line" == *"signal "*"(SIGABRT"* ]]; then
                emit "[sys] $line"
            fi
          done
    } &
    SYSTEM_TAILER_PID=$!
    echo "logcat_tail: system tailer up" >&2
}

resolve_pids() {
    # `pidof` returns space-separated PIDs (or empty). Empty when app not running.
    "${ADB[@]}" shell pidof "$PKG" 2>/dev/null | tr -s '[:space:]' '\n' | grep -E '^[0-9]+$' || true
}

start_system_tailer

# --max-duration: schedule a self-kill timer if requested. macOS doesn't ship
# GNU `timeout`; this avoids the dependency.
if [[ "$MAX_DURATION" != "0" ]]; then
    (
        sleep "$MAX_DURATION"
        echo "logcat_tail: --max-duration ${MAX_DURATION}s elapsed; stopping" >&2
        kill -TERM $$
    ) &
fi

# Main loop: re-resolve PIDs every $POLL seconds; attach new, drop dead.
# Bash 3.2 compatible — no associative arrays, no `mapfile`.
while :; do
    # Build LIVE array of currently-live device PIDs.
    LIVE=()
    while IFS= read -r p; do
        [[ -n "$p" ]] && LIVE+=("$p")
    done < <(resolve_pids)

    # Membership-test string. Surround with spaces for prefix-safe match.
    LIVE_STR=" $(printf '%s ' "${LIVE[@]:-}")"

    # Attach new PIDs.
    for p in "${LIVE[@]:-}"; do
        [[ -z "$p" ]] && continue
        [[ -z "$(children_get "$p")" ]] && start_pid_tailer "$p"
    done

    # Drop tailers whose device PID is gone.
    while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        if [[ "$LIVE_STR" != *" $p "* ]]; then
            spid="$(children_get "$p")"
            [[ -n "$spid" ]] && kill "$spid" 2>/dev/null || true
            children_unset "$p"
            echo "logcat_tail: detached dead pid=$p" >&2
        fi
    done < <(children_dpids)

    sleep "$POLL"
done
