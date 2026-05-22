#!/usr/bin/env python3
"""test-wedge.py — direct unit test for the daemon's wedge detector.

Imports `Daemon` from `android_skill_daemon`, instantiates without a real
serial, calls `_record_wedge_failure()` three times within the 30s window,
captures stderr, and asserts the breadcrumb fires exactly once.

Why a Python unit test instead of an integration test:
  * The integration approach (`adb shell pkill -9 atx-agent` + run a flow,
    grep stderr for `wedge detected`) is flaky — uiautomator2 auto-respawns
    atx-agent, so a pkill typically generates 1 transport failure, not 3.
  * Forcing 3 rapid failures requires sub-second adb commands and tight
    timing. Brittle on CI.
  * `_record_wedge_failure` is the load-bearing logic; if its threshold +
    breadcrumb behave correctly here, the field path works too.

Run: `scripts/test-wedge.py` — exits 0 on pass, 1 on fail.
"""

from __future__ import annotations

import io
import os
import sys
import time
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import android_skill_daemon as daemon  # noqa: E402


def _drain_threads(d: "daemon.Daemon") -> None:
    """Stop the BG refresh thread spawned by Daemon.__init__ so the test
    process doesn't hang at exit."""
    d._stop.set()
    d._refresh_event.set()
    d._refresh_thread.join(timeout=2.0)


def test_three_failures_emit_one_breadcrumb() -> bool:
    d = daemon.Daemon(serial=None)
    try:
        buf = io.StringIO()
        with redirect_stderr(buf):
            d._record_wedge_failure()
            d._record_wedge_failure()
            d._record_wedge_failure()
        out = buf.getvalue()
        if "wedge detected" not in out:
            print(f"FAIL: expected 'wedge detected' in stderr, got: {out!r}", file=sys.__stderr__)
            return False
        if out.count("wedge detected") != 1:
            print(f"FAIL: expected exactly 1 breadcrumb, got {out.count('wedge detected')}", file=sys.__stderr__)
            return False
        # Window cleared after the breadcrumb fires — next failure
        # should not trigger again immediately.
        buf2 = io.StringIO()
        with redirect_stderr(buf2):
            d._record_wedge_failure()
        if "wedge detected" in buf2.getvalue():
            print(f"FAIL: window did not clear; got extra breadcrumb: {buf2.getvalue()!r}", file=sys.__stderr__)
            return False
        return True
    finally:
        _drain_threads(d)


def test_two_failures_do_not_trigger() -> bool:
    d = daemon.Daemon(serial=None)
    try:
        buf = io.StringIO()
        with redirect_stderr(buf):
            d._record_wedge_failure()
            d._record_wedge_failure()
        out = buf.getvalue()
        if "wedge detected" in out:
            print(f"FAIL: 2 failures should not trigger; got: {out!r}", file=sys.__stderr__)
            return False
        return True
    finally:
        _drain_threads(d)


def test_old_failures_pruned_from_window() -> bool:
    d = daemon.Daemon(serial=None)
    try:
        # Inject two stale samples (35s ago) directly, then one fresh.
        # The stale ones should be pruned, leaving only one in-window.
        with d._wedge_lock:
            now = time.monotonic()
            d._wedge_failures.extend([now - 35.0, now - 32.0])
        buf = io.StringIO()
        with redirect_stderr(buf):
            d._record_wedge_failure()
        if "wedge detected" in buf.getvalue():
            print(f"FAIL: stale samples should be pruned; got breadcrumb: {buf.getvalue()!r}", file=sys.__stderr__)
            return False
        with d._wedge_lock:
            if len(d._wedge_failures) != 1:
                print(f"FAIL: expected window to contain 1 entry after prune, got {len(d._wedge_failures)}", file=sys.__stderr__)
                return False
        return True
    finally:
        _drain_threads(d)


def main() -> int:
    tests = [
        ("three_failures_emit_one_breadcrumb", test_three_failures_emit_one_breadcrumb),
        ("two_failures_do_not_trigger", test_two_failures_do_not_trigger),
        ("old_failures_pruned_from_window", test_old_failures_pruned_from_window),
    ]
    failed = 0
    for name, fn in tests:
        ok = fn()
        marker = "ok" if ok else "FAIL"
        print(f"{marker} test_{name}")
        if not ok:
            failed += 1
    if failed:
        print(f"\n{failed}/{len(tests)} tests failed", file=sys.stderr)
        return 1
    print(f"\nall {len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
