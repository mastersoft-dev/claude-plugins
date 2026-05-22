# Maestro lane — durable mobile flows

Parallel mode to Lanes A/B/C. Maestro is a flow runner with its own YAML DSL;
acts on the **same** Android accessibility tree underneath, but offers
built-in idle/wait/retry semantics, structured pass/fail, and cross-platform
flows that also run on iOS.

**This lane is parallel, not facade-merged.** `ui_snapshot.py` / `ui_act.py`
are not invoked from a Maestro flow; the flow IS the script.

## When to pick Maestro

- The flow is durable (you want to commit it to the repo, run it from CI).
- You want the same flow to run against iOS later.
- The flow has many waits / retries / idle-detection points where Maestro's
  built-ins beat hand-coded `--wait-for` chains.
- You're already comfortable with the YAML DSL.

## When NOT to pick Maestro

- Ad-hoc exploratory tap-through (Lane A is faster — no flow file overhead).
- Single-screen Compose-Canvas blind taps (Lane B coordinates are simpler).
- Unknown async completion criteria (Lane C ring + listener observes, Maestro
  expects a target end-state).

## Install

Maestro is a single Java binary (~50MB).

```bash
${CLAUDE_SKILL_DIR}/scripts/install_maestro.sh        # brew-only
```

If you don't have Homebrew, install brew first or download Maestro manually
from https://maestro.mobile.dev. The skill does **not** pipe a remote install
script into bash.

## Smoke a hello-world flow

```yaml
# flow.yaml
appId: com.android.settings
---
- launchApp
- assertVisible: "Settings"
- takeScreenshot: result
```

```bash
${CLAUDE_SKILL_DIR}/scripts/run_maestro.sh flow.yaml
# → PASS host_epoch_ms=1778... flow=flow.yaml
```

`run_maestro.sh` auto-injects `--device $SERIAL` from the session file if you
haven't passed one.

## Flow vocabulary (the bits worth knowing)

| Step | Effect |
| --- | --- |
| `launchApp` | Cold-launch the app referenced by `appId`. Equivalent to `am start`. |
| `tapOn:` (id / text / point) | Tap an element. Maestro waits for it to appear. |
| `inputText: "..."` | Type into the focused field. |
| `assertVisible: "..."` | Fail if not visible. Implicit retry. |
| `assertNotVisible: "..."` | Fail if visible. Counterpart. |
| `back` | KEYCODE_BACK. |
| `scroll` / `swipe` | Gestures. |
| `takeScreenshot: <name>` | PNG in `~/.maestro/tests/<run>/`. |
| `waitForAnimationToEnd` | Yields until SurfaceFlinger settles. Cheap explicit barrier. |
| `runFlow: <path>` | Compose flows. |

Full grammar at https://maestro.mobile.dev/api-reference/commands.

## Failure handling

`run_maestro.sh` exits non-zero on flow failure and prints
`FAIL host_epoch_ms=... flow=... reason=...` on stdout. Maestro keeps the
full run output at `~/.maestro/tests/<run-id>/` (mentioned on stderr by the
wrapper). For deeper triage, run `maestro test --debug-output ...` directly.

## Compose un-tagged caveat (same as Lane A)

Maestro reads the same accessibility tree uiautomator does. Compose without
`testTagsAsResourceId` produces the same blind-spot — `id:` selectors won't
resolve. Use `text:` / `index` / `point` selectors as fallback, or add
`Modifier.semantics { testTagsAsResourceId = true }` in your activity.

## Combining with other lanes

You can drive **into** a screen with Lane A or C, then hand off to a
Maestro flow at the natural boundary (e.g. the model navigates to a
specific page, then runs a flow that captures the durable test). Maestro
doesn't share state with our session files; serial is auto-injected.

## When NOT to install

Skip Maestro if:
- You only need ad-hoc Lane A/B/C exploration (typical case).
- You don't own the app under test (Maestro is intended for projects you
  develop, not for QA-ing third-party apps).
- The host can't run Java 11+ (Maestro requires it; `brew install maestro`
  pulls a JRE).
