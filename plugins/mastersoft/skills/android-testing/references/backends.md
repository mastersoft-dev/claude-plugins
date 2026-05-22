# Backends — raw `adb`, uiautomator2, Maestro

Two backends sit behind `ui_snapshot.py` / `ui_act.py` (`--backend auto|u2|raw`),
plus Maestro as a separate lane.

## What `auto` does

1. Try `import uiautomator2` + `u2.connect(serial).info` round-trip probe.
2. On success: use u2 for this and subsequent calls in the same script.
3. On import or connect failure: fall back to `raw` with a one-line stderr
   breadcrumb. Never silently switches mid-call.

Force-pick: `--backend u2` errors if u2 unreachable; `--backend raw` skips
detection entirely (zero-dep path).

## raw `adb` (always available)

`ui_snapshot.py` issues a single `adb exec-out sh -c '…'` that runs
`uiautomator dump` + `cat` in one round-trip; `ui_act.py` shells out to
`adb shell input ...`. Zero deps, every call is a debuggable `adb`
invocation. Cost: ~1.5–2.5 s per snapshot (the device writes XML to a file
and we read it back). Acceptable for snapshot-once-act-many; painful in
tight loops.

## uiautomator2 (`u2`, shipped)

Same data source as `uiautomator dump` (the device-side accessibility
framework), but routed through a persistent on-device JVM agent
(`app_process`, not the deprecated `atx-agent` daemon). Live-measured on
`emulator-5554`: **~85 ms per dump** after the one-time ~667 ms connect, vs
~2020 ms raw — 5–7× faster in tight loops. First call pays the connect;
subsequent calls in the same Python process amortise it.

Install: `scripts/install_u2.sh` (pip install + one-time on-device APK
push). Skip on managed/corporate devices unless IT permits the agent.

## Daemon (the warm-connection layer)

Without the daemon, each Python invocation pays the ~667 ms connect cost
again. The daemon (`scripts/android_skill_daemon.py`) lazy-forks on first
call, holds the u2 handle warm, and serves `tap`/`type`/`key`/`snapshot`
plus the phase-2 batch ops via UDS at
`${TMPDIR}/android-skill-daemon.<serial>.sock`.

| Op | No daemon | Daemon (warm) | Daemon batch |
| --- | --- | --- | --- |
| `tap selector` | 0.5–1.9 s | **0.30–0.36 s** | per-op via batch |
| `tap + wait_for` | ~5 s (xml poll) | **0.40–1.02 s** | u2 native wait |
| `type` | 0.7–1.7 s | **0.43 s** | per-op via batch |
| `snapshot` | 0.34–0.96 s | **0.32–0.35 s** | per-op via batch |
| **5-step flow** | 2.68 s | 2.17 s | **1.22 s** |

First call pays a one-time ~1.7 s lazy-spawn cost; subsequent calls are
warm. Idle-exit after ~5 minutes. Disable with `ANDROID_SKILL_USE_DAEMON=0`.

Sidecar safety: the daemon writes the public uid sidecar **only** on
explicit `snapshot` ops. BG refresh updates raw XML only — never the
sidecar — so `tap uN` cannot resolve to a uid the user never saw. The
mutation-gen counter discards stale dump writes that started under an
older gen.

## Maestro (separate lane)

Different layer: a flow runner with its own DSL, not a host-side selector
lib. Write a YAML flow, run `maestro test flow.yaml`, get structured
pass/fail.

```yaml
appId: com.example.app
---
- launchApp
- tapOn: { id: "login_btn" }
- inputText: "alice@example.com"
- assertVisible: "Welcome"
- takeScreenshot: result
```

Pros: built-in idle/wait/retry, internal accessibility-tree caching, single
binary (`brew install --formula mobile-dev-inc/tap/maestro`), same flow
grammar on iOS.
Cons: YAML DSL alongside the selector grammar, same Compose blind spot as
uiautomator (reads the same tree).

Pick Maestro for durable repeatable flows you want in-repo / on iOS too.
See `references/maestro.md` and `scripts/run_maestro.sh` (the wrapper puts
`--device` / `--platform` as top-level args, not subcommand options —
Maestro silently ignores them otherwise). Use `scripts/harvest-to-maestro.py`
to lower a working `--record`-captured flow into Maestro YAML.

Maestro is a **parallel lane**, not hidden behind the `ui_snapshot.py` /
`ui_act.py` facade — its stateful YAML model does not map cleanly onto
uid-tap.
