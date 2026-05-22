# Execution mode — one batch, many ops

When the screen path is known, send the WHOLE remaining flow in ONE
`ui_run_flow.py` invocation. `wait_for` (or `wait_for_any`) chains the
ops; `flow_timeout_ms` caps the whole thing; the default `--trace`
captures every mutation for forensics.

Eight separate small batches are an anti-pattern: each pays subprocess
spawn + IPC + a fresh `--require-anchor` describe, and each creates its
own trace dir, so post-mortem requires stitching dirs together. One big
batch runs ~5× faster wall-clock and produces a single ordered trace.

## Canonical example — kiosk badge → causale → settings → dark theme → save

22 ops, single subprocess, ~14 s on a warm emulator.

```bash
${CLAUDE_SKILL_DIR}/scripts/ui_run_flow.py --serial "$SERIAL" \
    --require-anchor 'desc="Presenza"' \
    --stdin <<'EOF'
{"flow_timeout_ms": 60000, "ops":[
  {"op":"tap","args":{"target":"desc=\"Presenza\"","wait_for":["desc=\"Timbra\""]}},
  {"op":"tap","args":{"target":"desc=\"Timbra\"","wait_for":["desc=\"Inserisci codice\""]}},
  {"op":"tap","args":{"target":"desc=\"Inserisci codice\"","wait_for":["text=\"Inserisci codice badge\""]}},
  {"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"3\""],"assume_stable_coords":true}},
  {"op":"tap","args":{"target":"text=\"ABC\"","wait_for":["text=\"D\""]}},
  {"op":"sleep","args":{"ms":250}},
  {"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"D\""],"assume_stable_coords":true}},
  {"op":"tap","args":{"target":"text=\"123\"","wait_for":["text=\"3\""]}},
  {"op":"sleep","args":{"ms":250}},
  {"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"3\"","text=\"0\"","text=\"9\"","text=\"4\""],"assume_stable_coords":true,"delay_ms":150}},
  {"op":"tap","args":{"target":"text=\"ABC\"","wait_for":["text=\"F\""]}},
  {"op":"sleep","args":{"ms":250}},
  {"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"F\"","text=\"F\""],"assume_stable_coords":true,"delay_ms":200}},
  {"op":"tap","args":{"target":"desc=\"Invia\"","wait_for":["text=\"Timbratura normale\""],"timeout_ms":8000}},
  {"op":"tap","args":{"target":"text=\"Timbratura normale\"","wait_for":["desc=\"Timbra\""],"timeout_ms":8000}},
  {"op":"tap","args":{"target":"desc=\"Indietro\"","wait_for":["desc=\"Presenza\""],"timeout_ms":5000}},
  {"op":"tap","args":{"target":"desc=\"Impostazioni\"","wait_for":["text=\"Cambia tema\""],"timeout_ms":5000}},
  {"op":"tap_point","args":{"x":486,"y":1062,"wait_for":["text=\"Inserisci PIN\""],"timeout_ms":5000}},
  {"op":"resolve_then_tap_sequence","args":{"selectors":["text=\"0\"","text=\"0\"","text=\"0\"","text=\"0\"","text=\"0\"","text=\"0\""],"assume_stable_coords":true,"delay_ms":120,"wait_for":["text=\"Scuro\""],"timeout_ms":8000}},
  {"op":"tap","args":{"target":"text=\"Scuro\"","wait_for":["desc=\"Salva\""],"timeout_ms":5000}},
  {"op":"tap","args":{"target":"desc=\"Salva\"","wait_for_any":["desc=\"Salvato\"","desc=\"Indietro\""],"timeout_ms":8000}}
]}
EOF
```

## Picking gear

| Situation | Use |
|---|---|
| Next screen genuinely unknown | exploration mode: 1–3 ops, end with `snapshot` |
| Screen path is known | execution mode: long batch, no intermediate snapshots |
| Result screen has countdown | the action that opens it AND the action that consumes it MUST share one batch |
| Branching on result content (success vs error) | `wait_for_any` for OR; rest of the batch can branch on the resulting state |

Rule of thumb: as soon as you can answer "what's the rest of the path?" with
a concrete list of selectors, write the whole batch.

## When the LLM is tempted to break this

Real failure mode observed: the LLM correctly opens with `ui_run_flow.py`,
but invokes it eight times in a row for a 22-op flow whose path is known
after step three. Symptoms: rebuilt anchors, wasted subprocess spawns,
trace fragmentation, mid-flow `Read()` on screencap PNGs that burns
~25,000 tokens of context per file.

Cure: as soon as you've seen the "shape" of the next 5+ screens, write the
whole batch. Don't `Read()` a screencap to plan a tap — query the tree with
`describe` or `snapshot --query` for ~100 bytes instead. Trust the trace
dir for forensics; only `Read()` a frame when a flow has already failed and
the divergence is genuinely pixel-level.

## Canonical wizard template — form + dropdown + multi-step navigation

This is the template to copy when driving a Compose wizard with text fields,
a dropdown, and 3+ step transitions. Embeds `describe` ops mid-batch as
diagnostic checkpoints — they are non-fatal so a failed describe records
its rc in `results[]` without aborting the rest of the flow.

```bash
${CLAUDE_SKILL_DIR}/scripts/ui_run_flow.py --serial "$SERIAL" \
    --require-anchor 'desc="<start-screen-anchor>"' \
    --stdin <<'EOF'
{"flow_timeout_ms": 90000, "ops":[
  // --- enter wizard ---
  {"op":"tap","args":{"target":"desc=\"<module>\"","wait_for":["desc=\"<entry>\""],"timeout_ms":6000}},
  {"op":"tap","args":{"target":"desc=\"<entry>\"","wait_for":["text=\"Nome *\""],"timeout_ms":6000}},

  // --- form fill: type ops use containment finder + send_keys (handles
  //     Compose floating labels and two-column rows automatically) ---
  {"op":"type","args":{"target":"text=\"Nome *\"","text":"Mario"}},
  {"op":"type","args":{"target":"text=\"Cognome *\"","text":"Rossi"}},
  {"op":"type","args":{"target":"text=\"Email *\"","text":"mario@test.it"}},
  {"op":"dismiss_ime","args":{}},

  // --- mid-batch diagnostic (NON-FATAL): proves form state landed
  //     correctly. Failed describe records rc=1 in results but does
  //     not abort. Splitting into a new batch for this check costs
  //     the whole flow's idle-timer reset budget. ---
  {"op":"describe","args":{"selectors":["text=\"Mario\"","text=\"Rossi\"","text=\"mario@test.it\""]}},

  // --- dropdown pick (KioskPicker has clickable wrapper + interactionSource
  //     fallback — synthetic taps reliably open the menu) ---
  {"op":"tap","args":{"target":"text=\"Seleziona\"","wait_for":["text=\"Visitatore\""],"timeout_ms":5000}},
  {"op":"tap","args":{"target":"text=\"Visitatore\"","wait_for":["desc=\"Continua\""],"timeout_ms":4000}},

  // --- multi-step navigation ---
  {"op":"tap","args":{"target":"desc=\"Continua\"","wait_for_any":["text=\"<contact-list>\"","text~\"Privacy\""],"timeout_ms":8000}},
  // ... add per-step anchors as wait_for_any to handle conditional skips ...

  // --- final outcome check (NON-FATAL describe so failed checks are
  //     forensic, not flow-breaking) ---
  {"op":"sleep","args":{"ms":2000}},
  {"op":"describe","args":{"selectors":["text~\"completata\"","text~\"successo\"","desc=\"Conferma\""]}}
]}
EOF
```

### Rules embedded in the template

1. **`--require-anchor`** at the top — pre-flight asserts the start
   screen IS what you think. Catches "wrong screen" before any tap.
2. **Every mutating op has `wait_for` / `wait_for_any`** on the
   expected post-state anchor. Chains the proof of arrival.
3. **`dismiss_ime`** after typing the last text field. NEVER `key BACK`
   for IME — see failure-modes §14.
4. **Mid-batch `describe` ops** are free diagnostic. Read-only ops are
   non-fatal in batches; their rc lands in `results[]` for inspection.
5. **`wait_for_any` on branching transitions** — when a step has 2+
   possible next screens (validation error vs success, auto-skip vs
   manual confirm), enumerate all.
6. **One batch, NO splits.** Splitting costs idle-timer resets, anchor
   pre-flights, subprocess spawns, and trace dirs. Embedding a
   describe op is free.

### When NOT to use single-batch

| Situation | Pattern |
|---|---|
| Next screen genuinely unknown — never tested this path before | Exploration mode: 1-3 ops ending with `snapshot`, then close the batch and write the real flow once shape is known |
| Branching on data-dependent outcome (server returns N possible result screens) | `wait_for_any` with all branches, then a `describe` op to disambiguate; downstream ops conditional on the rc/out of that describe — currently requires a 2nd batch to react. Larger refactor planned. |
| Activity boundary expected (deep link, FOREGROUND replacement) | Set `track_activity_stability: false` at batch root |
