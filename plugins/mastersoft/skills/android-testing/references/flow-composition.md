# Flow composition — declaring fast multi-step UI flows

When the LLM has explored a screen and knows the path ahead, it should
declare the whole flow as one batch via `ui_run_flow.py`. Each sub-op
runs daemon-side; the entire batch is one host↔device round-trip from
the client's POV. This is the LLM-friendly path for "I understand the
UI; now run the work fast."

This page documents:
1. The full primitive inventory.
2. The composition pattern for animation-sensitive flows.
3. When to fall back to per-tap with `wait_for`.

---

## Primitive inventory (sub-ops accepted by `ui_run_flow.py`)

All daemon sub-ops accept the same post-sync vocabulary:
`post_wait_ms`, `wait_for`, `wait_for_any`, `wait_stable_ms`, `timeout_ms`,
`fail_on_timeout`.

**Important:** `wait_for` is **AND across clauses on a SINGLE node**. Listing
two selectors there means "find one node that satisfies BOTH"; this is rarely
what an LLM means when reading "wait for X or Y to appear". Use `wait_for_any:
[sel1, sel2, ...]` for OR semantics — first selector that matches ANY node
wins. Common shape: `wait_for_any: ["text=\"Welcome\"", "text~\"Error\""]` to
let the same flow handle both success and error post-states.

### Mutating actions (bump `_mutation_gen`, invalidate snapshot cache)

| Sub-op | Args | When |
|---|---|---|
| `tap` | `target` (selector or uid), `timeout` | One verified tap, with optional `wait_for` sync. Default for any single action where you want sel.exists() proof before clicking. |
| `tap_point` | `x`, `y` | Raw coord tap. No selector resolution, no exists() probe. For Compose Canvas / custom-draw widgets that have no accessibility node. |
| `tap_macro` | `taps`: `[[x,y],...]`, `delay_ms` (default 80) | N coordinate taps as a single shell invocation. Single host↔device RTT for the whole sequence. Caller resolves coords. No per-tap verification. Best for keypad-style mechanical sequences. |
| `resolve_then_tap_sequence` | `selectors`: `[str,...]`, `assume_stable_coords: true` (REQUIRED), `delay_ms`, `pre_macro_sleep_ms`, `miss_policy: abort\|skip` | Resolves N selectors against ONE pre-macro dump, dispatches as `tap_macro`. The contract: caller asserts targets are co-resident on a stable layout (keypad, dialog, list-of-buttons). Mode-toggling keypads break the contract — split into per-mode sub-sequences. |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `duration_ms` (default 300) | Drag/scroll/dismiss. Goes to `adb shell input swipe`. |
| `long_press` | `x`, `y`, `duration_ms` (default 1500) | Hidden/admin gestures (kiosk settings reveal, etc.). Same `input swipe` primitive with start==end. |
| `type` | `target`, `text` | Focus-and-replace. uses u2 `set_text` (replaces field content; pass `--clear` semantics for free). |
| `key` | `code` (e.g. `KEYCODE_ENTER`) | Synthesise a key event. |

### Non-mutating (no `_mutation_gen` bump, no cache invalidation)

| Sub-op | Args | When |
|---|---|---|
| `sleep` | `ms` (clamped 0–10000) | Pause without polling. Use for **animation gaps** when `wait_for` doesn't suffice (Compose may render the new state before its click handler binds — explicit sleep covers that). |
| `snapshot` | `only_clickable`, `query`, `max_lines`, `include_bounds`, `force_dump` | Dump the accessibility tree as text. Cache-aware: when no mutation since last dump, returns cached XML in ~50 ms (no live `uiautomator dump`). |
| `screencap` | `path`, `backend: u2\|adb`, `format: png\|jpeg`, `quality` | Save a screenshot. Default `u2`+`png` — ~90 ms warm. JPEG via u2 is ~80 ms with substantially smaller file. |
| `window_sig` | — | Cheap window-state hash. Use to detect activity / dialog / IME transitions cheaply. |
| `health` | — | Daemon liveness + counters. |

---

## Composition pattern: open → animation gap → fast macro → sync

When the LLM knows the next 5–15 actions, the canonical batch shape is:

```json
{"ops": [
  {"op":"tap", "args":{"target":"<thing-that-opens-screen>",
                       "wait_for":["<expected-rendered-marker>"]}},
  {"op":"sleep", "args":{"ms": 150}},
  {"op":"resolve_then_tap_sequence", "args":{
      "selectors": ["<sel-1>", "<sel-2>", "<sel-3>"],
      "assume_stable_coords": true,
      "delay_ms": 100
  }},
  {"op":"tap", "args":{"target":"<submit>",
                       "wait_for":["<result-marker>"]}}
]}
```

Why three phases:

1. **Open with `wait_for`.** Synchronises on rendered state — the next
   selector must exist. `wait_for` is necessary but not sufficient: it
   proves the node is visible, NOT that its click handler is bound.
2. **Sleep for animation.** Compose can finish its frame before the
   gesture listener attaches. The LLM, having explored this surface,
   knows whether a transition has a slide-in / scale / cross-fade and
   how much time it needs (~100–300 ms is the typical kiosk range).
   Skill stays mechanical; semantics live in the LLM.
3. **Fast macro.** With state stable AND interactive, fire the whole
   coord sequence as one shell command. Single RTT. ~80–120 ms
   per-tap delay handles intra-macro recompose (e.g. button press
   animations).
4. **Submit + sync.** Fall back to `tap` + `wait_for` for the final
   action where you need to verify the result.

### `pre_macro_sleep_ms` shortcut

`resolve_then_tap_sequence` accepts `pre_macro_sleep_ms` so a transition
+ macro can be expressed as one sub-op:

```json
{"op":"resolve_then_tap_sequence","args":{
  "selectors":[...],
  "assume_stable_coords":true,
  "pre_macro_sleep_ms":200,    // sleep AFTER resolve dump, BEFORE macro
  "delay_ms":100
}}
```

The dump runs fresh (capturing post-transition coords correctly), then
the sleep covers handler-bind, then the macro fires. Use this when one
mode-toggle precedes the whole sequence.

---

## Pre-flight: verify the starting screen

The most common cause of a flow failing at op[0] is "we're not on the screen
we thought we were on" — countdown elapsed on a previous result screen, the
user pressed BACK, the app crashed, the screensaver kicked in. Catch this
cheaply with a `describe` op or, on `ui_run_flow.py`, `--require-anchor`:

```bash
ui_run_flow.py --serial $SERIAL \
    --require-anchor 'desc="Presenza"' \
    --require-anchor 'desc="Impostazioni"' \
    --file flow.json
```

The pre-flight runs ONE `describe` against the cached XML (no taps, no live
dump if cache is current) and exits with rc=64 + a clear "missing X" message
if any anchor selector misses. Cheaper than the wrong-screen tap chain that
fails 5 seconds in and dirties state.

## Countdown screens belong in the same batch

Some result screens auto-dismiss on a countdown (the kiosk's
`OperationResultScreen` returns to the parent submenu after ~15 s). Any tap
you intend to make on that screen — including "Timbratura normale" or
similar causale picks — must live in the SAME `ui_run_flow.py` batch as the
action that produced the screen. The IPC round-trip back to the host between
two separate batches is enough to miss the countdown.

The shape:

```json
{"ops":[
  {"op":"tap","args":{"target":"desc=\"Invia\"","wait_for":["text=\"Timbratura normale\""],"timeout_ms":8000}},
  {"op":"tap","args":{"target":"text=\"Timbratura normale\"","wait_for_any":["desc=\"Presenza\"","desc=\"Timbra\""],"timeout_ms":8000}}
]}
```

Wrong: send `Invia` in batch 1, then a separate batch with `tap Timbratura
normale`. Result screen will have auto-dismissed by the time batch 2 starts.

## When NOT to use the macro path

The macro path trades reliability for speed. Drop it back to per-tap
`tap`+`wait_for` when:

- **Coordinates aren't stable across taps.** Mode-toggling keypads are
  the canonical example: ABC↔123 toggle re-lays the keys, so resolving
  all of `["text=3","text=ABC","text=D",...]` against one dump returns
  wrong coords for half the selectors. Split into per-mode sequences,
  with regular `tap` ops for the toggles in between.
- **The path branches on response content.** If "tap A; if B appears tap
  X else tap Y", the LLM needs to inspect state mid-flow. Macros are
  blind.
- **Verification matters per step.** Test assertions, regression
  scripts: prefer one `tap`+`wait_for` per assertion so a failure points
  to the exact step.
- **Selectors might miss.** `miss_policy:"abort"` returns rc=1 on the
  first miss; macros are all-or-nothing. If the LLM is uncertain about
  one of the targets, run that specific selector via `tap`.

---

## Performance reference (warm daemon, emulator)

| Sub-op | Typical wall-clock | Notes |
|---|---|---|
| `tap` | 250–400 ms | 2 jsonrpc RTTs (exists + click); ~100 ms saved when prior `wait_for` proved the same selector (auto). |
| `tap_point` | 30–60 ms | Pure `adb shell input tap`. |
| `tap_macro` (10 taps, 80 ms delay) | ~900 ms | Includes 9× 80 ms inter-tap delay; the daemon RTT is a few ms. |
| `resolve_then_tap_sequence` (10 selectors) | ~1.0–1.2 s | One dump + one macro. |
| `sleep` | exactly the requested ms | Daemon-side `time.sleep`. |
| `snapshot` (cache hit) | ~50 ms | No live dump; reads cached XML. |
| `snapshot` (cache miss) | 200–500 ms | One u2 `dump_hierarchy`. |
| `screencap` (u2 PNG) | ~90 ms | u2 native path. |
| `screencap` (u2 JPEG) | ~80 ms | Smaller file too. |
| `screencap` (adb PNG) | ~170 ms | Fallback path; better PNG compression. |

---

## Worked example: 8-char badge entry on a mode-toggling keypad

The kiosk's `Inserisci codice` dialog has a numeric keypad with an
ABC/123 toggle. Typing `3D3094FF` requires switching modes 3×. The
macro path doesn't survive a mode switch — split per mode:

```json
{"ops": [
  {"op":"tap","args":{"target":"desc=\"Inserisci codice\"",
                      "wait_for":["text=\"Inserisci codice badge\""]}},
  {"op":"resolve_then_tap_sequence","args":{
     "selectors":["text=\"3\""], "assume_stable_coords":true}},

  {"op":"tap","args":{"target":"text=\"ABC\"","wait_for":["text=\"D\""]}},
  {"op":"sleep","args":{"ms":200}},
  {"op":"resolve_then_tap_sequence","args":{
     "selectors":["text=\"D\""], "assume_stable_coords":true}},

  {"op":"tap","args":{"target":"text=\"123\"","wait_for":["text=\"3\""]}},
  {"op":"sleep","args":{"ms":200}},
  {"op":"resolve_then_tap_sequence","args":{
     "selectors":["text=\"3\"","text=\"0\"","text=\"9\"","text=\"4\""],
     "assume_stable_coords":true,
     "delay_ms":120}},

  {"op":"tap","args":{"target":"text=\"ABC\"","wait_for":["text=\"F\""]}},
  {"op":"sleep","args":{"ms":200}},
  {"op":"resolve_then_tap_sequence","args":{
     "selectors":["text=\"F\"","text=\"F\""],
     "assume_stable_coords":true,
     "delay_ms":150}},

  {"op":"tap","args":{"target":"desc=\"Invia\"",
                      "wait_for":["text~\"3D3094FF\""]}}
]}
```

Each mode toggle becomes a `tap` (synchronised) + `sleep` (animation
gap). Within a mode, taps run as a fast `resolve_then_tap_sequence`.
The final `Invia` tap waits on the rendered confirmation.

Note: animation-sensitive flows can still drop a tap occasionally on
slow devices. If reliability matters more than speed (regression tests,
demo prep), use plain `tap`+`wait_for` per character — slower, but the
verification is per-step.
