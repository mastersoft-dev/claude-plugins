#!/usr/bin/env python3
"""ui_run_flow.py — run a multi-step Android UI flow as a single batch.

Why: each `ui_act.py` invocation pays Python startup + arg parsing + one
UDS round-trip to the daemon. For a 5-step flow that's ~150 ms × N
overhead. The daemon already supports a `batch` op that executes all
sub-ops in one round-trip; this CLI is the user-facing surface for it.

Live-bench: 5-step flow drops from 2.17 s (sequential ui_act.py calls)
to 1.22 s when run as a batch — ~44 % faster end-to-end on real device.

Input formats: JSON or YAML (when PyYAML available). Read from a file
(`--file flow.json`), stdin (`--stdin`), or inline (`--ops '<json>'`).

Flow shape:

    {
        "ops": [
            {"op":"tap",  "args":{"target":"id=search","wait_for":["id=input"]}},
            {"op":"type", "args":{"target":"id=input","text":"hello"}},
            {"op":"key",  "args":{"code":"KEYCODE_ENTER"}},
            {"op":"snapshot", "args":{"only_clickable":true,"max_lines":10}},
            {"op":"screencap","args":{"path":"/tmp/result.png"}}
        ],
        "stop_on_error": true
    }

Sub-op `args` map directly onto the daemon's per-op argument shape — see
`scripts/android_skill_daemon.py` for the complete keyword list. Common
keys per op:

  tap   : target, timeout, wait_for, wait_stable_ms, post_wait_ms,
          timeout_ms, fail_on_timeout
  type  : target, text, timeout (clear is implicit; daemon's set_text
          replaces the field)
  key   : code (e.g. "KEYCODE_ENTER"), wait_for, ...
  snapshot : only_clickable, query (list), max_lines, include_bounds
  screencap : path (saves PNG; if absent, returns size only)

Per-op stdout from the daemon is concatenated and printed; per-op stderr
breadcrumbs likewise. Exit code is the daemon's aggregate `rc`.

Falls back to direct sequential execution when the daemon is unreachable
or `ANDROID_SKILL_USE_DAEMON=0`. Not a transparent equivalent — falls
through to one-by-one invocations of the underlying primitives, which
takes longer but lets the script work in CI/no-daemon environments.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Make sibling modules importable when invoked as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ui_act  # noqa: E402
import ui_snapshot  # noqa: E402


def _load_flow(args: argparse.Namespace) -> dict:
    """Load flow from --file, --stdin, or --ops. Tries JSON first; if
    PyYAML is installed, falls back to YAML."""
    raw: str
    if args.file:
        raw = Path(args.file).read_text(encoding="utf-8")
    elif args.stdin:
        raw = sys.stdin.read()
    elif args.ops is not None:
        raw = args.ops
    else:
        raise SystemExit("ui_run_flow: provide --file, --stdin, or --ops")

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise SystemExit(
                f"ui_run_flow: input is not valid JSON, and PyYAML is not "
                f"installed for YAML fallback ({exc})"
            ) from exc
        return yaml.safe_load(raw)


def _resolve_serial(cli_serial: str | None) -> str | None:
    return ui_snapshot.resolve_serial(cli_serial)


def _print_results(results: list[tuple[int, str, str, bool]]) -> int:
    """Print stdout + stderr breadcrumbs from each sub-op. Return aggregate
    rc — first non-zero, or 0."""
    agg = 0
    for i, (rc, out, err, _post) in enumerate(results):
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        if rc != 0 and agg == 0:
            agg = rc
    return agg


def _run_via_daemon(
    serial: str | None, ops: list[dict], stop_on_error: bool,
    flow_timeout_ms: int | None = None,
) -> int | None:
    """Try the batch endpoint. Return rc on success, None on transport
    failure (caller falls back).

    Pays a one-time wait for the daemon socket on cold start: the whole
    point of batch is to amortise IPC, so falling through to per-op
    subprocess fallback on first call defeats it. Single-op ui_act callers
    keep the fast cold-start path; only batch opts into the wait.
    """
    results = ui_act._daemon_batch(
        serial, ops,
        stop_on_error=stop_on_error,
        wait_for_daemon=True,
        flow_timeout_ms=flow_timeout_ms,
    )
    if results is None:
        return None
    return _print_results(results)


def _post_sync_cli_args(args: dict) -> list[str]:
    """Map sub-op post-sync keys onto ui_act.py CLI flags. Same vocabulary
    daemon understands; CLI flags are flat. timeout_ms (ms) is converted
    to --timeout (seconds) since ui_act.py uses seconds for that flag."""
    out: list[str] = []
    # Normalise wait_for to list — daemon accepts a bare string, but
    # iterating a string char-by-char in this loop would emit one
    # --wait-for per character (silent corruption). Match daemon's
    # `_post_sync_args` shape.
    wait_for = args.get("wait_for")
    if isinstance(wait_for, str):
        wait_for = [wait_for]
    for sel in wait_for or []:
        out += ["--wait-for", sel]
    if args.get("wait_stable_ms"):
        out += ["--wait-stable-ms", str(args["wait_stable_ms"])]
    if args.get("post_wait_ms"):
        out += ["--post-wait-ms", str(args["post_wait_ms"])]
    if args.get("fail_on_timeout"):
        out += ["--fail-on-timeout"]
    if args.get("timeout") is not None:
        out += ["--timeout", str(args["timeout"])]
    elif args.get("timeout_ms") is not None:
        try:
            secs = float(args["timeout_ms"]) / 1000.0
            out += ["--timeout", f"{secs:.3f}"]
        except (TypeError, ValueError):
            pass
    return out


def _run_sequential_fallback(
    serial: str | None, ops: list[dict], stop_on_error: bool
) -> int:
    """Each sub-op spawns a fresh ui_act.py / ui_snapshot.py / adb call.
    Slow but works without the daemon."""
    here = os.path.dirname(os.path.abspath(__file__))
    ui_act_py = os.path.join(here, "ui_act.py")
    ui_snapshot_py = os.path.join(here, "ui_snapshot.py")

    serial_args = ["--serial", serial] if serial else []
    agg_rc = 0
    for i, sub in enumerate(ops):
        op = sub.get("op")
        args = sub.get("args") or {}
        cmd: list[str]
        if op == "tap":
            cmd = [ui_act_py, *serial_args, "tap", str(args.get("target", ""))]
            cmd += _post_sync_cli_args(args)
        elif op == "type":
            cmd = [
                ui_act_py, *serial_args, "type",
                str(args.get("target", "")), str(args.get("text", "")),
            ]
            cmd += _post_sync_cli_args(args)
        elif op == "key":
            cmd = [ui_act_py, *serial_args, "key", str(args.get("code", ""))]
            cmd += _post_sync_cli_args(args)
        elif op == "snapshot":
            cmd = [ui_snapshot_py, *serial_args]
            if args.get("only_clickable"):
                cmd += ["--only-clickable"]
            for q in args.get("query") or []:
                cmd += ["--query", q]
            if args.get("max_lines"):
                cmd += ["--max-lines", str(args["max_lines"])]
            if args.get("include_bounds") is False:
                cmd += ["--include-bounds=false"]
        elif op == "screencap":
            path = args.get("path") or "/tmp/screencap.png"
            adb = ui_snapshot.adb_bin()
            adb_cmd = [adb]
            if serial:
                adb_cmd += ["-s", serial]
            adb_cmd += ["exec-out", "screencap", "-p"]
            with open(path, "wb") as fp:
                rc = subprocess.run(adb_cmd, stdout=fp).returncode
            if rc != 0 and stop_on_error:
                return rc
            if rc != 0 and agg_rc == 0:
                agg_rc = rc
            continue
        else:
            sys.stderr.write(f"ui_run_flow: fallback can't run sub-op {op!r}\n")
            if stop_on_error:
                return 64
            agg_rc = agg_rc or 64
            continue

        rc = subprocess.run(cmd).returncode
        if rc != 0 and stop_on_error:
            return rc
        if rc != 0 and agg_rc == 0:
            agg_rc = rc
    return agg_rc


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--serial", default=None,
                   help="adb serial (else $ANDROID_SERIAL or session file)")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--file", default=None, help="flow file (JSON or YAML)")
    src.add_argument("--stdin", action="store_true", help="read flow from stdin")
    src.add_argument("--ops", default=None, help="inline flow JSON")
    p.add_argument("--stop-on-error", action="store_true", default=True,
                   help="stop at first non-zero sub-op (default: true)")
    p.add_argument("--no-stop-on-error", dest="stop_on_error",
                   action="store_false",
                   help="continue on errors; aggregate rc is the first non-zero")
    p.add_argument("--record", default=None, metavar="FILE",
                   help="save the parsed flow JSON to FILE before running. "
                        "Enables exact replay later via --file FILE.")
    p.add_argument("--record-append", default=None, metavar="FILE",
                   help="append the parsed flow as one JSON-per-line entry "
                        "to FILE. Use to capture an interactive session "
                        "across multiple ui_run_flow invocations into a "
                        "single timeline.")
    p.add_argument("--require-anchor", default=None, action="append", metavar="SELECTOR",
                   help="pre-flight: run a `describe` op before the flow and "
                        "abort with rc=64 if any anchor selector misses. "
                        "Repeatable. Catches the 'not on the screen I expected' "
                        "class of bug cheaply (one cached snapshot, no taps).")
    p.add_argument("--trace", default=None, metavar="DIR",
                   help="override trace directory. BG trace is ON by default "
                        "but the auto-picked path is NOT advertised on success — "
                        "frames are forensic snapshots for the human, looked at "
                        "only when investigating a failed flow. Pass --trace DIR "
                        "to override the location.")
    p.add_argument("--no-trace", "--fast", dest="no_trace", action="store_true",
                   help="disable BG trace entirely (no frames written).")
    p.add_argument("--show-trace", action="store_true",
                   help="print the trace dir on stderr at start, regardless of "
                        "outcome. Use when explicitly post-morteming. By default "
                        "the dir is only mentioned when the flow returns "
                        "non-zero, keeping the success path quiet.")
    p.add_argument("--trace-format", default="jpeg", choices=("jpeg", "png"),
                   help="format for trace frames. Default `jpeg` is the "
                        "FASTEST path (~80 ms warm via u2 native) and "
                        "produces ~70 KB files. `png` is lossless but "
                        "slower (~170 ms via adb fallback) and 3× larger.")
    args = p.parse_args()

    flow = _load_flow(args)
    ops = flow.get("ops")
    if not isinstance(ops, list) or not ops:
        sys.stderr.write("ui_run_flow: flow has no 'ops' list\n")
        return 64
    stop_on_error = bool(flow.get("stop_on_error", args.stop_on_error))
    flow_timeout_ms = flow.get("flow_timeout_ms")
    if flow_timeout_ms is not None:
        try:
            flow_timeout_ms = int(flow_timeout_ms)
        except (TypeError, ValueError):
            sys.stderr.write("ui_run_flow: 'flow_timeout_ms' must be integer ms\n")
            return 64
    serial = _resolve_serial(args.serial)

    if args.record:
        try:
            Path(args.record).parent.mkdir(parents=True, exist_ok=True)
            Path(args.record).write_text(
                json.dumps(flow, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except Exception as e:
            sys.stderr.write(f"ui_run_flow: --record write failed: {e}\n")

    if args.record_append:
        try:
            Path(args.record_append).parent.mkdir(parents=True, exist_ok=True)
            with open(args.record_append, "a", encoding="utf-8") as fp:
                fp.write(json.dumps(flow, ensure_ascii=False) + "\n")
        except Exception as e:
            sys.stderr.write(f"ui_run_flow: --record-append write failed: {e}\n")

    # BG trace remains ON by default — frames on disk are valuable
    # forensic primitive for the human investigating failures or long
    # loops. But the auto-picked dir is NOT advertised on stderr at
    # start, so the LLM does not see a tempting path to `Read()`.
    #
    # Surface rules:
    #   * --no-trace / --fast    → disabled, no frames written
    #   * --trace DIR            → explicit dir, advertised on stderr
    #   * --show-trace           → advertise the auto-picked dir at start
    #   * (default)              → auto-pick dir, silent on stderr; the
    #                              dir is only printed when the flow
    #                              returns non-zero (see end of main()).
    #
    # The intent is "images exist, but stay secondary". The right answer
    # to 'what's on the screen?' is the tree — describe / snapshot --query
    # / window_sig — at ~100 bytes per call vs ~25-50 K tokens for a
    # frame Read.
    if args.no_trace:
        trace_dir: Path | None = None
    elif args.trace:
        trace_dir = Path(args.trace)
    else:
        base = Path(os.environ.get("TMPDIR", "/tmp")) / "android-skill-trace" / (serial or "default")
        trace_dir = base / time.strftime("%Y%m%d-%H%M%S")
        if args.show_trace:
            sys.stderr.write(f"ui_run_flow: trace → {trace_dir}\n")

    if trace_dir is not None:
        # BG trace: the daemon spawns a screencap on a separate thread
        # after every mutation (`adb exec-out screencap`, no u2 lock
        # contention). The next op is free to acquire u2 immediately
        # while the previous frame writes in BG. Replaces the older
        # inject-screencap-sub-op approach which serialised capture
        # between every pair of ops.
        #
        # Frames are named `<gen>-<op>.<ext>` so a directory listing
        # reads chronologically. trace_start prepends to the batch;
        # trace_stop is sent UNCONDITIONALLY after the batch returns
        # (see try/finally below) — appending it as a sub-op would not
        # run on stop_on_error abort, leaving _trace_dir set on the
        # daemon and silently capturing into stale dirs on the next
        # batch (including --no-trace ones).
        trace_dir.mkdir(parents=True, exist_ok=True)
        ops = (
            [{"op": "trace_start", "args": {
                "dir": str(trace_dir),
                "format": args.trace_format,
                "quality": 85,
            }}]
            + ops
        )

    if args.require_anchor:
        # Pre-flight: one describe call answers "is the screen what I
        # think it is?" before any tap fires. Common cause of flow
        # failures is the prior batch ending on a different screen than
        # expected (countdown elapsed, BACK pressed, app crashed). Cost
        # ~50 ms warm vs minutes spent debugging the wrong-screen tap.
        anchors = list(args.require_anchor)
        preflight = ui_act._daemon_batch(
            serial,
            [{"op": "describe", "args": {"selectors": anchors}}],
            stop_on_error=True,
            wait_for_daemon=True,
        )
        if preflight is None:
            sys.stderr.write("ui_run_flow: --require-anchor: daemon unreachable; skipping pre-flight\n")
        else:
            for sub_rc, out, err, _ in preflight:
                if sub_rc != 0:
                    sys.stderr.write(f"ui_run_flow: --require-anchor failed: {err}")
                    return 64
                try:
                    body = json.loads(out)
                except Exception:
                    sys.stderr.write("ui_run_flow: --require-anchor: bad describe output\n")
                    return 64
                if int(body.get("matched", 0)) != int(body.get("total", 1)):
                    missing = [r["selector"] for r in body.get("results", []) if not r.get("found")]
                    sys.stderr.write(
                        f"ui_run_flow: --require-anchor: not on expected screen — "
                        f"missing {missing}\n"
                    )
                    return 64

    rc: int = 0
    try:
        result = _run_via_daemon(serial, ops, stop_on_error, flow_timeout_ms=flow_timeout_ms)
        if result is not None:
            rc = result
            return rc

        # Daemon unreachable — sequential fallback. Slower but correct.
        sys.stderr.write(
            "ui_run_flow: daemon unreachable; running sequentially. "
            "Set ANDROID_SKILL_USE_DAEMON=1 (default) and ensure adb device is "
            "available to amortise the cost.\n"
        )
        rc = _run_sequential_fallback(serial, ops, stop_on_error)
        return rc
    finally:
        # When trace was active, send a standalone trace_stop request
        # so the daemon clears `_trace_dir` even if the batch aborted
        # mid-way (stop_on_error / KeyboardInterrupt / exception).
        # Required: the in-batch trace_stop sub-op does NOT run when
        # an earlier op fails with stop_on_error — without this guard
        # the next --no-trace batch silently writes into the previous
        # batch's trace dir.
        if trace_dir is not None:
            try:
                ui_act._daemon_request(serial, "trace_stop", {})
            except Exception:
                pass
            # Surface the trace dir on FAILURE only — frames are forensic
            # output for the human investigating divergence, not a
            # primary surface for the LLM. On success we stay quiet so
            # the dir doesn't become a tempting `Read()` target.
            if rc != 0 and not args.show_trace:
                sys.stderr.write(
                    f"ui_run_flow: flow rc={rc} — trace frames at: {trace_dir}\n"
                    f"  inspect by name (each frame = `<gen>-<op>.jpg`); "
                    f"only Read() a frame if the tree (`describe` / "
                    f"`snapshot --query`) cannot answer the divergence.\n"
                )


if __name__ == "__main__":
    sys.exit(main())
