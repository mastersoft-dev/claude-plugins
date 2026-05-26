# UI Navigation — selectors, pruning, and gotchas

The selector grammar that `ui_snapshot.py --query` and `ui_act.py tap|type`
accept, plus the failure modes you will hit on real apps.

## Output line format

```
[uid]  Class           text="..."   desc="..."   id=...   clickable   b=cx,cy
```

- `uid` — `u1`, `u2`, … assigned in document order, **per call**. Do not cache
  across snapshots.
- `Class` — short class name (`Button`, `EditText`, `RecyclerView`).
- `text` / `desc` / `id` — only when non-empty. Release builds often strip
  `resource-id`; lean on `text` and `content-desc` then.
- `clickable` — present only when the node is `clickable="true"`.
- `b=cx,cy` — centre point of the node's bounds. Suppress with
  `--include-bounds=false` when reading state without acting.

## Selector grammar

| Clause | Meaning |
| --- | --- |
| `text="exact"` | exact match against `text` |
| `text~"sub"` | case-insensitive substring match against `text` |
| `desc="exact"` / `desc~"sub"` | same against `content-desc` |
| `id=resource_id` | exact match; full (`com.x:id/btn`) or short (`btn`) |
| `id~"sub"` | case-insensitive substring match against the full resource-id |
| `class=ClassName` | exact match; FQN (`android.widget.Button`) or short (`Button`) |
| `class~"sub"` | case-insensitive substring match against the FQN class |
| `clickable=true` / `focused=true` | state filters |

`ui_snapshot.py --query` takes them via `--query` (repeatable for AND);
`ui_act.py tap|type` takes them inline as a single comma-separated string.
When multiple nodes match, `ui_act.py` resolution order is: clickable wins,
then nodes with bounds, then document order.

```bash
scripts/ui_act.py tap 'text="Sign in"'
scripts/ui_act.py tap 'class=EditText,id=email'
scripts/ui_snapshot.py --query 'text~"password"'
```

## Pruning modes

`ui_snapshot.py` always drops nodes with no identifying attribute and no kept
descendants. Beyond that:

| Flag | Effect |
| --- | --- |
| `--only-clickable` | keep only `clickable=true` nodes; use for tap planning |
| `--query <sel>` | post-filter the kept set (repeatable, AND) |
| `--max-lines N` | cap output; trailing line reports drop count |
| `--include-bounds=false` | strip `b=cx,cy`; reading state, not acting |
| `--no-cache` | skip writing the XML cache |

## Sync between act and snapshot

Each `ui_act.py` subcommand (and `ui_snapshot.py` itself):

| Flag | Behaviour |
| --- | --- |
| `--wait-for <selector>` | poll dumps until the selector matches. Most reliable. |
| `--wait-stable-ms N` | poll until two dumps N ms apart are byte-equal |
| `--post-wait-ms N` | crude fixed sleep; last resort |
| `--timeout SEC` (`ui_act.py`) | float seconds, default 5 |
| `--timeout-ms N` (`ui_snapshot.py`) | int ms, default 5000 |

For selector targets, `ui_act.py` auto-dumps fresh and only taps after the
target appears at the **same bounds in two consecutive dumps**
(mid-animation protection). Override with `--no-stable-resolve` when speed
beats correctness. `focused=true` is what `type` polls internally to know a
tap-to-focus landed before sending text.

## Typing non-ASCII text

`ui_act.py type` auto-routes by content:
- ASCII → raw `adb shell input text` (fast, no deps).
- Non-ASCII → uiautomator2 `send_keys` via the device-side agent (requires
  `--backend auto|u2` and `scripts/install_u2.sh`).
- Non-ASCII + `--backend raw` → fail-closed with rc=1; the raw path silently
  substitutes `?` and corrupting test data is worse than refusing.

```bash
ui_act.py type 'class=EditText,id=name' "Alice"          # raw fast path
ui_act.py type 'class=EditText,id=name' "Élise — 北京"   # auto-routes to u2
ui_act.py --backend raw type 'id=note' "café"            # rc=1 with hint
```

## Empty results

If `ui_snapshot.py --query` (or `--only-clickable`) returns nothing on
stdout, stderr carries a diagnostic:

```
ui_snapshot: 0 nodes after filters [...]. Pre-query kept N pruned nodes.
Foreground: <activity>
```

The `Pre-query kept N pruned nodes` count is the load-bearing signal:

- **Pruned > 0** → filter too tight. Tree is non-empty, your filter
  threw out everything matching it. Loosen the filter.
- **Pruned = 0** → tree itself is empty. The window may be a
  Compose Canvas / `View.onDraw` surface, an inflating activity, a
  fullscreen video player (e.g. screensaver `id=exo_content_frame`), or
  the IME just stole focus. Wake / dismiss / wait, then re-snapshot.

### 0-node recovery — never retry identical filters

The reflexive failure: empty result → `sleep 2` → identical retry →
empty again → escalate to `screencap` + `Read()`. Cure: each retry
loosens one constraint or switches to `describe`.

| Step | Try | Why |
|---|---|---|
| 1. Filter too tight (pruned > 0) | Drop `--only-clickable`; bump `--max-lines` to 200 | Decorative TextViews / non-clickable containers carry the missing anchor |
| 2. Still empty after step 1 | `ui_snapshot.py --include-bounds=false --max-lines 300` (no other filter) | Full tree, no pruning |
| 3. Tree genuinely empty (pruned = 0) | `describe` op with the selector you EXPECT for the screen you THINK you're on | Confirms identity without re-dumping |
| 4. Still empty after step 3 | Check `Foreground:` line in stderr. Different activity than expected? Wake / pop screensaver / launch app | Might be on system UI, screensaver, or a different activity entirely |
| 5. All four fail | The screen is structurally invisible to uiautomator (Compose Canvas, ExoPlayer surface). `window_sig` op for hash-only state, or escalate to a frame `Read()` (which now prompts for confirmation) |

**Never** `sleep N` between two identical `ui_snapshot.py` calls hoping
the result changes. The tree is what it is; sleep doesn't add nodes.
Loosen the query OR switch tools (describe, window_sig).

## Gotchas

**Lazy / scrollable lists** — only the rendered rows appear. Scroll and
re-snapshot:

```bash
# Raw `adb shell input swipe` is hook-denied — use the daemon `swipe` op
# inside a ui_run_flow.py batch, chained with wait_for:
#   {"op":"swipe","args":{"x1":540,"y1":1700,"x2":540,"y2":700,"duration_ms":300}}
# See references/flow-composition.md.
scripts/ui_snapshot.py --query 'text~"target row"'
```

**IME (soft keyboard)** — when up, the bottom of the activity is occluded but
the dump still includes those nodes with their original bounds. A tap may
land on the keyboard. Dismiss with the `dismiss_ime` op (IME-aware; no-op when
no keyboard is up). **Never** `key KEYCODE_BACK` to close the IME — BACK is
double-overloaded and, with no IME visible, navigates back and silently pops
the current wizard step (see `references/failure-modes.md` §14).

**Permission dialogs** — `com.android.permissioncontroller` overlays the
foreground app. Selectors like `text="Allow"` work directly. After granting,
the app behind comes back into focus. Prefer `scripts/perm.sh grant` to
seed permissions before walking — fewer dialogs in the path.

**Compose without `testTagsAsResourceId`** — `Modifier.testTag("foo")` is
invisible to uiautomator unless the activity opts in via
`Modifier.semantics { testTagsAsResourceId = true }`. `Text`/`Image`
composables expose `text`/`contentDescription` automatically; lean on those
or switch to Compose Test (see `references/gradle-tests.md`) rather than
patching production code with test-only modifiers.

**Stale bounds after animations** — `ui_act.py` polls a fresh snapshot up
to `--timeout` seconds (default 5), but if a node is found at *wrong* coords
mid-animation, the tap lands wrong. For animation-locked transitions, add a
`sleep` op (or `pre_macro_sleep_ms`) — see `references/flow-composition.md`.

**Release builds strip resource-id** — ProGuard/R8 default removes
`resource-id` from views. If `id=` selectors fail on release builds, fall
back to `text` / `desc` / `class` + position.

**Multi-window / split-screen** — Android 7+ split-screen and 12+ taskbar
can render the focused activity without making it the only window. The dump
reports the active window only; if `am start` succeeded but the dump looks
empty, check `adb shell dumpsys activity activities | head -20`.

**WebView containers** — uiautomator sees the container only; HTML stays
invisible. Either use Compose Test / Espresso for WebView content, or hand
off to a browser automation tool that speaks the WebView's debug bridge.

**Sidecar invalidation** — `ui_snapshot.py` writes a uid sidecar at
`${TMPDIR}/android-skill-<serial>.meta`. The window-signature pre/post check
inside the writer refuses to publish the sidecar if the foreground window
changed during the dump (animation, screensaver, IME flip). `tap uN` then
fails with "no uid sidecar". Use selectors instead, or chain snapshot → tap
inside `ui_run_flow.py` so no host-side gap exists.

## Five-step loop (exploratory UI driving)

Snapshot once, act many, confirm via a `--wait-for` anchor at the end.

```bash
SERIAL=$(${CLAUDE_SKILL_DIR}/scripts/device_pick.sh)
adb -s "$SERIAL" shell am start -n com.example.app/.MainActivity
${CLAUDE_SKILL_DIR}/scripts/logcat_tail.sh --serial "$SERIAL" --pkg com.example.app \
    --summarize-crashes --output /tmp/log.txt &
LOG_PID=$!

${CLAUDE_SKILL_DIR}/scripts/ui_snapshot.py --serial "$SERIAL" --only-clickable
${CLAUDE_SKILL_DIR}/scripts/ui_act.py --serial "$SERIAL" tap  'text="Sign in"'  --wait-for 'class=EditText,id=email'
${CLAUDE_SKILL_DIR}/scripts/ui_act.py --serial "$SERIAL" type 'class=EditText,id=email' "alice@example.com"
${CLAUDE_SKILL_DIR}/scripts/ui_act.py --serial "$SERIAL" key  KEYCODE_ENTER --wait-for 'text~"Welcome"'

# Outcome is already confirmed by the --wait-for anchor above — the tree is
# the observation channel. Raw screencap is hook-denied; for a genuine
# forensic frame, read the BG trace ui_run_flow.py writes, or export
# ANDROID_SKILL_ALLOW_RAW_SCREENCAP=1 to capture explicitly.
kill -TERM $LOG_PID
```

`[uX]` uid form (`tap u3`) is a fallback — valid only between snapshot+act
with no filter changes in between, and only inside the 15 s sidecar TTL
(`ANDROID_SKILL_UID_TTL_MS`).

## Quick recipes

```bash
# tap a row by visible text
scripts/ui_act.py tap 'text~"Wi-Fi"'

# type into a field then submit
scripts/ui_act.py tap  'class=EditText,id=email'
scripts/ui_act.py type 'class=EditText,id=email' "alice@example.com"
scripts/ui_act.py key  KEYCODE_TAB
scripts/ui_act.py type 'class=EditText,id=password' "hunter2"
scripts/ui_act.py key  KEYCODE_ENTER

# read state without acting
scripts/ui_snapshot.py --include-bounds=false --max-lines 60

# confirm an outcome — assert the expected anchor (tree is the observation
# channel; raw screencap is hook-denied, override only for a forensic frame)
scripts/ui_snapshot.py --query 'text~"expected result"'
```
