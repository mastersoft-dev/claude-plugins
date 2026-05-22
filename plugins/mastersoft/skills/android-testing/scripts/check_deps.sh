#!/usr/bin/env bash
# check_deps.sh — report which optional v2 deps are present.
#
# Output: one `key=value` per line on stdout, no prose.
#
#   adb=/path/to/adb
#   python3=true|false
#   uiautomator2=true|false
#   atx_agent=<serial-only>|missing|skipped
#   maestro=true|false
#   imagemagick=true|false
#
# The model uses this to decide whether to prompt the user before installing
# a dep. Re-run each session — there is no consent file, by design.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  check_deps.sh [--serial SERIAL]

Reports which optional v2 features are immediately usable based on host
and on-device state. Run this BEFORE choosing a Lane that requires extras.
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "check_deps: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

# adb auto-discovery (same logic as device_pick.sh).
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

ADB="$(find_adb 2>/dev/null || echo '')"
[[ -n "$ADB" ]] && echo "adb=$ADB" || echo "adb=missing"

if command -v python3 >/dev/null 2>&1; then
    echo "python3=true"
else
    echo "python3=false"
fi

# uiautomator2 Python lib
if command -v python3 >/dev/null 2>&1 && python3 -c 'import uiautomator2' 2>/dev/null; then
    echo "uiautomator2=true"
else
    echo "uiautomator2=false"
fi

# u2 device-side probe — modern uiautomator2 (>=3.x) uses `app_process` to
# launch a JVM agent on demand, NOT the old atx-agent daemon. The right probe
# is a u2.connect() + .info round-trip. Skip when prerequisites missing.
probe_u2_device() {
    local serial="$1"
    [[ -n "$serial" ]] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    python3 -c "import uiautomator2" 2>/dev/null || return 1
    ANDROID_SERIAL="$serial" python3 -c "
import sys, uiautomator2 as u2
try:
    d = u2.connect('$serial'); _ = d.info; print('OK')
except Exception:
    sys.exit(1)
" 2>/dev/null | grep -q '^OK$'
}

if [[ -n "$ADB" && -n "$SERIAL" ]]; then
    if probe_u2_device "$SERIAL"; then
        echo "u2_device=ready"
    else
        echo "u2_device=missing"
    fi
elif [[ -n "$ADB" ]]; then
    HEALTHY=$("$ADB" devices -l 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')
    HEALTHY_COUNT=$(echo "$HEALTHY" | grep -c .)
    if [[ "$HEALTHY_COUNT" == "1" ]]; then
        if probe_u2_device "$HEALTHY"; then
            echo "u2_device=ready"
        else
            echo "u2_device=missing"
        fi
    else
        echo "u2_device=skipped"
    fi
else
    echo "u2_device=skipped"
fi

if command -v maestro >/dev/null 2>&1; then
    echo "maestro=true"
else
    # Cellar fallback (the bare `maestro` cask name is an unrelated Electron
    # app; the tap install lands in /opt/homebrew/Cellar/maestro/*/bin/).
    MAESTRO_CELLAR=""
    for cand in /opt/homebrew/Cellar/maestro/*/bin/maestro /usr/local/Cellar/maestro/*/bin/maestro; do
        if [[ -x "$cand" ]]; then MAESTRO_CELLAR="$cand"; break; fi
    done
    if [[ -n "$MAESTRO_CELLAR" ]]; then
        echo "maestro=true"
        echo "maestro_path=$MAESTRO_CELLAR"
    else
        echo "maestro=false"
    fi
fi

if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    echo "imagemagick=true"
else
    echo "imagemagick=false"
fi

# Helpful summary line for grep (single-token).
LANE_HINT="raw"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import uiautomator2' 2>/dev/null; then
    LANE_HINT="u2_or_raw"
fi
if command -v maestro >/dev/null 2>&1; then
    LANE_HINT="${LANE_HINT}_or_maestro"
fi
echo "lane_hint=$LANE_HINT"
