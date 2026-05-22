#!/usr/bin/env bash
# install_u2.sh — install uiautomator2 (Python lib + on-device atx-agent).
#
# Idempotent: safe to re-run. Detects already-installed and exits 0 quickly.
#
# WARNING — this pushes a small APK (`com.github.uiautomator`) and a binary
# (`atx-agent`) to the connected device. On managed/MDM devices the install
# may fail or be visible to your IT. Skip on devices you don't own.
#
# Bash exec permission is handled by the Claude Code harness PreToolUse
# approval; this script does not request consent itself.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  install_u2.sh [--serial SERIAL] [--user|--system]

Installs:
  - python3 package `uiautomator2` (via `pip install --user`, default)
  - on-device APK + atx-agent via `python3 -m uiautomator2 init` (one-shot)

--system          Use `pip install` (system-wide); default is `--user`.
                    Some macOS Python installs require a venv; this script
                    does not create one.
--serial SERIAL   Target device for atx-agent push (defaults to ANDROID_SERIAL
                    or session file).

Exit codes:
  0   already-installed or installed cleanly
  1   install failed
  127 missing python3 / pip / adb
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
SCOPE=user
while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        --user) SCOPE=user; shift ;;
        --system) SCOPE=system; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install_u2: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

command -v python3 >/dev/null 2>&1 || { echo "install_u2: python3 not on PATH" >&2; exit 127; }
command -v pip3 >/dev/null 2>&1 || command -v pip >/dev/null 2>&1 \
    || { echo "install_u2: neither pip3 nor pip on PATH" >&2; exit 127; }

PIP=$(command -v pip3 || command -v pip)

# Step 1: ensure the Python lib.
if python3 -c 'import uiautomator2' 2>/dev/null; then
    echo "install_u2: uiautomator2 already importable" >&2
else
    echo "install_u2: installing uiautomator2 via $PIP ($SCOPE)" >&2
    # PEP 668: brew Python refuses pip without --break-system-packages.
    # --user keeps the install under ~/Library/Python/, so brew's
    # site-packages stay clean even with --break-system-packages.
    EXTRA_FLAGS=()
    if "$PIP" config list 2>/dev/null | grep -q externally-managed; then
        EXTRA_FLAGS+=(--break-system-packages)
    fi
    # Try without --break-system-packages first; only add it on PEP-668 fail.
    install_attempt() {
        if [[ "$SCOPE" == "user" ]]; then
            "$PIP" install --user --quiet "$@" uiautomator2
        else
            "$PIP" install --quiet "$@" uiautomator2
        fi
    }
    if ! install_attempt 2>/tmp/install_u2_pip.err; then
        if grep -q 'externally-managed' /tmp/install_u2_pip.err; then
            echo "install_u2: PEP 668; retrying with --break-system-packages" >&2
            install_attempt --break-system-packages || {
                cat /tmp/install_u2_pip.err >&2
                echo "install_u2: pip install failed even with --break-system-packages" >&2
                exit 1
            }
        else
            cat /tmp/install_u2_pip.err >&2
            echo "install_u2: pip install failed" >&2
            exit 1
        fi
    fi
    rm -f /tmp/install_u2_pip.err
fi

# Step 2: ensure atx-agent on device.
# Resolve serial via session file if not given.
if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
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
ADB="$(find_adb)" || { echo "install_u2: adb not found" >&2; exit 127; }

if [[ -z "$SERIAL" ]]; then
    HEALTHY=$("$ADB" devices -l 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')
    HEALTHY_COUNT=$(echo "$HEALTHY" | grep -c .)
    if [[ "$HEALTHY_COUNT" == "1" ]]; then
        SERIAL="$HEALTHY"
    elif [[ "$HEALTHY_COUNT" -gt 1 ]]; then
        echo "install_u2: multiple devices; pass --serial <id> to target one" >&2
        exit 1
    else
        echo "install_u2: no healthy device attached" >&2
        exit 1
    fi
fi

# Modern uiautomator2 (>=3.x) does NOT run the old `atx-agent` Go daemon —
# it uses `app_process / com.wetest.uia2.Main` to launch a JVM agent on
# demand. So `pidof atx-agent` is the wrong probe. The right probe is to
# attempt a u2.connect() + a cheap call (.info) and see if it returns.
probe_u2() {
    ANDROID_SERIAL="$SERIAL" python3 -c "
import sys, uiautomator2 as u2
try:
    d = u2.connect('$SERIAL')
    _ = d.info  # forces a real round-trip
    print('OK', flush=True)
except Exception as e:
    print(f'FAIL: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1 | tail -3
    return "${PIPESTATUS[0]}"
}

echo "install_u2: device=$SERIAL — probing u2 connect" >&2
if probe_u2 | grep -q '^OK$'; then
    echo "install_u2: u2 already reachable on $SERIAL" >&2
    exit 0
fi

echo "install_u2: running 'python3 -m uiautomator2 init' (pushes a small APK + u2.jar to the device)" >&2
ANDROID_SERIAL="$SERIAL" python3 -m uiautomator2 init >/dev/null 2>&1 || {
    echo "install_u2: 'python3 -m uiautomator2 init' failed; check adb auth + device storage" >&2
    exit 1
}

# Verify with a real connect.
sleep 1
if probe_u2 | grep -q '^OK$'; then
    echo "install_u2: u2 reachable on $SERIAL" >&2
    exit 0
fi
echo "install_u2: install ran but u2.connect() still fails; check 'adb -s $SERIAL shell pm list packages | grep uiautomator'" >&2
exit 1
