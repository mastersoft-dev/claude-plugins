---
name: android-testing
description: >-
  Drive, build, test, install, debug Android. Triggers on adb, emulator, AVD,
  Gradle, Espresso, Compose Test, JUnit, Robolectric, uiautomator, logcat,
  ".apk", "tap through an Android screen", "test this Android screen", "drive
  the Android UI flow". Android only — for running tests on other platforms use
  the qa-specialist agent. Multi-screen flows require the 4-step protocol below.
model: opus
effort: xhigh
allowed-tools: Read, Glob, Grep, Bash(adb *), Bash(./gradlew *), Bash(emulator *), Bash(${CLAUDE_SKILL_DIR}/scripts/*)
argument-hint: "[intent or device serial]"
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/skills/android-testing/hooks/no-raw-input.sh"
          timeout: 3
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/skills/android-testing/hooks/no-raw-screencap.sh"
          timeout: 3
---

Operate the Android toolchain: pick devices, run Gradle test tasks, drive multi-screen UI flows via a per-serial daemon, inspect logcat. Pick one lane (see **Intent router** below).

## The 4-step protocol — MANDATORY for any multi-screen flow

Skipping a step burns 50-200 K tokens recovering. Full detail in `references/protocol.md`.

1. **PLAN** — file the screen path in `TodoWrite` / `TaskCreate` before any device call. Source order: grep the navhost → `adb shell dumpsys activity activities` → `references/maestro.md` → ask the user. Title each task `<Screen A> → <Screen B>` with the arrival anchor in the description.
2. **ANCHOR** — `describe` the current screen with the expected selector. On miss the response carries `nearby[]` (12 selectors) + `foreground` as the correction signal. Never `Read()` a screencap to "check the screen".
3. **BATCH** — one `ui_run_flow.py` with the WHOLE flow. Chain `wait_for` between ops, `wait_for_any` on branches, `--require-anchor` for pre-flight. Eight 1-3 op batches is the worst-observed anti-pattern. To inspect mid-flow, embed a `describe` op (read-only ops are non-fatal in batches) — do NOT split the batch.
4. **INSPECT** — the tree IS the observation channel. `describe`, `snapshot --query`, `window_sig`. `Read()` a frame ONLY when the flow failed AND the tree is structurally insufficient AND you have a specific pixel-level question.

**Anti-loop guardrail.** If you catch yourself doing `tap → screencap → Read` (or `single ui_act → snapshot → tap → snapshot`) more than twice in a row, **STOP**. Go back to step 1, file the path, write one batch.

## Hard prohibitions

| ❌ Never do | ✅ Do this |
|---|---|
| `adb shell input tap/text/swipe` | `ui_run_flow.py` ops (`tap`, `tap_point`, `type`, `swipe`) |
| `Read(/tmp/*.png)` mid-flow | `describe` / `snapshot --query` / `window_sig` |
| `sleep N` between actions | `wait_for: ["sel"]` on the prior op |
| 1-3 op batches × 8 for one flow | one 10-30 op batch with `wait_for` chained |
| `screencap` to verify a tap landed | the tap's own `wait_for` selector |
| Retry identical filters with `sleep` between | drop `--only-clickable`, bump `--max-lines`, or `describe` instead |
| `key KEYCODE_BACK` to dismiss the keyboard | `dismiss_ime` op (safe; no-op when no IME up). BACK is double-overloaded — with no IME visible it navigates back and silently pops the current wizard step. Daemon refuses BACK without IME unless `force: true`. |

## Bootstrap

```bash
SERIAL=$(${CLAUDE_SKILL_DIR}/scripts/device_pick.sh)        # honours $ANDROID_SERIAL
${CLAUDE_SKILL_DIR}/scripts/check_deps.sh --serial $SERIAL  # adb / u2 / maestro / imagemagick
```

`device_pick.sh` prints a stderr table and exits non-zero if multiple devices attached and no `ANDROID_SERIAL` set.

**Always rebuild + install before testing the app under development.** When the target is the local codebase, `./gradlew :app:installDebug` first (substitute the flavour task for non-`:app` modules). `installDebug` is incremental; no-op when sources unchanged. Skip only on explicit "skip build".

## Intent router

| User intent | Lane | Read |
|---|---|---|
| Run/write existing test code (Espresso, Compose Test, JUnit, Robolectric, `connectedAndroidTest`) | **Gradle** | `references/gradle-tests.md` |
| Exploratory tap-through, drive UI, find why app crashes | **Daemon batch** (this file) | `references/flow-composition.md`, `references/ui-navigation.md` |
| Durable, repeatable mechanical flow (>15 taps, deterministic, in-repo YAML) | **Maestro** | `references/maestro.md` |
| Inspect device / logcat / activity stack, no UI driving | **Logs** | `references/device-and-logs.md` |

If ambiguous, ASK — one short question, not a guess.

## Daemon (the engine)

`scripts/android_skill_daemon.py` is a per-serial Unix-socket daemon that holds the u2 connection warm, caches XML by mutation generation, and accepts batched flows. Auto-spawns on first use, idle-exits after ~5 minutes, falls back transparently to direct `adb` if anything fails. `ui_act.py` / `ui_snapshot.py` / `ui_run_flow.py` route through it by default. Disable with `ANDROID_SKILL_USE_DAEMON=0` for CI determinism.

Sub-op vocabulary for batches (every op accepts `wait_for` / `wait_for_any` / `wait_stable_ms` / `timeout_ms` / `fail_on_timeout`):
`tap`, `tap_point`, `tap_macro`, `resolve_then_tap_sequence`, `swipe`, `long_press`, `sleep`, `type`, `key`, `dismiss_ime`, `snapshot`, `describe`, `window_sig`, `health`. Top-level `flow_timeout_ms` caps the whole flow.

`screencap` exists as a sub-op for forensic capture but is intentionally not advertised here — frames are not an observation channel. Use it only inside an explicit post-mortem session, never as part of a primary flow. See `references/flow-composition.md` for the full primitive inventory + recipes.

## Selector grammar

```
text="Sign in"  desc="Email"  id=login_btn  class=EditText      (exact)
text~"sign"     desc~"mail"   id~"login"    class~"Edit"        (case-insensitive substring)
clickable=true  focused=true                                    (state)
```

AND across clauses with comma. Selectors first; `[uX]` uids are escape hatches valid only inside one snapshot's lifetime (15 s TTL). Full grammar + WebView/Compose/IME/launcher gotchas: `references/ui-navigation.md`.

## Optional dependencies — detect, ASK before installing

`check_deps.sh` reports what's available. Never silently install — uiautomator2 pushes a device agent; ImageMagick is a brew install.

| Feature | Install script |
|---|---|
| uiautomator2 (warm agent → ~5-7× faster dumps) | `install_u2.sh` |
| Maestro flow runner | `install_maestro.sh` |
| ImageMagick (rare pixel-diff workflows) | `install_imagemagick.sh` |

## Reference files

- `references/protocol.md` — full 4-step protocol detail (the summary above is the index).
- `references/flow-composition.md` — primitive inventory + batched flow recipe (open → animation sleep → fast macro → sync). Read when declaring multi-step flows.
- `references/execution-mode.md` — when to write one batch vs many: rule-of-thumb table + canonical worked example.
- `references/failure-modes.md` — observed real-session failures + cures (mode-toggle race, micro-batching, mid-flow `Read()`, sidecar TTL, decorative-text matches, ambiguous-prompt orientation, tree-depth blindness).
- `references/lanes.md` — Lane A/B/C decision tree.
- `references/ui-navigation.md` — 5-step loop, selector grammar, sync flags, gotchas, 0-node recovery table.
- `references/gradle-tests.md` — Espresso, Compose Test, Robolectric, JUnit, Gradle invocations, parsing failures.
- `references/device-and-logs.md` — emulator, AVD, USB/wireless adb, logcat, multi-device, macOS notes.
- `references/backends.md` — raw / u2 / Maestro trade-offs.
- `references/maestro.md` — durable YAML flows + `harvest-to-maestro.py` pipeline.
