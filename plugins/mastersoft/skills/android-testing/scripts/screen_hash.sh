#!/usr/bin/env bash
# screen_hash.sh — capture a screencap and emit a hash, for Lane B verifier.
#
# Lane B (raw `adb input tap`) is blind: there's no accessibility-tree feedback
# to confirm the action did anything. The standard verifier is "before/after":
# hash a screencap before the tap, hash again after, compare.
#
# Two modes:
#
#   screen_hash.sh                  → captures + prints a hex hash to stdout
#   screen_hash.sh --diff <hash>    → captures, hashes, prints "same" or
#                                     "differ" plus the new hash. Convenient
#                                     for one-line verification:
#
#     before=$(screen_hash.sh)
#     adb shell input tap 540 1200
#     screen_hash.sh --diff "$before"   # → "differ <new>"
#
# By default hashes the full screencap. With --region the hash only covers a
# crop, which is more sensitive (small UI changes don't get diluted by the
# stable parts of the screen).

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  screen_hash.sh [options]

Options:
  --serial <id>         adb device (defaults to ANDROID_SERIAL or session)
  --region X,Y,W,H      Hash only this rectangular crop (pixels). Requires
                          ImageMagick `magick`/`convert` on PATH.
  --algorithm <name>    Hash algorithm: sha256 (default), md5.
  --diff <hash>         Capture, hash, then print "same|differ <new_hash>"
                          comparing to the given hash. Exit 0 on differ, 1 on same.
  -h, --help            This help.
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
REGION=""
ALGO="sha256"
DIFF_AGAINST=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        --algorithm) ALGO="$2"; shift 2 ;;
        --diff) DIFF_AGAINST="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "screen_hash: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

# adb auto-discovery.
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
ADB="$(find_adb)" || { echo "screen_hash: adb not found" >&2; exit 127; }

if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB_CMD=("$ADB")
[[ -n "$SERIAL" ]] && ADB_CMD+=(-s "$SERIAL")

case "$ALGO" in
    sha256) HASH_CMD="shasum -a 256" ;;
    md5)    HASH_CMD="md5 -q" ;;  # macOS form
    *)      echo "screen_hash: unknown algorithm: $ALGO" >&2; exit 64 ;;
esac

# Linux falls back if `md5` not present.
if [[ "$ALGO" == "md5" ]] && ! command -v md5 >/dev/null 2>&1; then
    HASH_CMD="md5sum"
fi

TMP="$(mktemp -t screen_hash.XXXXXX.png)"
trap 'rm -f "$TMP"' EXIT

# Capture.
"${ADB_CMD[@]}" exec-out screencap -p > "$TMP" 2>/dev/null

if [[ ! -s "$TMP" ]]; then
    echo "screen_hash: empty screencap (device disconnected?)" >&2
    exit 1
fi

if [[ -n "$REGION" ]]; then
    if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
        echo "screen_hash: --region requires ImageMagick (magick or convert)" >&2
        exit 127
    fi
    IFS=',' read -r RX RY RW RH <<<"$REGION"
    CROP="${RW}x${RH}+${RX}+${RY}"
    CROPPED="$(mktemp -t screen_hash_crop.XXXXXX.png)"
    trap 'rm -f "$TMP" "$CROPPED"' EXIT
    if command -v magick >/dev/null 2>&1; then
        magick "$TMP" -crop "$CROP" +repage "$CROPPED"
    else
        convert "$TMP" -crop "$CROP" +repage "$CROPPED"
    fi
    HASH=$($HASH_CMD < "$CROPPED" | awk '{print $1}')
else
    HASH=$($HASH_CMD < "$TMP" | awk '{print $1}')
fi

if [[ -n "$DIFF_AGAINST" ]]; then
    if [[ "$HASH" == "$DIFF_AGAINST" ]]; then
        printf 'same %s\n' "$HASH"
        exit 1
    else
        printf 'differ %s\n' "$HASH"
        exit 0
    fi
fi

printf '%s\n' "$HASH"
