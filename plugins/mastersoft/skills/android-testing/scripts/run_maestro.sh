#!/usr/bin/env bash
# run_maestro.sh — thin wrapper around `maestro test` for the parallel
# Maestro lane. Not facade-merged with ui_snapshot/ui_act; Maestro flows are
# their own paradigm (stateful YAML).
#
# Why a wrapper rather than calling `maestro` directly:
#   - Auto-detect maestro install; emit a clear "install needed" message
#     instead of opaque shell errors.
#   - Resolve --serial via the session file (same as the rest of the skill).
#   - Hand back a structured pass/fail line on stdout so callers can branch.
#
# Maestro itself supports much more (recordings, hierarchy dumps, etc.) —
# this wrapper only exposes `test` for v2. Power users can invoke `maestro`
# directly when needed.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  run_maestro.sh <flow.yaml> [maestro-test-args...]

Examples:
  run_maestro.sh flows/login.yaml
  run_maestro.sh flows/login.yaml --debug-output /tmp/maestro-debug

Resolution:
  - `maestro` is found on PATH or auto-discovered from common Homebrew
    locations (~/.maestro/bin, /opt/homebrew/bin, /usr/local/bin).
  - `--device` is set automatically to the session serial unless already
    in the args.

Output (stdout, single line):
  PASS host_epoch_ms=<ms> flow=<path>
  FAIL host_epoch_ms=<ms> flow=<path> reason=<short>
EOF
}

[[ $# -gt 0 ]] || { usage; exit 64; }
[[ "$1" == "-h" || "$1" == "--help" ]] && { usage; exit 0; }

FLOW="$1"; shift
[[ -f "$FLOW" ]] || { echo "run_maestro: flow file not found: $FLOW" >&2; exit 1; }

find_maestro() {
    if command -v maestro >/dev/null 2>&1; then command -v maestro; return 0; fi
    local cand
    for cand in \
        "$HOME/.maestro/bin/maestro" \
        "/opt/homebrew/bin/maestro" \
        "/usr/local/bin/maestro"
    do
        [[ -x "$cand" ]] && { echo "$cand"; return 0; }
    done
    # Cellar fallback for when the symlink is masked by another cask of the
    # same name (the bare `brew install maestro` cask is an unrelated Electron
    # app). Glob the latest version under the tap formula.
    for cand in /opt/homebrew/Cellar/maestro/*/bin/maestro /usr/local/Cellar/maestro/*/bin/maestro; do
        [[ -x "$cand" ]] && { echo "$cand"; return 0; }
    done
    return 1
}

MAESTRO="$(find_maestro 2>/dev/null || true)"
if [[ -z "$MAESTRO" ]]; then
    echo "run_maestro: maestro not found on PATH or in common locations." >&2
    echo "  Install with: \${CLAUDE_SKILL_DIR}/scripts/install_maestro.sh" >&2
    exit 127
fi

# Resolve serial via session file unless caller already passed --device.
SERIAL="${ANDROID_SERIAL:-}"
if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi

ARGS=("$@")
# Maestro: --device / --udid is a TOP-LEVEL flag, must come BEFORE the
# subcommand. Build top-level args separately from the test-subcommand args.
TOPLEVEL_ARGS=()
HAS_DEVICE=0
HAS_PLATFORM=0
for a in "${ARGS[@]:-}"; do
    [[ "$a" == "--device" || "$a" == --device=* ]] && HAS_DEVICE=1
    [[ "$a" == "--udid"   || "$a" == --udid=*   ]] && HAS_DEVICE=1
    [[ "$a" == "-p" || "$a" == "--platform" || "$a" == --platform=* ]] && HAS_PLATFORM=1
done
if (( ! HAS_DEVICE )) && [[ -n "$SERIAL" ]]; then
    TOPLEVEL_ARGS+=(--device "$SERIAL")
fi
if (( ! HAS_PLATFORM )); then
    TOPLEVEL_ARGS+=(--platform android)
fi

now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000; }

LOG="$(mktemp -t maestro_run.XXXXXX)"

# `maestro test` exits 0 on pass, non-zero on fail. We capture combined
# output for diagnostic. Top-level flags (--device, --platform) come BEFORE
# the `test` subcommand per maestro CLI grammar.
RC=0
"$MAESTRO" "${TOPLEVEL_ARGS[@]}" test "$FLOW" "${ARGS[@]:-}" > "$LOG" 2>&1 || RC=$?

END_MS="$(now_ms)"

if [[ "$RC" == "0" ]]; then
    echo "PASS host_epoch_ms=$END_MS flow=$FLOW"
    rm -f "$LOG"
    exit 0
else
    REASON=$(grep -m1 -E '^(Error|FAILED|Assertion failed|Element .* not found|❌)' "$LOG" \
             | head -1 | tr -d '\r' | cut -c -200)
    [[ -z "$REASON" ]] && REASON="rc=$RC"
    echo "FAIL host_epoch_ms=$END_MS flow=$FLOW reason=$REASON"
    echo "(full output: $LOG)" >&2
    exit "$RC"
fi
