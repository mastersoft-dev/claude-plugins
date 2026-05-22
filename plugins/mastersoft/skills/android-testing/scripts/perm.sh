#!/usr/bin/env bash
# perm.sh — runtime permissions and AppOps helper.
#
# Wraps the three adb shell primitives that come up in exploratory driving:
#
#   pm grant   <pkg> <perm>      # since Android 6 (M); runtime perms only
#   pm revoke  <pkg> <perm>      # mirror
#   appops set <pkg> <op> <mode> # for non-runtime gates: PROJECT_MEDIA,
#                                  ACCESS_BACKGROUND_LOCATION, etc.
#
# Plus shortcuts for the cases that are easy to get wrong:
#
#   perm.sh list <pkg>           # show currently-granted runtime perms
#   perm.sh appops get <pkg> [<op>]
#
# Many failures from `pm grant` look identical (`Bad permission name`,
# `Package <pkg> has no permission`, `... is not a runtime permission`);
# the script parses common cases into actionable rc + stderr.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  perm.sh [--serial X] grant   <pkg> <perm> [<perm>...]
  perm.sh [--serial X] revoke  <pkg> <perm> [<perm>...]
  perm.sh [--serial X] list    <pkg>
  perm.sh [--serial X] appops  set <pkg> <op> <mode>
  perm.sh [--serial X] appops  get <pkg> [<op>]

Permissions are typically the FQN form, eg.
  android.permission.RECORD_AUDIO
  android.permission.ACCESS_FINE_LOCATION
  android.permission.POST_NOTIFICATIONS

AppOps modes: allow, deny, ignore, default.
AppOps ops: PROJECT_MEDIA, ACCESS_BACKGROUND_LOCATION, MOCK_LOCATION, etc.
Run `perm.sh appops get <pkg>` to see what's currently set.

Exit codes:
  0   all listed permissions toggled successfully (or appops set/get OK).
  64  bad usage.
  65  appops bad-mode / unknown op / package not installed (typed at the
      single-call level).
  66  any failure in the grant/revoke loop — at least one perm failed;
      stderr carries the typed message per perm. (For grant/revoke we
      collapse all per-perm failures to 66 even when an individual
      diagnose was 65, to keep the loop semantics simple.)
  127 adb not found.
EOF
}

SERIAL="${ANDROID_SERIAL:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) break ;;
    esac
done

[[ $# -ge 1 ]] || { usage; exit 64; }
SUBCMD="$1"; shift

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
ADB="$(find_adb)" || { echo "perm: adb not found" >&2; exit 127; }

if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB_CMD=("$ADB")
[[ -n "$SERIAL" ]] && ADB_CMD+=(-s "$SERIAL")

# Diagnose a single pm grant/revoke failure into a typed message.
diagnose_pm() {
    local op="$1" pkg="$2" perm="$3" output="$4"
    case "$output" in
        *"Unknown permission"*|*"Bad permission name"*)
            echo "perm: unknown permission name: $perm (use the FQN form, eg. android.permission.RECORD_AUDIO)" >&2
            return 65
            ;;
        *"is not a runtime permission"*)
            echo "perm: $perm is not a runtime permission — use 'appops' for app-op gates instead." >&2
            return 65
            ;;
        *"has not requested permission"*|*"has no permission"*)
            echo "perm: $pkg has not declared $perm in its manifest." >&2
            return 65
            ;;
        *"Unknown package"*)
            echo "perm: package not installed: $pkg" >&2
            return 65
            ;;
        "") return 0 ;;
        *)
            echo "perm: $op failed for $pkg/$perm:" >&2
            echo "  $output" >&2
            return 66
            ;;
    esac
}

case "$SUBCMD" in
    grant|revoke)
        [[ $# -ge 2 ]] || { echo "perm: $SUBCMD needs <pkg> <perm> [<perm>...]" >&2; usage; exit 64; }
        PKG="$1"; shift
        TOTAL=$#
        FAILS=0
        OKS=0
        for PERM in "$@"; do
            OUT="$("${ADB_CMD[@]}" shell pm "$SUBCMD" "$PKG" "$PERM" 2>&1 || true)"
            if ! diagnose_pm "$SUBCMD" "$PKG" "$PERM" "$OUT"; then
                FAILS=$((FAILS + 1))
            else
                OKS=$((OKS + 1))
                # Confirmation breadcrumb. Silent success was misleading
                # in exploratory walks — operators couldn't tell whether
                # the call ran or hit a no-op typo. Past-tense verb so the
                # line reads as a state report, not an instruction.
                if [[ "$SUBCMD" == "grant" ]]; then
                    echo "perm: granted $PKG $PERM" >&2
                else
                    echo "perm: revoked $PKG $PERM" >&2
                fi
            fi
        done
        if [[ $FAILS -gt 0 ]]; then
            echo "perm: $FAILS of $TOTAL permissions failed" >&2
            exit 66
        fi
        ;;

    list)
        [[ $# -eq 1 ]] || { echo "perm: list needs <pkg>" >&2; usage; exit 64; }
        PKG="$1"
        OUT="$("${ADB_CMD[@]}" shell dumpsys package "$PKG" 2>&1 || true)"
        if [[ -z "$OUT" ]] || echo "$OUT" | grep -q "Unable to find package"; then
            echo "perm: package not installed: $PKG" >&2
            exit 65
        fi
        echo "$OUT" | awk '
            /requested permissions:/ {section="req"; next}
            /install permissions:/  {section="install"; next}
            /runtime permissions:/  {section="runtime"; next}
            section=="runtime" && /granted=true/  {print "GRANTED " $0}
            section=="runtime" && /granted=false/ {print "DENIED  " $0}
        ' | sed 's/^[[:space:]]*//'
        ;;

    appops)
        [[ $# -ge 1 ]] || { echo "perm: appops needs set|get" >&2; usage; exit 64; }
        APPOP_VERB="$1"; shift
        case "$APPOP_VERB" in
            set)
                [[ $# -eq 3 ]] || { echo "perm: appops set needs <pkg> <op> <mode>" >&2; usage; exit 64; }
                OUT="$("${ADB_CMD[@]}" shell appops set "$1" "$2" "$3" 2>&1 || true)"
                if [[ -n "$OUT" ]]; then
                    case "$OUT" in
                        *"Unknown package"*) echo "perm: package not installed: $1" >&2; exit 65 ;;
                        *"unknown op"*|*"Unknown operation"*) echo "perm: unknown appop: $2" >&2; exit 65 ;;
                        *"Bad mode"*|*"unknown mode"*|*"is not valid"*) echo "perm: bad mode: $3 (use allow|deny|ignore|default)" >&2; exit 65 ;;
                        *) echo "perm: appops set failed: $OUT" >&2; exit 66 ;;
                    esac
                fi
                echo "perm: appops set $1 $2=$3" >&2
                ;;
            get)
                [[ $# -ge 1 && $# -le 2 ]] || { echo "perm: appops get needs <pkg> [<op>]" >&2; usage; exit 64; }
                "${ADB_CMD[@]}" shell appops get "$1" ${2:+"$2"}
                ;;
            *)
                echo "perm: unknown appops verb: $APPOP_VERB (expected set|get)" >&2
                usage; exit 64
                ;;
        esac
        ;;

    *)
        echo "perm: unknown subcommand: $SUBCMD" >&2
        usage; exit 64
        ;;
esac
