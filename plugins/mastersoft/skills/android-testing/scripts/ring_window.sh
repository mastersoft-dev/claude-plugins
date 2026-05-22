#!/usr/bin/env bash
# ring_window.sh — given a host_epoch_ms timestamp, return frame paths within
# a configurable window for inspection. Lane C primitive.
#
# Frame filenames in the ring directory are <host_epoch_ms>.png — millisecond
# timestamp baked in. We pick frames whose name falls in
# [center - span_ms/2, center + span_ms/2].

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  ring_window.sh --dir <ring-dir> --around <host_epoch_ms> [options]
  ring_window.sh --dir <ring-dir> --diff <t1> <t2> [options]

Modes:
  --around <epoch_ms>    Centre of the window (host epoch ms). Or pass
                          @<file> to read the timestamp from a file (e.g.
                          the --match-file output of logcat_tail.sh).
  --diff <t1> <t2>       Pick the closest frame to each of t1 and t2 in the
                          ring; print pixel-changed count + path to the
                          per-pixel diff PNG. Requires ImageMagick (magick
                          or convert) on PATH.

Options:
  --dir <path>           REQUIRED. Ring directory written by screen_ring.sh.
  --span-ms <ms>         (--around mode) Half-width of window (default 2000).
  --max <n>              (--around mode) Cap on returned paths (default 5).
  --include-distance     (--around mode) Print "<distance_ms>\t<path>".
  --diff-out <path>      (--diff mode) Output diff PNG path
                          (default $TMPDIR/android-skill-diff.png).
  -h, --help             This help.

Output (--around): one frame path per line, closest first. Empty if window empty.
Output (--diff): one line "changed_pixels=<N> diff=<path> a=<frameA> b=<frameB>".
EOF
}

DIR=""
AROUND=""
DIFF_T1=""
DIFF_T2=""
SPAN_MS=2000
MAX=5
INCLUDE_DISTANCE=0
DIFF_OUT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir) DIR="$2"; shift 2 ;;
        --around) AROUND="$2"; shift 2 ;;
        --diff)
            DIFF_T1="$2"
            DIFF_T2="$3"
            shift 3
            ;;
        --span-ms) SPAN_MS="$2"; shift 2 ;;
        --max) MAX="$2"; shift 2 ;;
        --include-distance) INCLUDE_DISTANCE=1; shift ;;
        --diff-out) DIFF_OUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ring_window: unknown arg: $1" >&2; usage; exit 64 ;;
    esac
done

[[ -n "$DIR" ]] || { echo "ring_window: --dir required" >&2; usage; exit 64; }
[[ -d "$DIR" ]] || { echo "ring_window: dir not found: $DIR" >&2; exit 1; }
if [[ -z "$AROUND" && -z "$DIFF_T1" ]]; then
    echo "ring_window: --around or --diff required" >&2; usage; exit 64
fi

# Helper: closest frame to a target ms in $DIR. Echoes path or empty.
closest_frame() {
    local target="$1"
    local best="" best_d=999999999999
    local f base d
    for f in "$DIR"/*.png; do
        [[ -f "$f" ]] || continue
        base=$(basename "$f" .png)
        [[ "$base" =~ ^[0-9]+$ ]] || continue
        if (( base >= target )); then
            d=$(( base - target ))
        else
            d=$(( target - base ))
        fi
        if (( d < best_d )); then
            best_d=$d
            best="$f"
        fi
    done
    echo "$best"
}

# --- diff mode --------------------------------------------------------------
if [[ -n "$DIFF_T1" ]]; then
    [[ "$DIFF_T1" =~ ^[0-9]+$ && "$DIFF_T2" =~ ^[0-9]+$ ]] \
        || { echo "ring_window: --diff requires two epoch_ms integers" >&2; exit 64; }
    if ! command -v magick >/dev/null 2>&1 && ! command -v compare >/dev/null 2>&1; then
        echo "ring_window: --diff requires ImageMagick (magick or compare). Install with 'brew install imagemagick'." >&2
        exit 127
    fi
    FRAME_A="$(closest_frame "$DIFF_T1")"
    FRAME_B="$(closest_frame "$DIFF_T2")"
    if [[ -z "$FRAME_A" || -z "$FRAME_B" ]]; then
        echo "ring_window: no frames found near requested timestamps" >&2
        exit 1
    fi
    OUT="${DIFF_OUT:-${TMPDIR:-/tmp}/android-skill-diff.png}"
    # ImageMagick `compare -metric AE` returns the count of pixels that
    # differ between two images. Output goes to stderr; rc=1 means
    # "images differ" (success for our purposes); rc>1 is a real error.
    # Format on modern ImageMagick (7.x): "<count> (<fuzz>)" where count
    # may be scientific notation like 2.0736e+06.
    if command -v magick >/dev/null 2>&1; then
        RAW=$(magick compare -metric AE "$FRAME_A" "$FRAME_B" "$OUT" 2>&1 >/dev/null || true)
    else
        RAW=$(compare -metric AE "$FRAME_A" "$FRAME_B" "$OUT" 2>&1 >/dev/null || true)
    fi
    # Take first whitespace-separated token; coerce to integer (handles
    # scientific notation like 2.0736e+06 → 2073600).
    CHANGED=$(echo "$RAW" | awk 'NR==1 {printf "%.0f\n", $1; exit}')
    [[ -z "$CHANGED" || "$CHANGED" == "0e+00" ]] && CHANGED=0
    echo "changed_pixels=$CHANGED diff=$OUT a=$FRAME_A b=$FRAME_B"
    exit 0
fi

# --- around mode ------------------------------------------------------------
# Allow @file form to read the timestamp.
if [[ "$AROUND" == @* ]]; then
    f="${AROUND#@}"
    [[ -f "$f" ]] || { echo "ring_window: timestamp file not found: $f" >&2; exit 1; }
    AROUND=$(head -1 "$f" | tr -d '[:space:]')
fi

# Sanity: AROUND must be a number.
if ! [[ "$AROUND" =~ ^[0-9]+$ ]]; then
    echo "ring_window: --around must be epoch_ms integer, got: $AROUND" >&2
    exit 64
fi

LO=$(( AROUND - SPAN_MS ))
HI=$(( AROUND + SPAN_MS ))

# List frames, parse epoch_ms from filename, filter, sort by distance, cap.
# All-bash to avoid awk/python dependency wobble.
RESULTS=()
for f in "$DIR"/*.png; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f" .png)
    [[ "$base" =~ ^[0-9]+$ ]] || continue
    if (( base >= LO && base <= HI )); then
        # Compute absolute distance.
        if (( base >= AROUND )); then
            d=$(( base - AROUND ))
        else
            d=$(( AROUND - base ))
        fi
        RESULTS+=("$d $f")
    fi
done

# Sort by numeric distance, ascending.
if (( ${#RESULTS[@]} == 0 )); then
    exit 0
fi

printf '%s\n' "${RESULTS[@]}" | sort -n | (
    n=0
    while IFS=' ' read -r d path; do
        if (( MAX > 0 && n >= MAX )); then break; fi
        if (( INCLUDE_DISTANCE )); then
            printf '%s\t%s\n' "$d" "$path"
        else
            printf '%s\n' "$path"
        fi
        n=$(( n + 1 ))
    done
)
