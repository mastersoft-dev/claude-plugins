# Failure modes — what goes wrong, why, what to do

Observed failures from real sessions. Read this BEFORE you write the
flow, not after it dies. The pattern is always the same: the LLM had
the right primitive available, didn't reach for it, and burned 5 minutes
of debug + tokens on a flow that should have been one batch.

## 1. Mode-toggle keypad race (BADGE NON VALIDO)

**What it looks like.** A keypad with an `ABC ⇄ 123` toggle. The flow
taps `text="ABC"`, then immediately taps `text="3"`. Some taps land
on stale (recomposed-but-not-yet-bound) cells. Output is garbled —
e.g. typed "3094FF" comes through as "094FF3" or "BADGE NON VALIDO".

**Why.** Compose finishes the recompose frame BEFORE the gesture
listener attaches. `wait_for: ["text=\"D\""]` proves the cell is
RENDERED, not BOUND. A back-to-back tap lands during the bind gap.

**Cure.** After every mode-toggle, chain `wait_for` AND `sleep` 200-300
ms before the next tap:

```jsonc
{"op":"tap","args":{"target":"text=\"ABC\"","wait_for":["text=\"D\""]}},
{"op":"sleep","args":{"ms":250}},
{"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"D\""],"assume_stable_coords":true}},
```

`sleep` is a daemon op, doesn't block any external resource, and is the
explicit way to declare an animation gap. `wait_for` alone is not enough.

## 2. Micro-batch instead of one batch

**What it looks like.** Eight separate `ui_run_flow.py` invocations for
a 22-op flow whose path is known after step three. Each pays subprocess
spawn (~150 ms), `--require-anchor` describe (~80 ms warm), and creates
its own trace dir.

**Why.** Default LLM caution: tap, snapshot to "verify", tap, snapshot to
"verify". Verification is the right impulse on the FIRST traversal of an
unfamiliar screen — wrong as a steady-state habit.

**Cure.** As soon as you can answer "what's the rest of the path?"
with a concrete list of selectors, write the WHOLE batch. See
`execution-mode.md` for the canonical 22-op example. Rule of thumb: if
you're about to write the third one-tap-`ui_act.py` in a row, stop and
collapse into a single `ui_run_flow.py --stdin` batch instead.

Sequential 8 small batches: ~17 s wall-clock + 8 trace dirs to stitch.
One 22-op batch: ~14 s + 1 trace dir.

## 3. Mid-flow `Read()` on trace frames — image as observation channel

**What it looks like.** Flow lands on an unexpected screen, the LLM
`Read()`s `/tmp/.../<gen>-<op>.jpg` (or `screencap -p > x.png` and
reads the result) to figure out where it is. Single `Read()` on a
1080×2400 frame burns ~25-50 K tokens of context.

**Why.** Treating image frames as the primary observability surface.
The accessibility tree (XML) is structurally typed, selector-
addressable, and 100-1000× cheaper. Frames exist as on-disk forensics
for the human reviewing later; they are not a context channel.

**Cure — XML tree first, every time.**

| Question | Right tool | Wrong tool |
|---|---|---|
| "Is selector S on screen?" | `describe` op with S | `Read(frame.jpg)` and look |
| "What's on this screen?" | `ui_snapshot.py --only-clickable --max-lines 30` | `Read(frame.jpg)` |
| "Did anything change?" | `window_sig` op | diff two frames |
| "Where exactly did Compose render this?" | `describe` returns bounds | (only here is a frame relevant) |

`Read()` is justified ONLY when ALL three hold:
1. Flow already failed (you're past observation, into forensics).
2. The tree is structurally insufficient — Compose `Canvas`,
   `View.onDraw`, animation in flight, missing `desc=`/`text=`.
3. You have a specific pixel-level question that no selector can
   answer.

If any of the three fails, the answer is in the tree. Reference
the frame by filename in the conversation if the human needs to
look — don't pull it into your context window.

## 4. BG trace latency — frames land AFTER the batch returns

**What it looks like.** A 22-op flow returns in ~14 s. The trace
directory has 14-15 frames at the moment the CLI exits. 3-5 s later,
the directory has all 22.

**Why.** BG trace uses `adb exec-out screencap -p` so capture doesn't
contend with the u2 lock that the next op needs. adb exec-out is
500-1000 ms per call on real devices; the bounded 2-worker pool can
queue. trace_stop fires when the batch ends — in-flight workers
complete on their own.

**Cure.** Either:
- Wait 5 s after the flow returns before listing the trace dir
  (`sleep 5 && ls $TRACE_DIR`).
- Pre-flight check: a missing frame at the END of the directory is
  almost certainly still mid-write, NOT a failed capture. Re-check.

This is forensics; never let a missing frame block the next action.

## 5. Snapshot after mutation that returned ms ago

**What it looks like.** `tap` returns rc=0; the very next `snapshot`
sees the OLD screen (no settle delay) and reports stale text. Selectors
based on the snapshot tap the wrong thing.

**Why.** `tap` returns when the gesture lands, not when the next frame
renders. The daemon's `post_sync` (`wait_for` / `wait_stable_ms`)
guards this — without it, the snapshot races the recompose.

**Cure.** Always set `wait_for` (or `wait_stable_ms`) on the prior tap
when the next op depends on the post-state being committed. Do not
chain `tap` then `snapshot` with no sync flag.

## 6. Sidecar invalidation by host-side delay

**What it looks like.** `ui_snapshot` prints uids. The LLM thinks for
20 s, decides which uid to tap, runs `ui_act tap u3`. Result:
`no uid sidecar`.

**Why.** Sidecar TTL is 15 s by default (`ANDROID_SKILL_UID_TTL_MS`).
Any host-side gap longer than that — `Read()`, web fetch, agent
delegation — invalidates uids.

**Cure.** Use selectors (`text="..."`, `id=...`) — they survive across
snapshots. uids are intra-snapshot only. If you must use uids, do
`snapshot → tap uN` inside ONE `ui_run_flow.py` batch so no host-side
gap exists.

## 7. Selectors that match decorative text

**What it looks like.** `tap` on `text="OK"` matches the wrong element
because two unrelated nodes both show "OK" (a button + a non-clickable
TextView). Tap lands on the TextView; nothing happens.

**Why.** Default snapshot includes ALL TextViews. Default selectors
match by text-containment.

**Cure.**
- Filter snapshots by `--only-clickable` when you're planning a tap.
- AND-join selectors: `text="OK",clickable=true`.
- Prefer `desc=` (semantics-tagged) and `id=` (resource ID) over
  `text=`. Decorative `text=` matches are common; semantic tags rarely
  collide.

## 8. Anchor missing → flow runs anyway

**What it looks like.** Batch starts on the wrong screen (countdown
elapsed mid-flow, BACK pressed by hardware key, app crashed and
auto-restarted). First tap selector resolves to a coincidental match
on the wrong screen. Eight ops later, "tap target not found" with
no clear reason.

**Why.** No pre-flight assertion that the screen is what the batch
assumes.

**Cure.** Pass `--require-anchor 'desc="<expected anchor>"'` to
`ui_run_flow.py`. ~50 ms warm; aborts the batch with a clear "not on
expected screen" message before any tap fires.

## 9. Daemon socket stale after SIGKILL

**What it looks like.** First batch after a daemon crash:
`daemon: connect refused`. Subsequent batches hang on connect.

**Why.** UDS file is not unlinked on SIGKILL. `socket.exists()` returns
True for a dead socket; connect fails.

**Cure.** Already handled — `_daemon_request` unlinks-and-respawns on
connect failure to an existing socket. If you see the failure repeating,
manually `rm "${TMPDIR:-/tmp}/android-skill-daemon.<serial>.sock"` and
retry.

## 10. Acting before orientation — ambiguous prompt, fresh chat

**What it looks like.** New chat, no prior context. User asks "tap the
save button" or "test the booking flow". The LLM picks a guess
(`text="Salva"`? `desc="Save"`?), batch fails because the assumed
screen isn't current. Two more retries with different selectors. Five
minutes wasted.

**Why.** Fresh chats have no app-screen knowledge. The user's request
is screen-relative and the LLM doesn't know which screen is current.
Skipping the orientation step is the default failure for short prompts
without code context.

**Cure — orient before acting:**

1. **One snapshot first** — minimal cost, gives ground truth:
   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/ui_snapshot.py \
       --serial "$SERIAL" --only-clickable --max-lines 30
   ```
   Read the foreground activity + the clickable nodes. This tells you
   what screen is up.

2. **Match against the user's words.** If user said "save", scan for
   `desc="Salva"` / `desc="Save"` / `text~"Sal"`. Confirm there is
   exactly ONE match. Multiple matches = ask the user, don't guess.

3. **Anchor the next batch.** Pre-flight with
   `--require-anchor 'desc="<the anchor I just confirmed>"'` so if the
   screen changes (countdown, async navigation) before the batch fires,
   the failure is one clear error instead of eight ops into the wrong
   screen.

4. **For multi-screen flows ("test the booking flow"):**
   - Ask the user where the flow STARTS (which screen / which intent).
     Don't guess.
   - Once on the start screen, take ONE snapshot, identify the entry
     anchor, then write the batch.
   - Don't try to guess the whole flow's selectors from the user's
     prose — most flows have non-obvious labels (Italian copy, Compose
     `desc=`, dynamic content).

**Rule of thumb.** If you can't name the current screen's foreground
activity AND a unique anchor selector on it, you are NOT ready to write
a batch. Snapshot first; batch second.

**Don't conflate orientation with execution mode.** Orientation =
1-3 small ops (`describe`, `snapshot --query`) to LEARN the screen.
Execution mode = one big batch once the path is known. Mixing these
("explore" with eight tap+snapshot pairs) is the §2 micro-batch
anti-pattern reborn.

## 11. Tree-depth blindness — screen-by-screen reactive walk

**What it looks like.** User asks for a multi-screen task. LLM:
- Snapshots the current screen → finds an entry → 1-op batch tap.
- Snapshots the next screen → finds another entry → 1-op batch tap.
- A modal/dialog appears unexpectedly → snapshot to study it.
- Several more 1-op batches, each followed by a snapshot.

Each step a single tap. Each pays subprocess spawn + anchor describe.
Net: many small batches for a flow that's a single big batch once the
path is known.

**Why.** Orientation (§10) gave the LLM the CURRENT screen but not the
PATH the intent traverses. Without a path model, the LLM stays in a
one-screen reactive loop — tap, observe, react — instead of declaring
the whole batch up front.

**Cure — derive the path BEFORE the first batch.** Sources, cheapest
first:

1. **Grep the source.** Whatever framework the app uses (Compose
   NavHost / View XML + Activities / Flutter routes / RN navigators /
   WebView routes / native fragments), the navigation graph is named
   somewhere in code. Two grep classes are usually enough:
   ```bash
   # 1. Route / screen / destination definitions
   grep -RnE '<framework's route or screen keyword>' <source root>
   # 2. Visible labels (often used as selectors)
   grep -RnE '<framework's localized-string or content-description keyword>' <source root>
   ```
   Adjust the patterns to the framework. Three minutes of grep saves
   twenty minutes of screen-by-screen walking on the device.
2. **Activity stack.** `adb shell dumpsys activity activities` shows
   the back-stack and registered activities; useful for multi-activity
   apps or when source is unavailable.
3. **Existing flows.** `references/maestro.md`, agent runbooks, recorded
   test scripts in the repo often encode paths. Grep before reinventing.
4. **Ask the user** when 1–3 don't apply. Don't guess past ~2
   transitions deep — that's where compounding wrong assumptions waste
   the most time.

**Write the path explicitly before the batch.** Two lines to the chat
(or a header on the JSON), abstract names plus the anchor on each
screen:

```
flow:    <intent in ~5 words>
path:    <Screen A> → <Screen B> → <Screen C>
anchors:
  <Screen A>  <selector that uniquely identifies A>
  <Screen B>  <selector for B>
  <Screen C>  <selector for C>
```

Now the batch writes itself: every tap target is on the list, every
`wait_for` proves arrival on the NEXT-screen anchor, and the
`flow_timeout_ms` budget is approximately (path length) × (per-screen
budget).

**Then file the plan in the task tool.** Use whatever plan/todo/task
tool is loaded (`TodoWrite`, `TaskCreate`, or the harness equivalent).
One task per screen transition. Title = transition (`<A> → <B>`),
description carries the anchor selector. Mark complete as each
`wait_for` lands. Effects:
- Plan becomes a contract the LLM cannot drift from mid-flow.
- User sees the route BEFORE you act and can steer if it's wrong.
- A failed batch identifies which transition broke (the in-progress
  task), not just "op N failed".

**Rule of thumb.** If you cannot write the path block in ~30 seconds,
you don't yet have the path. Don't open `ui_run_flow.py` yet — grep
the source first. Repo is the cheapest oracle of the screen graph;
the device is the most expensive.

**Don't conflate "exploration mode" with "I don't have a plan".**
Exploration is for ONE genuinely unknown next screen. A multi-screen
flow whose destination the user named IS NOT unknown — the user's
words name the destination, the source names the route.

## 12. wait_for on a single node when path branches

**What it looks like.** `wait_for: ["desc=\"Salvato\""]` on the save
button — but on validation error, the screen shows `desc="Errore"`
instead. Flow times out at 8 s, doesn't realise it's already on the
error path.

**Why.** `wait_for` is AND on a single node — it polls until the
specific node renders.

**Cure.** Use `wait_for_any` for OR branching:

```jsonc
{"op":"tap","args":{"target":"desc=\"Salva\"","wait_for_any":["desc=\"Salvato\"","desc=\"Errore\""],"timeout_ms":8000}}
```

The op succeeds on first match; downstream ops can branch on the
resulting screen.

## 13. Tree returns only `[u1] id=content` after a transition

**What it looks like.** Flow taps something to dismiss a screensaver,
splash, or transitional surface. Next snapshot returns one node:
```
[u1]  FrameLayout     id=content  b=486,960
```
No selectors, no clickable nodes, no `desc=`/`text=`. LLM panics,
escalates to `screencap` + `Read()`.

**Why.** Two distinct cases produce this:

1. **Compose accessibility lag during recompose.** The tap landed and
   triggered a screen transition. View hierarchy already swapped, but
   Compose's accessibility-tree publish runs on a separate frame tick
   ~500-1500 ms after recomposition. During that window
   `uiautomator dump` sees an empty content frame.
2. **Genuinely non-semantic surface.** Screensaver = ExoPlayer
   (`exo_content_frame`), full-bleed Compose Canvas, `View.onDraw`
   custom widgets, video preview. There ARE no semantic nodes, ever.
   Pre-flow `dumpsys window` shows the foreground; if it's a video
   player or unknown activity, this is case 2.

**Cure — different tool per case.**

For case 1 (transition lag): the prior tap should have used `wait_for`
on the EXPECTED next-screen anchor, not `wait_stable_ms` (blind) or
no sync at all:

```jsonc
{"op":"tap_point","args":{"x":486,"y":960,"wait_for":["desc=\"Presenza\""],"timeout_ms":3000}}
```

The accessibility tree returns the anchor the moment recomposition +
semantics-publish completes. No empty-tree window for the LLM to
observe.

`wait_stable_ms` is the wrong tool here because empty dumps may not
be byte-identical (rotation, timestamp jitter), so "stable" never
fires; OR they ARE identical-but-empty, and the tool reports stable
on a useless state.

For case 2 (non-semantic surface): selectors will never resolve.
Options:
- `tap_point` with known coords (centre of screen for screensaver
  dismiss; specific pixel from source-grep for canvas widgets) +
  `wait_for` an anchor on the NEXT screen.
- `key KEYCODE_BACK` / `KEYCODE_HOME` to escape to a tree-rich screen.
- For state observation only: `window_sig` op (content hash, no tree).

**Diagnostic order.** When you see only `id=content`:
1. Check `dumpsys activity activities | grep topResumedActivity` — is
   the foreground the activity you expected, a different one, or a
   system overlay?
2. If it's the activity you expected → case 1, retry with `wait_for`
   on a known anchor.
3. If foreground is unexpected → wake / escape / launch first.
4. If foreground is a known non-semantic surface → case 2, use
   `tap_point` + anchor.

Never: `screencap` + `Read()`. The trace dir already has frames for
prior mutations if you need pixel forensics on the divergence.

---

## 14. `key BACK` to dismiss the keyboard pops the wizard step

**What it looks like.** Type Nome → type Cognome → type Email → `key
BACK` (to close the IME) → tap next field. The next tap fails because
the screen has changed: BACK with no IME visible navigates the
activity back, popping the wizard step. Subsequent batch ops run on
the previous step's screen (or on Landing). Form values lost.

Symptom: `topResumedActivity` task id bumps (`t198 → t199`) between
ops; or `nearby[]` after BACK shows a different screen than expected.

**Why.** `KEYCODE_BACK` is double-overloaded on Android: dismisses
IME if up, otherwise navigates the activity. After three `type` ops
the IME may be dismissed automatically when the next field outside
the keyboard takes focus. By the time a deliberate `key BACK` fires,
the IME often isn't up anymore — the press goes through to the
activity.

**Cure.** Use `dismiss_ime` instead of `key BACK` for keyboard
hiding. The op is IME-aware (queries `dumpsys input_method`) and is
a no-op when no keyboard is visible:

```jsonc
{"op": "dismiss_ime", "args": {}}
```

The daemon also REFUSES `key KEYCODE_BACK` when no IME is visible
(rc=64 + actionable hint) unless you pass `force: true` to confirm
intent.

Better still: don't press BACK at all. After the last text field,
tap directly on the next non-EditText control. Compose auto-dismisses
the IME on focus change.

## 15. Activity recreated mid-batch — task id drift

**What it looks like.** Mid-batch, the kiosk idle-timer fires, the
process is force-stopped, or a deep link replaces the task. The
activity is destroyed and a new one takes its place. Form values
from earlier ops are gone. Subsequent ops dispatch on the new task.

Symptom: `topResumedActivity=...t199}` after batch started with
`t198`. Form state silently reset.

**Why.** Long batches assume a stable activity. Idle screensaver +
background restore + Lock Task Mode race can all destroy + recreate
the activity transparently.

**Cure.** `_op_batch` records the `tN` task id at start and checks
after every mutating op. On change, it aborts with rc=124 and a
breadcrumb naming the drift:

```
daemon: batch[N] activity drift detected — task id was '198' at batch start,
now '199'. The activity was recreated (idle screensaver fired / force-stop
raced / deep link replaced the task).
```

Recovery: re-launch the activity, re-anchor the start screen with
`--require-anchor`, resubmit the batch. Pass `track_activity_stability:
false` at the batch root to disable the gate when the drift is
intentional (e.g. you deliberately back out and re-enter).

---

## When the flow fails, in this order

1. Did the previous tap have `wait_for` or `wait_stable_ms`? If no,
   that's almost always it.
2. Is the previous op a mode-toggle? Add `sleep 250 ms` after.
3. Is the assumed start-screen still the actual start-screen? Add
   `--require-anchor` to the next attempt.
4. Did you cross a 15 s host-side gap holding a uid? Switch to
   selector. Or move the snapshot+tap into one batch.
5. Read the trace frames in the dir from THIS run (named
   `<gen>-<op>.<ext>` chronologically). The first divergence
   pinpoints the broken op.
6. Only NOW consider `Read()`-ing a frame.
