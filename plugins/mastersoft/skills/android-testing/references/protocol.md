# The 4-step protocol — in order, no skipping

Multi-screen flows fail when you skip a step. Each step is cheap; skipping any step burns 50-200 K tokens recovering. The summary lives in `SKILL.md`; this file is the depth.

## 1. PLAN — file the screen path in the task tool

Before ANY device call, derive the path the user's intent traverses and commit it to `TodoWrite` (or `TaskCreate`). Cheapest sources, cheapest first:
- **Grep the source.** NavHost / route table / Screen factories / string resources name the screen graph in code. Adjust regex to the framework in use.
- **`adb shell dumpsys activity activities`** for the back-stack when source isn't accessible.
- **Existing flows** under `references/maestro.md` or repo runbooks.
- **Ask the user** when 1–3 don't apply. Do not guess past 2 transitions deep.

Then file ONE task per transition:
- title: `<Screen A> → <Screen B>`
- description: anchor selector that proves arrival on B (`text="..."`, `desc="..."`, `id=...`)

If you cannot list the path in 30 seconds, you do not have it. Stop, grep, ask. Do not open `ui_run_flow.py` yet.

**Anti-loop guardrail.** If you catch yourself doing `tap → screencap → Read` (or `single ui_act → snapshot → tap → snapshot`) more than twice in a row, **STOP**. That reactive single-op loop is the symptom of skipping this step. Go back to step 1, file the path, write the whole batch. The fix is never "one more tap and screencap"; the fix is the path.

## 2. ANCHOR — `describe` the current screen

```bash
${CLAUDE_SKILL_DIR}/scripts/ui_run_flow.py --serial "$SERIAL" --stdin <<'EOF'
{"ops":[{"op":"describe","args":{"selectors":["<expected anchor>"]}}]}
EOF
```

`describe` returns `{matched, total, results, ...}`. On miss it ALSO returns `nearby[]` (up to 12 `text=`/`desc=` selectors actually on screen) and `foreground`. That output is your correction signal — match against the user's intent before re-dumping or escalating. **Never** `Read()` a screencap to "check the screen".

## 3. BATCH — one `ui_run_flow.py` with the WHOLE flow

The moment the path is known, write the full batch. Chain `wait_for` between ops; use `wait_for_any` when the next screen branches. `--require-anchor` pre-flights step 2's anchor.

```bash
${CLAUDE_SKILL_DIR}/scripts/ui_run_flow.py --serial "$SERIAL" \
    --require-anchor '<anchor selector>' \
    --stdin <<'EOF'
{"flow_timeout_ms": 30000, "ops":[
  {"op":"tap","args":{"target":"<sel A>","wait_for":["<sel B>"]}},
  {"op":"tap","args":{"target":"<sel B>","wait_for":["<sel C>"]}},
  ...
]}
EOF
```

Eight separate small batches for one flow is the worst-observed anti-pattern. Eight 1-tap batches pay 8× subprocess + 8× anchor describe + 8 trace dirs to stitch later. One 20-op batch runs ~5× faster wall-clock. AND if the kiosk has an idle screensaver, multi-batch flows cross the idle threshold and lose state mid-test — single batch keeps the timer reset on every tap.

**DO NOT split a batch to inspect state.** Embed a `describe` op INSIDE the batch at the suspect transition. Read-only ops (`describe`, `snapshot`, `window_sig`, `health`) are **non-fatal in batches** — their failure records rc in `results[]` for inspection but does NOT abort the rest of the flow. So:

```jsonc
{"ops":[
  {"op":"tap","args":{"target":"desc=\"Continua\"","wait_for":["text=\"NextStep\""]}},
  {"op":"describe","args":{"selectors":["text=\"NextStep\"","text=\"ErrorScreen\""]}},   // ← FREE diagnostic; failed describe does NOT abort
  {"op":"tap","args":{"target":"<next>"}},
  ...
]}
```

Restarting the batch costs the WHOLE flow (subprocess + idle-timer reset). Embedding `describe` is free. When you're tempted to split for debugging, instead add a describe op. See `references/execution-mode.md` for the canonical 20+ op template.

## 4. INSPECT — the tree IS the observation channel

| Question | Tool |
|---|---|
| "Is X on screen?" | `describe` op with selector X |
| "What's on this screen?" | `ui_snapshot.py --only-clickable --max-lines 200` |
| "Did the screen change?" | `window_sig` op (content hash, no tree dump) |
| "Did my tap land?" | the tap's own `wait_for` selector — no extra inspection needed |

**There is no image-based observation channel.** Frames are forensic snapshots written to disk for the human to look at when investigating a failed flow — they are NOT a way for you to "see" the screen. Each `Read()` of a 1080×2400 frame burns 25-50 K tokens for a question the tree answers in ~100 bytes.

The trace is BG-captured by default but the directory path is **not** advertised on success. When a flow fails, `ui_run_flow.py` prints the trace dir to stderr along with `trace.jsonl` (one line per mutation: `{ts, gen, op, frame}`), so the HUMAN can `jq` the timeline and `Read()` the relevant frame manually. You do not need that path during normal flow execution.

`Read()` a frame yourself ONLY when ALL three hold: flow already failed AND the tree is structurally insufficient (Compose Canvas, `View.onDraw`, animation in flight, missing `desc=`/`text=`) AND you have a specific pixel-level question. If those don't all hold, the answer is in the tree.
