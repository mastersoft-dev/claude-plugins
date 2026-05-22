# Perf baseline — phase 2 daemon ops

> **Update**: re-benched after adding op journal, `--record`, flow-validate
> pre-pass, `_op_describe`, and the wedge unit test. Numbers within noise
> of the original baseline below — no regression. Validate pre-pass adds
> <1 ms per batch, journal append <1 ms per op.



Captured against an Android 13 emulator (`Hikvision_DS_D6055UT(AVD)`,
arm64-v8a, host: M-series Mac, USB loopback). Numbers from
`scripts/bench.sh` driving `bench-comprehensive.json`.

This baseline locks the per-op cost model. Anything that regresses by
>20 % p50 at the same iteration count + warmth is a perf bug — open
an issue, run `bench.sh -n 30` on both branches.

## Bench flow

```json
{"ops":[
  {"op":"snapshot","args":{"only_clickable":false,"max_lines":5}},
  {"op":"window_sig"},
  {"op":"snapshot","args":{"only_clickable":true,"max_lines":3}},
  {"op":"sleep","args":{"ms":50}},
  {"op":"tap_point","args":{"x":540,"y":960}},
  {"op":"snapshot","args":{"only_clickable":true,"max_lines":3}},
  {"op":"screencap","args":{"path":"/tmp/b.jpg","backend":"u2","format":"jpeg"}},
  {"op":"screencap","args":{"path":"/tmp/b.png","backend":"u2","format":"png"}},
  {"op":"screencap","args":{"path":"/tmp/b_adb.png","backend":"adb"}},
  {"op":"window_sig"},
  {"op":"health"}
]}
```

Mix is intentionally diverse: 3× snapshot (forces cache miss + 2× hit), 3×
screencap (each backend), 1× tap_point (mutating, forces gen bump), 2×
window_sig (cache cold + warm), 1× sleep, 1× health.

## Cold baseline (n=5, daemon killed between iterations)

| op | n | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| `snapshot` | 15 | **180** | 931 | 963 |
| `screencap` (mixed backends) | 15 | **126** | 139 | 142 |
| `tap_point` | 5 | **24** | 32 | 32 |
| `window_sig` | 10 | **48** | 65 | 65 |
| `sleep` (50 ms requested) | 5 | **52** | 55 | 55 |
| `health` | 5 | 0 | 0 | 0 |
| `quit` | 5 | 0 | 0 | 0 |

p95 spike on `snapshot` (931 ms) is the first dump after each daemon
spawn — `uiautomator dump` cold path. After that, every snapshot inside
the same iteration is either a cache hit (~50 ms) or a warm-u2 dump
(~180 ms p50).

Wall-clock for 5 cold iterations ≈ 13 s — daemon spawn (~1 s × 5) is
the dominant cost.

## Warm baseline (n=10, single daemon across all iterations)

| op | n | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| `snapshot` | 30 | **113** | 179 | 191 |
| `screencap` (mixed backends) | 30 | **48** | 129 | 130 |
| `tap_point` | 10 | **23** | 32 | 32 |
| `window_sig` | 20 | **0** | 52 | 55 |
| `sleep` (50 ms requested) | 10 | **53** | 55 | 55 |
| `health` | 10 | 0 | 0 | 0 |

Wall-clock for 10 warm iterations ≈ 8 s — about 800 ms per iteration of
11 ops, so per-op floor ~70 ms incl. RTT overhead.

`window_sig` p50=0 ms because it caches per-mutation_gen; only the first
window_sig in each iteration computes (every other one returns the
cached `(sig, rotation)` tuple).

## `describe` op (dry-run selector resolution)

`describe` resolves selectors against the cached XML and returns
match info + coords without dispatching anything. Run with 7
selectors across 3 calls × 10 iter against a warm daemon:

| op | n | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| `describe` | 30 | **0** | 0 | 0 |

Cache-warm describe is essentially free — find_target is an in-memory
walk + JSON serialise. First call after a mutation pays the live dump
(~150–200 ms), every subsequent call within the same gen is sub-ms.

Use `describe` to verify a planned selector list before committing to
a `tap_macro` or `resolve_then_tap_sequence` — it costs nothing.

## Per-backend screencap split

Re-running `bench.sh` against a single-format flow, n=20:

| flow op | p50 ms | p95 ms | file size (typical) |
|---|---:|---:|---:|
| `screencap backend=u2 format=jpeg quality=85` | **38** | 47 | 65–80 KB |
| `screencap backend=u2 format=png` | **42** | 54 | 200–220 KB (un-optimised) |
| `screencap backend=adb format=png` | **170** | 220 | 65–75 KB (well-compressed) |

Use `u2 jpeg` when you just want to see the screen (CI screenshots,
"what does the kiosk look like right now"). Use `adb png` when you need
small, well-compressed PNG (artifact upload, golden-image diff).

## Comparison vs phase-1 baseline (same emulator)

Numbers from session memory before phase-2 ops landed:

| operation | Phase 1 | Phase 2 warm | Speedup |
|---|---:|---:|---:|
| `snapshot` post-mutation | always live dump (200–500 ms) | 113 ms p50 (mostly cache hit) | ~2–4× |
| `screencap` PNG | adb only (170 ms) | u2 PNG **42 ms** | ~4× |
| `screencap` JPEG | n/a | u2 JPEG **38 ms** | new |
| `tap` chained (proven by prior wait_for) | always 2 RTTs (~250 ms) | 1 RTT (~150 ms) | ~1.6× |
| 4-tap mechanical sequence | 4 × ~250 ms = 1000 ms | resolve+macro 530 ms | ~2× |
| Cold-start `ui_run_flow` batch | sequential subprocess fallback (2.17 s for 5 ops) | daemon batch (1.0 s incl spawn) | ~2× |

End-to-end "Setup → Connecting → Hardware → Landing → Manual entry →
keypad walk → scan ok" walk:
- **Phase 1**: ~3–5 minutes per attempt (and unreliable — keypad
  silently dropped chars on the racy macro).
- **Phase 2**: ~20–25 seconds per attempt with reliable badge entry.

## Reproducing

```bash
# Pin the emulator, kill any old daemon, capture fresh
SERIAL=$(scripts/device_pick.sh)
scripts/android_skill_daemon.py --serial "$SERIAL" --request '{"op":"quit"}' || true
scripts/bench.sh --serial "$SERIAL" -n 10 docs/bench-comprehensive.json
scripts/bench.sh --serial "$SERIAL" -n 5 --cold docs/bench-comprehensive.json
```

`bench.sh` reads `${TMPDIR}/android-skill-journal.<serial>.jsonl` —
truncated at start unless `--keep-journal`. The same journal feeds
ad-hoc forensic queries:

```bash
# ops slower than 200 ms in the last run
jq -c 'select(.ms > 200)' "$TMPDIR/android-skill-journal.${SERIAL}.jsonl"

# fail rate per op
jq -r '.op + " " + (.rc|tostring)' "$TMPDIR/android-skill-journal.${SERIAL}.jsonl" \
    | sort | uniq -c
```
