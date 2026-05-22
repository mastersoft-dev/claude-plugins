#!/usr/bin/env bash
# bench-multi.sh — drive a flow.json against N devices in parallel and
# report per-device perf tables.
#
# Each device gets its own daemon (one socket per serial — already true
# from the per-serial socket path convention). The N runners spawn as
# background subshells; main thread waits on them all, then prints
# per-device tables in serial order.
#
# Usage:
#   bench-multi.sh --serials S1,S2,...[,SN] [-n N] [--cold] FLOW.json
#
# Output: a top-line wall-clock summary, then one `bench.sh`-style
# table per device, separated by `=== <serial> ===` headers.
#
# Use cases:
#   - Compatibility matrix: same flow on 3 emulator API levels in parallel.
#   - Throughput: how many seconds for N runs across the fleet?
#   - Stability bench: spot per-device variance — e.g. a slow
#     emulator hidden in a fleet drags p95 globally; per-device tables
#     show which one.

set -euo pipefail

usage() {
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 64
}

SERIALS=""
ITER=10
COLD=0
FLOW=""
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$SKILL_DIR/scripts/bench.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serials) SERIALS="$2"; shift 2 ;;
        -n) ITER="$2"; shift 2 ;;
        --cold) COLD=1; shift ;;
        -h|--help) usage ;;
        -*) echo "bench-multi: unknown flag $1" >&2; usage ;;
        *) FLOW="$1"; shift ;;
    esac
done

[[ -n "$FLOW" ]] || { echo "bench-multi: missing flow.json" >&2; usage; }
[[ -f "$FLOW" ]] || { echo "bench-multi: not a file: $FLOW" >&2; exit 64; }
[[ -n "$SERIALS" ]] || { echo "bench-multi: --serials required" >&2; usage; }
[[ -x "$BENCH" ]] || { echo "bench-multi: $BENCH not executable" >&2; exit 127; }

IFS=',' read -ra SERIAL_LIST <<<"$SERIALS"
N_DEV="${#SERIAL_LIST[@]}"
echo "bench-multi: devices=$N_DEV iter=$ITER cold=$COLD flow=$FLOW" >&2

# Spawn one runner per device. Capture its stdout in a per-device temp
# file so we can join + print after `wait`.
TMP=$(mktemp -d -t bench-multi)
trap 'rm -rf "$TMP"' EXIT

START_NS=$(date +%s)
PIDS=()
for SERIAL in "${SERIAL_LIST[@]}"; do
    SERIAL="${SERIAL// /}"  # strip whitespace
    [[ -n "$SERIAL" ]] || continue
    OUT="$TMP/$SERIAL.out"
    if [[ "$COLD" -eq 1 ]]; then
        "$BENCH" --serial "$SERIAL" -n "$ITER" --cold "$FLOW" > "$OUT" 2>&1 &
    else
        "$BENCH" --serial "$SERIAL" -n "$ITER" "$FLOW" > "$OUT" 2>&1 &
    fi
    PIDS+=("$!")
done

# Wait for all, capture per-runner exit codes (without -e since some may fail).
set +e
RC_ANY=0
for pid in "${PIDS[@]}"; do
    wait "$pid"
    rc=$?
    if [[ $rc -ne 0 ]]; then
        RC_ANY=$rc
    fi
done
set -e
END_NS=$(date +%s)
WALL=$(( END_NS - START_NS ))

echo "" >&2
echo "bench-multi: wall=${WALL}s across $N_DEV device(s) — per-device tables below:" >&2
echo "" >&2

# Print per-device output in the order serials were given.
for SERIAL in "${SERIAL_LIST[@]}"; do
    SERIAL="${SERIAL// /}"
    [[ -n "$SERIAL" ]] || continue
    echo "=== $SERIAL ==="
    cat "$TMP/$SERIAL.out"
    echo ""
done

exit "$RC_ANY"
