#!/usr/bin/env bash
# device_pick.sh — pick a healthy adb device deterministically.
#
# Resolution order:
#   1. ANDROID_SERIAL env var, if it points to a healthy device
#   2. Single attached healthy device
#   3. Otherwise: print numbered table of healthy devices to stderr,
#      exit non-zero with a message naming the --serial flag to pass
#
# On success: prints the chosen serial to stdout AND writes it to
# $TMPDIR/android-skill-session/serial so other scripts can default to it.
#
# Healthy = `adb devices -l` row whose state is exactly "device"
# (drops "offline", "unauthorized", "no permissions", "host", "emulator-").

set -eu

SESSION_DIR="${TMPDIR:-/tmp}/android-skill-session"
SESSION_FILE="$SESSION_DIR/serial"
mkdir -p "$SESSION_DIR"

# Auto-cleanup of stale skill state at the start of every device pick. Cheap;
# best-effort. Failures here must not block the picker.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -x "$SCRIPT_DIR/cleanup.sh" ]] && "$SCRIPT_DIR/cleanup.sh" --quiet 2>/dev/null || true

usage() {
    cat <<'EOF' >&2
Usage: device_pick.sh [--quiet]

Picks a healthy adb device. Prints chosen serial to stdout.

Resolution:
  1. $ANDROID_SERIAL if healthy
  2. Single healthy device
  3. Otherwise, prints table to stderr and exits 2.

--quiet   Suppress informational stderr lines on success.

Reads:  $ANDROID_SERIAL
Writes: $TMPDIR/android-skill-session/serial
EOF
}

QUIET=0
for arg in "$@"; do
    case "$arg" in
        --quiet) QUIET=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "device_pick.sh: unknown arg: $arg" >&2; usage; exit 64 ;;
    esac
done

# Locate adb. Prefer one on PATH; otherwise probe common SDK locations so the
# skill works on a stock macOS with the SDK at ~/Library/Android/sdk/.
find_adb() {
    if command -v adb >/dev/null 2>&1; then
        echo "adb"
        return 0
    fi
    local cand
    for cand in \
        "${ANDROID_HOME:-}/platform-tools/adb" \
        "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
        "$HOME/Library/Android/sdk/platform-tools/adb" \
        "$HOME/Android/Sdk/platform-tools/adb" \
        "/usr/local/opt/android-platform-tools/bin/adb" \
        "/opt/homebrew/bin/adb"
    do
        if [[ -n "$cand" && -x "$cand" ]]; then
            echo "$cand"
            return 0
        fi
    done
    return 1
}
ADB="$(find_adb)" || { echo "device_pick.sh: adb not found on PATH or in common SDK paths" >&2; exit 127; }

# `adb devices -l` example rows:
#   emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 ...
#   1A2B3C4D5E             unauthorized usb:1-1
# Header line "List of devices attached" is dropped.
# Use a portable while-read loop instead of `mapfile` (bash-4-only; macOS
# default bash is 3.2).
HEALTHY=()
while IFS= read -r line; do
    HEALTHY+=("$line")
done < <("$ADB" devices -l 2>/dev/null | awk 'NR>1 && $2=="device" {print $0}')

if [[ ${#HEALTHY[@]} -eq 0 ]]; then
    echo "device_pick.sh: no healthy devices attached" >&2
    echo "Hint: run 'adb devices -l' to see all devices, including unauthorized/offline." >&2
    exit 1
fi

extract_serial() { awk '{print $1}' <<<"$1"; }

# 1. Honour ANDROID_SERIAL when set and healthy.
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    for row in "${HEALTHY[@]}"; do
        if [[ "$(extract_serial "$row")" == "$ANDROID_SERIAL" ]]; then
            echo "$ANDROID_SERIAL" | tee "$SESSION_FILE"
            (( QUIET )) || echo "device_pick.sh: using ANDROID_SERIAL=$ANDROID_SERIAL" >&2
            exit 0
        fi
    done
    echo "device_pick.sh: ANDROID_SERIAL='$ANDROID_SERIAL' is set but not healthy/attached" >&2
    exit 1
fi

# 2. Single healthy device → pick it.
if [[ ${#HEALTHY[@]} -eq 1 ]]; then
    serial=$(extract_serial "${HEALTHY[0]}")
    echo "$serial" | tee "$SESSION_FILE"
    (( QUIET )) || echo "device_pick.sh: using $serial" >&2
    exit 0
fi

# 3. Multiple → print table, exit non-zero with actionable message.
{
    echo "device_pick.sh: ${#HEALTHY[@]} healthy devices attached. Pick one:"
    echo
    printf '  %-3s  %-22s  %s\n' '#' 'serial' 'detail'
    printf '  %-3s  %-22s  %s\n' '-' '------' '------'
    i=1
    for row in "${HEALTHY[@]}"; do
        serial=$(extract_serial "$row")
        detail=$(awk '{ for(i=3;i<=NF;i++) printf "%s ",$i; print "" }' <<<"$row" \
                 | sed 's/[[:space:]]*$//')
        printf '  %-3s  %-22s  %s\n' "$i" "$serial" "$detail"
        i=$((i+1))
    done
    echo
    echo "Re-run with:   ANDROID_SERIAL=<serial> $(basename "$0")"
    echo "Or pass:       --serial <serial>   to downstream scripts"
} >&2
exit 2
