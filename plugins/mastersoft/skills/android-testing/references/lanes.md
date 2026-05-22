# Lanes — UI driving triage

Three lanes for Android UI work. Lane A is the default in phase 2 and covers
almost everything the daemon batch can express; Lane B and C remain for
genuine pixel-only or long-async cases.

## TL;DR decision tree

```
diagnose_tree.py
  ├── recommended_lane=A → daemon batch via ui_run_flow.py (selectors + wait_for)
  ├── recommended_lane=B → tap_point + screen_hash.sh --diff (pixel-only screens)
  └── recommended_lane=C → screen_ring + state_listener (multi-minute async)
```

Re-probe `diagnose_tree.py` only when the foreground window changes (not per
action). Sticky lane key: `(package, activity, window-stack-hash)`. Invalidate on
`topResumedActivity` change, BACK/HOME/deep-link, WebView/dialog/IME flip, two
consecutive Lane A misses, or a Lane B tap with no pixel-hash delta.

## Lane A — daemon batch (default)

Use when the accessibility tree is faithful (`identified_count >= 4`, no WebView
blocker). Cheapest reliable lane. Per-action cost ~150–300 ms warm.

Quality controls (already wired into the daemon):
- `wait_for: ['sel']` after every action via the post-sync vocabulary.
- Two-consecutive-dumps stability check on selector resolve (Lane A's XML path).
- `fail_on_timeout: true` for triage scripts that need rc=124 to escalate.
- Per-batch `flow_timeout_ms` caps wall-clock across the whole flow.

```bash
SERIAL=$(${CLAUDE_SKILL_DIR}/scripts/device_pick.sh)
${CLAUDE_SKILL_DIR}/scripts/ui_run_flow.py --serial "$SERIAL" --stdin <<'EOF'
{"ops":[
  {"op":"tap","args":{"target":"text=\"Sign in\"","wait_for":["class=EditText,id=email"]}},
  {"op":"type","args":{"target":"class=EditText,id=email","text":"alice@example.com"}},
  {"op":"key","args":{"code":"KEYCODE_ENTER","wait_for":["text~\"Welcome\""],"fail_on_timeout":true}}
]}
EOF
```

Misses (false-positive Lane A):
- Article/static-content screens — many identified nodes, none tappable.
- Compose without `testTagsAsResourceId` — IDs missing on otherwise-rich trees.
  Selectors fall through to `text` / `desc`, which usually still works.
- WebView containers — uiautomator sees the container only; HTML invisible.
  See `references/ui-navigation.md` for the WebView handoff pattern.

When Lane A misses twice in a row (rc=124), step to Lane B or C based on the
latest `diagnose_tree.py` re-probe.

## Lane B — pixel-only screens

> Phase 2 update: most cases this lane used to handle now belong in Lane A
> via `tap_point`, the `window_sig` op for cheap activity/dialog change
> detection, and cache-aware `snapshot` for verifying state without an extra
> screencap. Reach for Lane B only when the accessibility tree stays
> unchanged but pixels move — Compose Canvas, WebView, in-flight animations.

Per-action cost ~200 ms (one screencap + one tap + one verifier screencap).

```bash
adb -s "$SERIAL" exec-out screencap -p > /tmp/before.png
# (model inspects /tmp/before.png, decides target is at 540,1200)
BEFORE_HASH=$(${CLAUDE_SKILL_DIR}/scripts/screen_hash.sh --serial "$SERIAL")
${CLAUDE_SKILL_DIR}/scripts/ui_act.py --serial "$SERIAL" tap-point 540 1200
RESULT=$(${CLAUDE_SKILL_DIR}/scripts/screen_hash.sh --serial "$SERIAL" --diff "$BEFORE_HASH")
case "$RESULT" in
    differ*) ;;  # state changed — action accepted
    same*)   echo "Lane B: no pixel delta — escalate to Lane C" >&2 ;;
esac
```

Region-cropped hash via `screen_hash.sh --region X,Y,W,H` reduces dilution from
stable UI chrome (requires ImageMagick).

False negatives (verifier reports `same` when action actually succeeded):
clock-bearing region in a region crop, sub-frame transitions that revert before
the second capture, dialogs that auto-dismiss too fast. Escalate to Lane C.

## Lane C — long async with frame ring + listener

> Phase 2 update: composed batches with `flow_timeout_ms` and a final
> `wait_for` cover most "wait until X" cases simpler and faster. Lane C is
> for genuinely long async flows (multi-minute uploads, payment redirects)
> where you also want a frame archive for post-mortem.

Architecture: a background ring captures frames at low cadence to disk
(`/tmp/android-skill-ring/<session>/<host_epoch_ms>.png`), a listener watches
multiple sources (logcat / activity / selector) and emits the host timestamp
on the first match, and the model reads ±2 s of frames around the event
instead of every frame.

```bash
SERIAL=$(${CLAUDE_SKILL_DIR}/scripts/device_pick.sh)
SESSION=$(date +%s%N); RING_DIR="/tmp/android-skill-ring/$SESSION"
mkdir -p "$RING_DIR"

${CLAUDE_SKILL_DIR}/scripts/screen_ring.sh \
    --serial "$SERIAL" --out-dir "$RING_DIR" \
    --interval 0.5 --max-age-min 10 --session-cap-mb 1024 --quiet &
RING_PID=$!

${CLAUDE_SKILL_DIR}/scripts/state_listener.sh \
    --serial "$SERIAL" --pkg com.example.app \
    --on-logcat 'Successfully logged in' \
    --on-activity '\.HomeActivity' \
    --on-selector 'text~"Welcome"' \
    --event-file /tmp/android-skill-event \
    --bundle-out /tmp/android-skill-bundle \
    --ring-dir "$RING_DIR" --timeout-sec 600 &
LISTENER_PID=$!

${CLAUDE_SKILL_DIR}/scripts/ui_act.py --serial "$SERIAL" tap 'text="Sign in"'
wait $LISTENER_PID; LISTENER_RC=$?

if [[ $LISTENER_RC -eq 0 ]]; then
    EVENT_MS=$(sed -nE 's/.*host_epoch_ms=([0-9]+).*/\1/p' /tmp/android-skill-event)
    FRAMES=$(${CLAUDE_SKILL_DIR}/scripts/ring_window.sh \
        --dir "$RING_DIR" --around "$EVENT_MS" --span-ms 2000 --max 5)
    # model now reads only those 5 frames
elif [[ $LISTENER_RC -eq 124 ]]; then
    cat /tmp/android-skill-bundle  # diagnostic bundle for re-evaluation
fi
kill -TERM $RING_PID 2>/dev/null
```

Why a ring + listener and not "screenshot every step": every PNG in
conversation context is 50–200 KB. The ring keeps frames on disk only; the
listener narrows the relevant moment to a 4-second window; the model reads ~5
frames per significant event. Token budget stays ~25 KB per HIL flow
regardless of length.

Ring eviction is by age (default 10 min) with a disk cap fuse (default 1 GB
per session). Frames inside the ±2 s pin window around recent activity are
never evicted. Purge globally with `rm -rf /tmp/android-skill-ring/`.

Timeout bundle (when `state_listener.sh` hits `--timeout-sec` with no match)
contains: host_epoch_ms, the regex/activity/selector waited for, current
foreground activity, top 15 lines of a fresh `ui_snapshot`, and the last 3
frame paths. Re-evaluate the lane: rich tree → resume Lane A; screen
changed but no marker fired → ask the user with the frames; nothing
changed → surface a clear timeout and stop.

## Quality vs cost ladder

| Cost | Mode | Quality controls active |
| --- | --- | --- |
| Cheap | Lane A, no `wait_for` | Selector validation only |
| Medium | Lane A + `wait_for` + stable resolve | + post-action sync, + mid-animation guard |
| High | Lane B with screen-hash verifier | + foreground activity check, + pixel delta |
| Premium | Lane C ring + multi-source listener | + on-failure structured bundle, + frame slice |

## Escalation policy

```
Lane A attempt 1 → success: done
Lane A attempt 1 → no resolve: re-dump with longer timeout, attempt 2
Lane A attempt 2 → no resolve: diagnose_tree.py → if thin/Compose-blind, Lane B
Lane B dispatch + verifier → "same" hash: Lane C with listener
Lane C TIMEOUT: emit bundle; re-probe lane once; if no progress, escalate to user
```

Each lane reports a structured rc / event the caller can branch on. No silent
failures.

## When to switch to Maestro for speed

Lane A pays one host↔device RTT per tap (~150–300 ms warm). For >15 taps on a
deterministic screen path, Maestro runs the whole flow device-side and
amortises authoring + install:

| Approach | 15-tap deterministic flow | Setup cost |
| --- | --- | --- |
| Lane A `ui_run_flow.py` | ~3–5 s | 0 |
| Maestro YAML | ~0.5–1 s | ~5–10 s install (one-time) + ~30 s authoring |

Don't reach for Maestro on first contact — Lane A's batch + `wait_for` +
proven-target chain covers most exploratory walks. Reach for it when the flow
runs repeatedly (regression suite, demo prep), the mechanical sequence is felt
as slow during iteration, or the flow should live in-repo as durable infra.
See `references/maestro.md` and `scripts/harvest-to-maestro.py`.
