#!/usr/bin/env bash
# seed_db.sh — pipe SQL into an app's sqlite database via run-as.
#
# Only works on debuggable builds. The `run-as` shell helper is the supported
# non-root path into /data/data/<pkg>/. Release builds reject `run-as` even
# for the matching uid, so this script fails closed with a clear message.
#
# Usage:
#   seed_db.sh [--serial X] <pkg> <db-relname> <sql-or-->
#   seed_db.sh [--serial X] --file <path> <pkg> <db-relname>
#   echo "INSERT ..." | seed_db.sh [--serial X] <pkg> <db-relname> -
#
# <db-relname> is the file name under databases/, eg. `app.db`. The script
# does not look up any cache directory — pass exactly what your app writes.
#
# Common errors and what they mean:
#   "Package is not debuggable" — the build was signed in release mode; build
#       a debug variant or seed via an in-app test hook.
#   "no such table" — the schema hasn't been created yet. Launch the app
#       once so onCreate / Room migration runs, then re-run seed_db.sh.
#   "database is locked" — the app process holds an open handle. Either
#       force-stop the app first (`adb shell am force-stop <pkg>`) or use
#       BEGIN IMMEDIATE; ... COMMIT; in your SQL with retry.

set -eu

usage() {
    cat <<'EOF' >&2
Usage:
  seed_db.sh [--serial X] <pkg> <db> <sql|->
  seed_db.sh [--serial X] --file <path> <pkg> <db>

Options:
  --serial <id>     adb device (default: ANDROID_SERIAL or session file).
  --file <path>     Read SQL from a file instead of an inline arg.
  -h, --help        This message.

Positional:
  <pkg>             Application package id (must be debuggable).
  <db>              Database file name under databases/ (eg. `app.db`).
  <sql|->           Inline SQL, or `-` to read from stdin.

Exit codes:
  0   sqlite3 returned 0 (statements executed).
  64  bad usage.
  65  package not debuggable / run-as refused.
  66  sqlite3 reported an error (stderr forwarded).
  127 adb not found.
EOF
}

SERIAL="${ANDROID_SERIAL:-}"
SQL_FILE=""
PKG=""
DB=""
SQL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --serial) SERIAL="$2"; shift 2 ;;
        --file)   SQL_FILE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "seed_db: unknown flag: $1" >&2; usage; exit 64 ;;
        *)  break ;;
    esac
done

if [[ -n "$SQL_FILE" ]]; then
    [[ $# -ge 2 ]] || { echo "seed_db: --file needs <pkg> <db>" >&2; usage; exit 64; }
    PKG="$1"; DB="$2"
elif [[ $# -ge 3 ]]; then
    PKG="$1"; DB="$2"; SQL="$3"
else
    echo "seed_db: missing arguments" >&2; usage; exit 64
fi

case "$DB" in
    */*) echo "seed_db: <db> must be a bare filename, not a path: $DB" >&2; exit 64 ;;
esac

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
ADB="$(find_adb)" || { echo "seed_db: adb not found" >&2; exit 127; }

if [[ -z "$SERIAL" ]]; then
    SESSION_FILE="${TMPDIR:-/tmp}/android-skill-session/serial"
    [[ -f "$SESSION_FILE" ]] && SERIAL="$(cat "$SESSION_FILE")"
fi
ADB_CMD=("$ADB")
[[ -n "$SERIAL" ]] && ADB_CMD+=(-s "$SERIAL")

# Probe debuggable: `run-as <pkg> id` exits 0 only when the build allows it.
PROBE_OUT="$("${ADB_CMD[@]}" shell "run-as $PKG id" 2>&1 || true)"
case "$PROBE_OUT" in
    *"is not debuggable"*|*"unknown package"*|*"run-as: package not debuggable"*|*"not an application"*)
        echo "seed_db: package not debuggable: $PKG" >&2
        echo "  $PROBE_OUT" >&2
        exit 65
        ;;
    *"uid="*) ;;  # OK
    "")
        echo "seed_db: empty response from run-as probe; is the device unlocked?" >&2
        exit 65
        ;;
    *)
        echo "seed_db: run-as probe failed for $PKG:" >&2
        echo "  $PROBE_OUT" >&2
        exit 65
        ;;
esac

# Preflight: confirm the DB file exists. Without this, sqlite3 silently
# creates `databases/<typo>.db` and seeds into the wrong file. The check
# runs as the app uid, so it sees what sqlite would see.
DB_PROBE="$("${ADB_CMD[@]}" shell "run-as $PKG sh -c 'test -f databases/$DB && echo OK || echo MISSING'" 2>&1 || true)"
case "$DB_PROBE" in
    *OK*) ;;
    *MISSING*)
        echo "seed_db: db file not found at databases/$DB for $PKG." >&2
        echo "  Either the schema hasn't been created yet (launch the app once" >&2
        echo "  so onCreate / Room migration runs), or you typed the filename wrong." >&2
        echo "  List actual db files: adb -s <serial> shell run-as $PKG ls databases/" >&2
        exit 65
        ;;
    *)
        echo "seed_db: cannot stat databases/$DB on device:" >&2
        echo "  $DB_PROBE" >&2
        exit 65
        ;;
esac

# Resolve SQL source. The on-device sqlite3 reads from stdin so we just
# stream whatever the caller gave us.
if [[ -n "$SQL_FILE" ]]; then
    [[ -r "$SQL_FILE" ]] || { echo "seed_db: cannot read --file $SQL_FILE" >&2; exit 64; }
    SQL_INPUT_CMD=(cat "$SQL_FILE")
elif [[ "$SQL" == "-" ]]; then
    SQL_INPUT_CMD=(cat)
else
    SQL_INPUT_CMD=(printf '%s\n' "$SQL")
fi

# `run-as <pkg> sqlite3 databases/<db>` — the trailing path is relative to
# the package's home dir on the device. sqlite3 is shipped with Android since
# API 28. Errors land on stderr; we capture both streams to triage exit code.
REMOTE_CMD="run-as $PKG sqlite3 databases/$DB"
TMP_ERR="$(mktemp -t seed_db_err.XXXXXX)"
trap 'rm -f "$TMP_ERR"' EXIT

set +e
"${SQL_INPUT_CMD[@]}" | "${ADB_CMD[@]}" shell "$REMOTE_CMD" 2>"$TMP_ERR"
RC=$?
set -e

# sqlite3 returns 1 on most errors (no such table, syntax error, etc.).
# Normalise any failure to rc=66 so callers can distinguish "package /
# preflight problems" (65) from "sqlite said no" (66).
if [[ $RC -ne 0 ]] || [[ -s "$TMP_ERR" ]]; then
    cat "$TMP_ERR" >&2
    if grep -q "no such table" "$TMP_ERR" 2>/dev/null; then
        echo "seed_db: schema missing — launch the app once so migrations run, then retry." >&2
    elif grep -q "database is locked" "$TMP_ERR" 2>/dev/null; then
        echo "seed_db: db locked by running app — try 'adb shell am force-stop $PKG' first." >&2
    elif grep -q "unable to open database" "$TMP_ERR" 2>/dev/null; then
        echo "seed_db: cannot open databases/$DB — re-check the filename and pkg permissions." >&2
    elif grep -q "syntax error" "$TMP_ERR" 2>/dev/null; then
        echo "seed_db: SQL syntax error — see message above." >&2
    fi
    exit 66
fi

exit 0
