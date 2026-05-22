#!/usr/bin/env bash
# bench.sh — drive a flow.json N times and report per-op p50/p95 from
# the daemon's op journal.
#
# Usage:
#   bench.sh [--serial SERIAL] [-n N] [--cold] [--keep-journal] FLOW.json
#
#   -n N            iterations (default 10)
#   --cold          quit + relaunch daemon between iterations (slow,
#                   simulates worst-case cold start)
#   --keep-journal  do NOT truncate journal at start; useful when
#                   chaining benches
#
# Output: a markdown table on stdout with op | n | p50 | p95 | max | rc≠0.
# Reads ${TMPDIR:-/tmp}/android-skill-journal.<serial>.jsonl after the run.
#
# Requires: jq, ui_run_flow.py from this skill.

set -euo pipefail

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 64
}

SERIAL="${ANDROID_SERIAL:-}"
ITER=10
COLD=0
KEEP=0
FLOW=""
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        -n) ITER="$2"; shift 2 ;;
        --cold) COLD=1; shift ;;
        --keep-journal) KEEP=1; shift ;;
        -h|--help) usage ;;
        -*) echo "bench: unknown flag $1" >&2; usage ;;
        *) FLOW="$1"; shift ;;
    esac
done

[[ -n "$FLOW" ]] || { echo "bench: missing flow.json" >&2; usage; }
[[ -f "$FLOW" ]] || { echo "bench: not a file: $FLOW" >&2; exit 64; }
command -v jq >/dev/null 2>&1 || { echo "bench: jq required" >&2; exit 127; }

# Resolve serial (same logic as device_pick.sh / daemon).
if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
[[ -n "$SERIAL" ]] || { echo "bench: --serial required (or set ANDROID_SERIAL)" >&2; exit 64; }

JPATH="${TMPDIR:-/tmp}/android-skill-journal.${SERIAL}.jsonl"
DAEMON="$SKILL_DIR/scripts/android_skill_daemon.py"
RUN_FLOW="$SKILL_DIR/scripts/ui_run_flow.py"

if [[ "$KEEP" -eq 0 ]]; then
    : > "$JPATH"
fi

echo "bench: serial=$SERIAL iter=$ITER cold=$COLD flow=$FLOW" >&2
echo "bench: journal=$JPATH" >&2

START_NS=$(date +%s)
for i in $(seq 1 "$ITER"); do
    if [[ "$COLD" -eq 1 ]]; then
        "$DAEMON" --serial "$SERIAL" --request '{"op":"quit"}' >/dev/null 2>&1 || true
        sleep 1
    fi
    "$RUN_FLOW" --serial "$SERIAL" --file "$FLOW" >/dev/null 2>&1 || {
        echo "bench: iteration $i failed" >&2
    }
done
END_NS=$(date +%s)
WALL=$(( END_NS - START_NS ))

echo >&2
echo "bench: wall=${WALL}s — journal entries: $(wc -l <"$JPATH" | tr -d ' ')" >&2
echo >&2

# Compute per-op stats. Group by op, sort ms ascending, pick p50/p95.
# `batch` wrapper entries are excluded — they aggregate sub-ops and
# would double-count.
echo "| op | n | p50 ms | p95 ms | max ms | failures |"
echo "|---|---:|---:|---:|---:|---:|"
jq -r 'select(.op != "batch") | [.op, .ms, .rc] | @tsv' "$JPATH" \
    | awk -F'\t' '
{
    op = $1; ms = $2 + 0; rc = $3 + 0
    times[op] = (op in times ? times[op] " " ms : ms)
    n[op]++
    if (rc != 0) fail[op]++
    if (ms > maxv[op] || !(op in maxv)) maxv[op] = ms
}
END {
    for (op in n) {
        # sort space-separated list
        cmd = "tr \" \" \"\\n\" <<<\"" times[op] "\" | sort -n"
        delete sorted
        i = 0
        while ((cmd | getline line) > 0) sorted[++i] = line
        close(cmd)
        c = i
        p50_idx = int((c * 50 + 50) / 100); if (p50_idx < 1) p50_idx = 1
        p95_idx = int((c * 95 + 50) / 100); if (p95_idx < 1) p95_idx = 1
        if (p95_idx > c) p95_idx = c
        if (p50_idx > c) p50_idx = c
        printf "| %s | %d | %d | %d | %d | %d |\n",
               op, c, sorted[p50_idx], sorted[p95_idx], maxv[op], (fail[op] ? fail[op] : 0)
    }
}' | sort
