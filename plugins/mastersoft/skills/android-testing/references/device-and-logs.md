# Devices and logs

Same `adb` interface drives emulators, USB-connected physical devices, and
wireless devices. The skill never starts a session for the user — pairing
and authorisation are interactive.

## Listing devices

```bash
adb devices -l
```

Healthy state is exactly `device`. Other states the picker drops:

| State | Meaning | Fix |
| --- | --- | --- |
| `unauthorized` | RSA prompt not answered on the device | Tap "Always allow from this computer" on the device |
| `offline` | adb sees it but the device-side daemon isn't responding | Reconnect USB; `adb kill-server && adb start-server` |
| `no permissions` | macOS/Linux permission issue on the USB node | Reattach; on Linux check `udev` rules |
| `recovery`, `sideload`, `bootloader` | Not booted into Android | Boot normally |

Use `scripts/device_pick.sh` to apply this filter consistently. It honours
`ANDROID_SERIAL`, picks the only healthy device when ambiguous, and prints a
table to stderr otherwise.

## Emulator startup

```bash
# List available AVDs
$ANDROID_HOME/emulator/emulator -list-avds            # or ~/Library/Android/sdk/...

# Start, headless or with UI
$ANDROID_HOME/emulator/emulator -avd Pixel_7_API_34 -no-snapshot-save &
```

The emulator process keeps running until killed. `adb wait-for-device` blocks
until it's online; `adb shell getprop sys.boot_completed` returns `1` when
fully booted.

```bash
# Robust wait
adb -s "$SERIAL" wait-for-device
until [[ "$(adb -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r')" == "1" ]]; do
    sleep 1
done
```

## Wireless adb

Android 11+ supports pairing without USB:

```bash
# On the device: Developer options → Wireless debugging → Pair device with pairing code
adb pair <device-ip>:<pair-port>      # paste the 6-digit code when asked

# After pairing, connect to the regular debug port
adb connect <device-ip>:<adb-port>
```

The pairing port is shown only on the dialog; the adb port is shown under
"IP address & Port" once wireless debugging is enabled. Wireless devices
appear as `<ip>:<port>` in `adb devices -l`.

## Useful one-liners

```bash
# Current foreground activity
adb -s "$SERIAL" shell dumpsys activity activities | grep -E 'ResumedActivity|mResumedActivity' | head -3

# Current package's PID(s)
adb -s "$SERIAL" shell pidof com.example.app

# Force-stop and re-launch
adb -s "$SERIAL" shell am force-stop com.example.app
adb -s "$SERIAL" shell am start -n com.example.app/.MainActivity

# Grant a runtime permission without going through the dialog
adb -s "$SERIAL" shell pm grant com.example.app android.permission.CAMERA

# Take a screenshot — hook-denied by default (the accessibility tree is the
# observation channel). For a genuine forensic frame, export the override
# into the session first: export ANDROID_SKILL_ALLOW_RAW_SCREENCAP=1
adb -s "$SERIAL" exec-out screencap -p > /tmp/screen.png

# Press a key
adb -s "$SERIAL" shell input keyevent KEYCODE_HOME

# Disable animations (faster instrumentation tests)
adb -s "$SERIAL" shell settings put global window_animation_scale 0
adb -s "$SERIAL" shell settings put global transition_animation_scale 0
adb -s "$SERIAL" shell settings put global animator_duration_scale 0
```

## logcat

`scripts/logcat_tail.sh` is the tested entry point. It re-resolves PIDs,
attaches multiple tailers (one per package PID), and runs a system-tag
watcher for crashes that happen *outside* the app process.

### Why not just `adb logcat --pid=$(pidof X)`

- App restart and crash-relaunch produce a new PID — `--pid` keeps watching
  a dead one.
- `pidof` may return multiple PIDs (services, isolated processes,
  WebView renderers). A single `--pid=` watches one of them.
- Java fatals (`AndroidRuntime`), ANRs (`ActivityManager`) and native crashes
  (`DEBUG`) are logged from system processes, not the app's PID.

### Direct logcat invocation (when you don't want the script)

```bash
# Single PID, limited tags, time-formatted
adb -s "$SERIAL" logcat -T 1 -v time --pid=12345 \
    AndroidRuntime:E ActivityManager:I '*:S'

# Buffer-specific (crash buffer carries FATAL EXCEPTION reliably)
adb -s "$SERIAL" logcat -b crash -T 1 -v time

# Save full log since boot
adb -s "$SERIAL" logcat -d -b all -v threadtime > /tmp/full.log
```

### Crash patterns

- **Java fatal**: line starting with `E AndroidRuntime: FATAL EXCEPTION:` —
  the next ~10 lines are the stack frames.
- **ANR**: `I ActivityManager: ANR in com.example.app` — useful but the
  trace dump goes to `/data/anr/traces.txt` (root or debuggable build).
- **Native crash**: `F DEBUG : signal 11 (SIGSEGV)` followed by a tombstone
  in `/data/tombstones/`.

`logcat_tail.sh --summarize-crashes` extracts all three from the captured
stream and prints a compact summary on exit.

### Useful filters

```bash
# Only this app's logs at warning+
adb logcat --pid=$(adb shell pidof com.example.app) '*:W'

# Network calls (OkHttp)
adb logcat OkHttp:D '*:S'

# Just one tag
adb logcat MyTag:V '*:S'
```

## Resetting state

```bash
# Wipe app data without uninstalling (keeps signature)
adb -s "$SERIAL" shell pm clear com.example.app

# Reinstall keeping data
adb -s "$SERIAL" install -r app-debug.apk

# Full uninstall
adb -s "$SERIAL" uninstall com.example.app
```

## macOS notes

- `adb` is auto-discovered from common SDK paths if not on PATH (`$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`).
- macOS does not ship GNU `timeout`. Use `logcat_tail.sh --max-duration N`
  instead of `timeout N logcat_tail.sh ...`.
- All shell scripts are bash-3.2-compatible (the macOS default — no `mapfile`,
  no `declare -A`).

## Multi-device

`device_pick.sh` honours `ANDROID_SERIAL`. With more than one healthy device
attached and no env var set, it prints a table to stderr and exits non-zero —
pick a serial and re-run with `ANDROID_SERIAL=<serial>`. Every script accepts
`--serial` and reads the session file written by `device_pick.sh`, so passing
`--serial` once per command is enough thereafter.

## Runtime permissions and AppOps

`scripts/perm.sh` wraps `pm grant` / `pm revoke` / `appops` with parsed
errors and a `list` shortcut.

```bash
# Grant or revoke runtime permissions (Android 6+).
${CLAUDE_SKILL_DIR}/scripts/perm.sh grant  com.example.app android.permission.RECORD_AUDIO
${CLAUDE_SKILL_DIR}/scripts/perm.sh grant  com.example.app android.permission.ACCESS_FINE_LOCATION android.permission.POST_NOTIFICATIONS
${CLAUDE_SKILL_DIR}/scripts/perm.sh revoke com.example.app android.permission.RECORD_AUDIO

# Inspect what's granted right now.
${CLAUDE_SKILL_DIR}/scripts/perm.sh list   com.example.app

# AppOps — gates that aren't normal runtime permissions (PROJECT_MEDIA,
# ACCESS_BACKGROUND_LOCATION, etc.). Modes: allow|deny|ignore|default.
${CLAUDE_SKILL_DIR}/scripts/perm.sh appops set com.example.app PROJECT_MEDIA allow
${CLAUDE_SKILL_DIR}/scripts/perm.sh appops get com.example.app
```

Common errors mapped to actionable rc:
- rc=65: single-call typed errors (`appops` bad-mode / unknown op,
  `list` on a missing package).
- rc=66: any failure in `grant` / `revoke`; per-perm typed messages on
  stderr. The grant/revoke loop collapses 65-style typed errors to 66 —
  read stderr for the exact reason per perm.
Run with no args for full usage.

## Database seeding (debug builds only)

`scripts/seed_db.sh` pipes SQL into the app's sqlite database via `run-as`.
Only works when the build is debuggable; release builds reject `run-as`.

```bash
# Inline SQL.
${CLAUDE_SKILL_DIR}/scripts/seed_db.sh com.example.app app.db \
    "INSERT INTO users (id, name) VALUES (1, 'alice');"

# From a file (lots of statements, schema bootstrap).
${CLAUDE_SKILL_DIR}/scripts/seed_db.sh --file /tmp/seed.sql com.example.app app.db

# From stdin via `-`.
echo "DELETE FROM events WHERE created < $(date -v-7d +%s);" | \
    ${CLAUDE_SKILL_DIR}/scripts/seed_db.sh com.example.app app.db -
```

Failure modes mapped to typed messages: not-debuggable (rc=65), missing
schema (`launch the app once so migrations run`), database locked (`force-stop
the app first`), wrong filename (`db file not found at databases/<name>`).
SharedPreferences and DataStore aren't covered — they have stale-cache and
force-stop semantics that don't generalise into a wrapper. Edit them via
in-app test hooks instead.
