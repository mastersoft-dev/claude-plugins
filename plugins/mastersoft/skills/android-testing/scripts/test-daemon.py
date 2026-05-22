#!/usr/bin/env python3
"""test-daemon.py — in-process unit tests for android_skill_daemon.

Mocks `subprocess.run`, `ui_snapshot.run_adb_dump`, and the u2 device
handle so the tests can exercise every op shape without touching a real
device. Focus is correctness of arg validation, shell pipe construction,
batch dispatch, and the validate pre-pass — the parts most likely to
silently regress when a future op is added.

Run: `scripts/test-daemon.py` — exits 0 on pass, 1 on fail.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import types
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import android_skill_daemon as daemon  # noqa: E402
import ui_snapshot  # noqa: E402


# ---------------------------------------------------------------------------
# Test harness — minimal `Daemon` instance that doesn't touch the network.
# ---------------------------------------------------------------------------

class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: bytes = b"", stderr: bytes = b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _new_daemon() -> "daemon.Daemon":
    """Spawn a Daemon without letting its BG refresh thread hit the device."""
    d = daemon.Daemon(serial="TEST")
    # Pin the decimal-sleep probe so tests don't shell out.
    d._sleep_decimal_supported = True
    return d


def _drain(d: "daemon.Daemon") -> None:
    d._stop.set()
    d._refresh_event.set()
    d._refresh_thread.join(timeout=2.0)


# ---------------------------------------------------------------------------
# _op_sleep
# ---------------------------------------------------------------------------

def test_sleep_clamps_negative() -> bool:
    d = _new_daemon()
    try:
        with patch.object(time, "sleep") as ms:
            resp = d._op_sleep({"ms": -100})
        assert resp["rc"] == 0, resp
        # Negative clamped to 0 → no sleep call.
        ms.assert_not_called()
        return True
    finally:
        _drain(d)


def test_sleep_clamps_huge() -> bool:
    d = _new_daemon()
    try:
        with patch.object(time, "sleep") as ms:
            resp = d._op_sleep({"ms": 999_999})
        assert resp["rc"] == 0, resp
        # Clamped to 10000ms = 10.0s.
        ms.assert_called_once_with(10.0)
        return True
    finally:
        _drain(d)


def test_sleep_rejects_non_int() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_sleep({"ms": "abc"})
        assert resp["rc"] == 64, resp
        assert "must be an integer" in resp["err"]
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# _op_tap_point — shell cmd shape
# ---------------------------------------------------------------------------

def test_tap_point_shell_cmd() -> bool:
    d = _new_daemon()
    try:
        with patch.object(daemon.subprocess, "run", return_value=_FakeProc()) as run:
            resp = d._op_tap_point({"x": 540, "y": 960})
        assert resp["rc"] == 0, resp
        cmd = run.call_args.args[0]
        assert "input" in cmd and "tap" in cmd, cmd
        assert "540" in cmd and "960" in cmd, cmd
        # Mutation bumped + sidecar invalidated implicitly via _bump.
        assert d._mutation_gen == 1
        return True
    finally:
        _drain(d)


def test_tap_point_missing_args() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_tap_point({"x": 540})
        assert resp["rc"] == 64, resp
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# _op_swipe + _op_long_press
# ---------------------------------------------------------------------------

def test_swipe_clamps_duration() -> bool:
    d = _new_daemon()
    try:
        with patch.object(daemon.subprocess, "run", return_value=_FakeProc()) as run:
            resp = d._op_swipe({
                "x1": 100, "y1": 200, "x2": 300, "y2": 400,
                "duration_ms": 99_999,
            })
        assert resp["rc"] == 0, resp
        cmd = run.call_args.args[0]
        # Duration clamped to 5000.
        assert "5000" in cmd, cmd
        return True
    finally:
        _drain(d)


def test_long_press_default_duration() -> bool:
    d = _new_daemon()
    try:
        with patch.object(daemon.subprocess, "run", return_value=_FakeProc()) as run:
            resp = d._op_long_press({"x": 540, "y": 960})
        assert resp["rc"] == 0, resp
        cmd = run.call_args.args[0]
        # Default duration 1500ms.
        assert "1500" in cmd, cmd
        # Long press uses input swipe with start==end.
        assert cmd.count("540") == 2
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# _op_tap_macro — shell pipe construction
# ---------------------------------------------------------------------------

def test_tap_macro_builds_pipe_with_sleeps() -> bool:
    d = _new_daemon()
    try:
        with patch.object(daemon.subprocess, "run", return_value=_FakeProc()) as run:
            resp = d._op_tap_macro({
                "taps": [[100, 200], [300, 400], [500, 600]],
                "delay_ms": 80,
            })
        assert resp["rc"] == 0, resp
        cmd = run.call_args.args[0]
        # Last arg is the shell pipe.
        pipe = cmd[-1]
        assert pipe.count("input tap") == 3, pipe
        assert pipe.count("sleep 0.080") == 2, pipe  # N-1 sleeps for N taps
        assert "100 200" in pipe and "500 600" in pipe, pipe
        return True
    finally:
        _drain(d)


def test_tap_macro_no_decimal_sleep_drops_sleeps() -> bool:
    """Pre-API-26 toybox doesn't support decimal sleep — macro should
    drop the sleep clauses entirely (kernel naturally spaces taps)."""
    d = _new_daemon()
    d._sleep_decimal_supported = False
    try:
        with patch.object(daemon.subprocess, "run", return_value=_FakeProc()) as run:
            resp = d._op_tap_macro({"taps": [[1, 2], [3, 4]], "delay_ms": 80})
        assert resp["rc"] == 0
        pipe = run.call_args.args[0][-1]
        assert "sleep" not in pipe, pipe
        return True
    finally:
        _drain(d)


def test_tap_macro_rejects_empty() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_tap_macro({"taps": []})
        assert resp["rc"] == 64
        return True
    finally:
        _drain(d)


def test_tap_macro_rejects_bad_pair() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_tap_macro({"taps": [[1, 2], "not-a-pair"]})
        assert resp["rc"] == 64, resp
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# _validate_batch_ops — every required-arg case
# ---------------------------------------------------------------------------

def test_validate_rejects_unknown_op() -> bool:
    err = daemon.Daemon._validate_batch_ops([{"op": "qwerty"}])
    return "unknown op" in err


def test_validate_rejects_missing_target() -> bool:
    err = daemon.Daemon._validate_batch_ops([{"op": "tap", "args": {}}])
    return "missing required arg 'target'" in err


def test_validate_rejects_missing_assume_stable() -> bool:
    err = daemon.Daemon._validate_batch_ops([
        {"op": "resolve_then_tap_sequence", "args": {"selectors": ["text=\"X\""]}}
    ])
    return "assume_stable_coords" in err


def test_validate_rejects_bad_taps_pair() -> bool:
    err = daemon.Daemon._validate_batch_ops([
        {"op": "tap_macro", "args": {"taps": [[1, "abc"]]}}
    ])
    return "failed type/shape check" in err


def test_validate_accepts_valid_flow() -> bool:
    err = daemon.Daemon._validate_batch_ops([
        {"op": "tap", "args": {"target": "text=\"X\""}},
        {"op": "sleep", "args": {"ms": 100}},
        {"op": "tap_macro", "args": {"taps": [[1, 2], [3, 4]]}},
    ])
    return err == ""


def test_validate_rejects_non_dict_op() -> bool:
    err = daemon.Daemon._validate_batch_ops(["not-a-dict"])
    return "must be a dict" in err


def test_validate_rejects_timeout_typo_with_hint() -> bool:
    """LLM keeps writing `timeout: 8` (seconds) instead of `timeout_ms: 8000`.
    Validator must catch the unknown field AND surface the right name."""
    err = daemon.Daemon._validate_batch_ops([
        {"op": "tap", "args": {"target": "text=\"X\"", "timeout": 8}}
    ])
    return "timeout" in err and "timeout_ms" in err


def test_validate_rejects_unknown_arg() -> bool:
    """Unknown args used to be silently ignored. Now rejected
    with allowed-list."""
    err = daemon.Daemon._validate_batch_ops([
        {"op": "tap", "args": {"target": "text=\"X\"", "frobnicate": True}}
    ])
    return "frobnicate" in err and "allowed" in err


def test_validate_accepts_post_sync_keys() -> bool:
    """Post-sync vocabulary (wait_for, timeout_ms, etc.) must be
    accepted on every mutating op without per-op listing."""
    err = daemon.Daemon._validate_batch_ops([
        {"op": "tap", "args": {
            "target": "text=\"X\"",
            "wait_for": ["text=\"Y\""],
            "timeout_ms": 8000,
            "wait_stable_ms": 500,
        }}
    ])
    return err == ""


# ---------------------------------------------------------------------------
# _summarise_args — field handling
# ---------------------------------------------------------------------------

def test_summarise_drops_text_keeps_length() -> bool:
    out = daemon.Daemon._summarise_args("type", {
        "target": "id=email", "text": "secret-token-12345",
    })
    return out.get("text_len") == 18 and "text" not in out and out.get("target") == "id=email"


def test_summarise_collapses_taps_to_count() -> bool:
    out = daemon.Daemon._summarise_args("tap_macro", {
        "taps": [[1, 2], [3, 4], [5, 6]], "delay_ms": 80,
    })
    return out.get("taps_n") == 3 and out.get("delay_ms") == 80


def test_summarise_collapses_long_wait_for() -> bool:
    out = daemon.Daemon._summarise_args("tap", {
        "target": "x", "wait_for": ["a", "b", "c", "d", "e"],
    })
    return out.get("wait_for") == "5 clauses"


# ---------------------------------------------------------------------------
# _op_batch — flow_timeout_ms + proven_target + unknown sub-op
# ---------------------------------------------------------------------------

def test_batch_flow_timeout_aborts_mid_loop() -> bool:
    d = _new_daemon()
    try:
        # 5×100ms sleeps, budget 200ms — should abort around op[2] or so.
        resp = d._op_batch({
            "ops": [{"op": "sleep", "args": {"ms": 100}} for _ in range(5)],
            "flow_timeout_ms": 200,
        })
        # We expect rc=124 (timeout) and FEWER than 5 successful sleeps.
        if resp["rc"] != 124:
            print(f"FAIL: expected rc=124, got {resp['rc']!r}")
            return False
        if "exceeded" not in resp.get("err", ""):
            print(f"FAIL: missing 'exceeded' in err: {resp['err']!r}")
            return False
        return True
    finally:
        _drain(d)


def test_batch_unknown_sub_op_rejected_by_validate() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_batch({"ops": [{"op": "qwerty", "args": {}}]})
        assert resp["rc"] == 64, resp
        return "unknown op" in resp["err"]
    finally:
        _drain(d)


def test_batch_validate_blocks_dispatch() -> bool:
    """Validate pre-pass MUST reject before any sub-op runs — verify by
    asserting subprocess.run is never called even though sub-ops would
    have shelled out."""
    d = _new_daemon()
    try:
        with patch.object(daemon.subprocess, "run") as run:
            resp = d._op_batch({"ops": [
                {"op": "tap_point", "args": {"x": 100, "y": 200}},  # valid
                {"op": "tap", "args": {}},  # invalid: missing target
            ]})
        assert resp["rc"] == 64, resp
        # Must not have dispatched the first op.
        assert run.call_count == 0, run.call_args_list
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# Snapshot cache_gen behaviour (no live device)
# ---------------------------------------------------------------------------

def test_snapshot_cache_hit_when_gen_matches() -> bool:
    d = _new_daemon()
    try:
        cache_path = ui_snapshot.meta_path("TEST").with_suffix(".xml")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(b"<hierarchy><node text='X' bounds='[0,0][10,10]' clickable='true'/></hierarchy>")
        with d._gen_lock:
            d._mutation_gen = 5
            d._xml_cache_gen = 5
        # No mock for run_adb_dump — must NOT be called on hit.
        called = {"n": 0}

        def boom(*a, **kw):
            called["n"] += 1
            raise AssertionError("run_adb_dump should not be called on cache hit")

        with patch.object(ui_snapshot, "run_adb_dump", side_effect=boom):
            with patch.object(ui_snapshot, "compute_window_sig", return_value=("sig", 0)):
                with patch.object(ui_snapshot, "get_foreground_activity", return_value=""):
                    with patch.object(ui_snapshot, "write_meta_sidecar"):
                        resp = d._op_snapshot({"only_clickable": False, "max_lines": 10})
        assert resp["rc"] == 0, resp
        assert called["n"] == 0
        assert "cache_hit" in resp.get("err", ""), resp
        return True
    finally:
        try:
            cache_path.unlink()
        except FileNotFoundError:
            pass
        _drain(d)


# ---------------------------------------------------------------------------
# describe — miss carries nearby[] selectors + foreground hint
# ---------------------------------------------------------------------------

def test_describe_miss_includes_nearby_and_hint() -> bool:
    """When `describe` selector misses on a tree that DOES have labels,
    the response must include `nearby[]` with text=/desc= selectors
    drawn from the live tree, plus `foreground` and a `hint` string.
    Lets the LLM correct course without re-dumping or escalating to a
    frame Read."""
    d = _new_daemon()
    try:
        xml = (
            b"<hierarchy><node bounds='[0,0][100,100]'>"
            b"<node text='Salva' bounds='[10,10][50,50]' clickable='true'/>"
            b"<node text='Annulla' bounds='[60,10][90,50]' clickable='true'/>"
            b"<node content-desc='Indietro' bounds='[0,60][30,90]' clickable='true'/>"
            b"</node></hierarchy>"
        )
        # `_acquire_xml` calls `run_adb_dump` which returns
        # (xml, screen_size). Stage a sufficient mock surface.
        with patch.object(ui_snapshot, "run_adb_dump", return_value=(xml, (100, 100))):
            with patch.object(ui_snapshot, "get_screen_size", return_value=(100, 100)):
                with patch.object(ui_snapshot, "get_foreground_activity", return_value="com.example/.Main"):
                    resp = d._op_describe({"selectors": ["text=\"NonExistent\""]})
        assert resp["rc"] == 0, resp
        body = json.loads(resp["out"])
        assert body["matched"] == 0, body
        assert body["total"] == 1, body
        assert body["foreground"] == "com.example/.Main", body
        assert "hint" in body and "nearby" in body["hint"], body
        labels = {entry["selector"] for entry in body["nearby"]}
        assert 'text="Salva"' in labels, labels
        assert 'text="Annulla"' in labels, labels
        assert 'desc="Indietro"' in labels, labels
        return True
    finally:
        _drain(d)


def test_describe_full_match_omits_nearby() -> bool:
    """When every selector resolves, the response is the lean shape:
    `nearby` / `foreground` / `hint` are NOT included. Keeps the
    happy path's response small."""
    d = _new_daemon()
    try:
        xml = (
            b"<hierarchy><node bounds='[0,0][100,100]'>"
            b"<node text='Salva' bounds='[10,10][50,50]' clickable='true'/>"
            b"</node></hierarchy>"
        )
        with patch.object(ui_snapshot, "run_adb_dump", return_value=(xml, (100, 100))):
            with patch.object(ui_snapshot, "get_screen_size", return_value=(100, 100)):
                resp = d._op_describe({"selectors": ["text=\"Salva\""]})
        assert resp["rc"] == 0, resp
        body = json.loads(resp["out"])
        assert body["matched"] == 1, body
        assert "nearby" not in body, body
        assert "foreground" not in body, body
        assert "hint" not in body, body
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# trace_start / trace_stop / BG capture
# ---------------------------------------------------------------------------

def test_trace_start_sets_state() -> bool:
    d = _new_daemon()
    try:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "frames"
            resp = d._op_trace_start({"dir": str(target), "format": "jpeg", "quality": 70})
            assert resp["rc"] == 0, resp
            assert d._trace_dir == target
            assert d._trace_format == "jpeg"
            assert d._trace_jpeg_quality == 70
            assert target.exists()
            return True
    finally:
        _drain(d)


def test_trace_start_rejects_missing_dir() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_trace_start({})
        return resp["rc"] == 64 and "'dir' required" in resp["err"]
    finally:
        _drain(d)


def test_trace_start_rejects_bad_format() -> bool:
    d = _new_daemon()
    try:
        resp = d._op_trace_start({"dir": "/tmp", "format": "bmp"})
        return resp["rc"] == 64 and "bad format" in resp["err"]
    finally:
        _drain(d)


def test_trace_stop_clears_state() -> bool:
    d = _new_daemon()
    try:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            d._op_trace_start({"dir": td})
            assert d._trace_dir is not None
            resp = d._op_trace_stop({})
            assert resp["rc"] == 0
            assert d._trace_dir is None
            return True
    finally:
        _drain(d)


def test_validate_rejects_trace_start_without_dir() -> bool:
    err = daemon.Daemon._validate_batch_ops([{"op": "trace_start", "args": {}}])
    return "missing required arg 'dir'" in err


def test_validate_accepts_trace_stop() -> bool:
    err = daemon.Daemon._validate_batch_ops([{"op": "trace_stop", "args": {}}])
    return err == ""


def test_bump_mutation_submits_capture_when_trace_active() -> bool:
    """When `_trace_dir` is set, every `_bump_mutation` must hand a
    capture to the BG executor. We stub `_capture_trace_frame` so the
    test doesn't shell out — only asserts the wiring fires."""
    d = _new_daemon()
    try:
        import tempfile
        captures: list[tuple[int, str]] = []

        def fake_capture(gen: int, label: str) -> None:
            captures.append((gen, label))

        with tempfile.TemporaryDirectory() as td:
            d._op_trace_start({"dir": td})
            with patch.object(d, "_capture_trace_frame", side_effect=fake_capture):
                d._bump_mutation("tap")
                d._bump_mutation("type")
            assert len(captures) == 2, captures
            assert captures[0][1] == "tap"
            assert captures[1][1] == "type"
            # gens monotone increasing
            assert captures[0][0] < captures[1][0]

            # After trace_stop, no further captures fire.
            d._op_trace_stop({})
            with patch.object(d, "_capture_trace_frame", side_effect=fake_capture):
                d._bump_mutation("key")
            assert len(captures) == 2, captures  # unchanged
            return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# find_target — clickable-ancestor preference
# ---------------------------------------------------------------------------

def test_find_target_prefers_clickable_ancestor_over_bare_label() -> bool:
    """Regression for the Impostazioni-row bug: two TextViews with
    text="Impostazioni" exist on the same screen — one is the page
    title (NO clickable ancestor), the other is a label inside a
    clickable row. The selector ranking must pick the row's label so
    the tap fires inside the clickable container.
    """
    import ui_act
    xml = (
        b"<hierarchy><node bounds='[0,0][1000,2000]'>"
        # page title — not inside anything clickable
        b"<node text='Impostazioni' bounds='[54,810][351,903]' clickable='false'/>"
        # row container, clickable, with TextView child
        b"<node bounds='[0,1040][1000,1100]' clickable='true'>"
        b"<node text='Impostazioni' bounds='[240,1062][720,1080]' clickable='false'/>"
        b"</node>"
        b"</node></hierarchy>"
    )
    root = ui_snapshot.build_tree(xml)
    nodes = ui_snapshot.prune(root, only_clickable=False, screen_size=(1000, 2000))
    for i, n in enumerate(nodes, 1):
        n.uid = f"u{i}"
    chosen = ui_act.find_target(nodes, 'text="Impostazioni"')
    assert chosen is not None, "no match"
    # The chosen node must be the row label (y around 1071, inside the
    # clickable row container at y=1040-1100), not the title at y=810.
    assert chosen.bounds is not None
    cy = (chosen.bounds[1] + chosen.bounds[3]) // 2
    assert cy > 1000, f"picked the title instead of the row (cy={cy})"
    return True


# ---------------------------------------------------------------------------
# key BACK + dismiss_ime — IME-aware safety
# ---------------------------------------------------------------------------

def test_key_back_refused_when_ime_hidden() -> bool:
    """`key BACK` without IME up navigates the activity — silently
    destroys wizard state. Must refuse with rc=64 + actionable hint
    unless `force: true` is set."""
    d = _new_daemon()
    try:
        with patch.object(d, "_is_ime_visible", return_value=False):
            resp = d._op_key({"code": "KEYCODE_BACK"})
        assert resp["rc"] == 64, resp
        assert "no IME visible" in resp["err"], resp
        assert "force: true" in resp["err"], resp
        assert "dismiss_ime" in resp["err"], resp
        return True
    finally:
        _drain(d)


def test_key_back_allowed_when_ime_visible() -> bool:
    d = _new_daemon()
    try:
        called = {"n": 0}
        def fake_retry(fn, *a, **k):
            called["n"] += 1
            return "ok"
        with patch.object(d, "_is_ime_visible", return_value=True):
            with patch.object(d, "_u2_call_with_retry", side_effect=fake_retry):
                with patch.object(d, "_post_sync_in_daemon", return_value=(True, "")):
                    resp = d._op_key({"code": "KEYCODE_BACK"})
        assert resp["rc"] == 0, resp
        assert called["n"] == 1
        return True
    finally:
        _drain(d)


def test_key_back_force_override_bypasses_check() -> bool:
    """`force: true` bypasses the IME guard — for the rare case where
    BACK is genuinely meant to navigate."""
    d = _new_daemon()
    try:
        with patch.object(d, "_is_ime_visible", return_value=False):
            with patch.object(d, "_u2_call_with_retry", return_value="ok"):
                with patch.object(d, "_post_sync_in_daemon", return_value=(True, "")):
                    resp = d._op_key({"code": "KEYCODE_BACK", "force": True})
        assert resp["rc"] == 0, resp
        return True
    finally:
        _drain(d)


def test_dismiss_ime_noop_when_ime_hidden() -> bool:
    d = _new_daemon()
    try:
        with patch.object(d, "_is_ime_visible", return_value=False):
            resp = d._op_dismiss_ime({})
        assert resp["rc"] == 0, resp
        assert "no-op" in resp["out"], resp
        return True
    finally:
        _drain(d)


def test_validate_accepts_dismiss_ime() -> bool:
    err = daemon.Daemon._validate_batch_ops([
        {"op": "dismiss_ime", "args": {}},
        {"op": "dismiss_ime", "args": {"wait_for": ["text=\"X\""]}},
    ])
    return err == ""


# ---------------------------------------------------------------------------
# _activity_task_id — extracts tN from foreground line
# ---------------------------------------------------------------------------

def test_describe_failure_does_not_abort_batch() -> bool:
    """Read-only ops (describe/snapshot/window_sig/health) are non-fatal
    in batches. A failed describe records its rc in results but does
    NOT stop subsequent ops from dispatching, even with the default
    stop_on_error=True. Lets the LLM embed verification ops mid-batch
    without splitting the batch on every diagnostic."""
    d = _new_daemon()
    try:
        dispatched: list[str] = []

        def fake_describe(args):
            return {"rc": 1, "out": "", "err": "fake describe failure\n"}

        def fake_sleep(args):
            dispatched.append("sleep")
            return {"rc": 0, "out": "slept\n", "err": ""}

        with patch.object(d, "_op_describe", side_effect=fake_describe):
            with patch.object(d, "_op_sleep", side_effect=fake_sleep):
                resp = d._op_batch({"ops": [
                    {"op": "describe", "args": {"selectors": ["text=\"X\""]}},
                    {"op": "sleep", "args": {"ms": 1}},
                ]})
        assert resp["rc"] == 1, f"agg rc should reflect describe failure: {resp}"
        assert "sleep" in dispatched, "sleep op must dispatch after failed describe"
        assert len(resp["results"]) == 2, f"both ops must be in results: {resp['results']}"
        return True
    finally:
        _drain(d)


def test_activity_task_id_extracts_tN() -> bool:
    d = _new_daemon()
    try:
        line = "topResumedActivity=ActivityRecord{4a37b41 u0 it.mastersoft.presente.kiosk/.MainActivity} t198}"
        with patch.object(d, "_foreground_activity_brief", return_value=line):
            assert d._activity_task_id() == "198"
        with patch.object(d, "_foreground_activity_brief", return_value=""):
            assert d._activity_task_id() == ""
        return True
    finally:
        _drain(d)


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

ALL = [
    "test_sleep_clamps_negative",
    "test_sleep_clamps_huge",
    "test_sleep_rejects_non_int",
    "test_tap_point_shell_cmd",
    "test_tap_point_missing_args",
    "test_swipe_clamps_duration",
    "test_long_press_default_duration",
    "test_tap_macro_builds_pipe_with_sleeps",
    "test_tap_macro_no_decimal_sleep_drops_sleeps",
    "test_tap_macro_rejects_empty",
    "test_tap_macro_rejects_bad_pair",
    "test_validate_rejects_unknown_op",
    "test_validate_rejects_missing_target",
    "test_validate_rejects_missing_assume_stable",
    "test_validate_rejects_bad_taps_pair",
    "test_validate_accepts_valid_flow",
    "test_validate_rejects_non_dict_op",
    "test_validate_rejects_timeout_typo_with_hint",
    "test_validate_rejects_unknown_arg",
    "test_validate_accepts_post_sync_keys",
    "test_summarise_drops_text_keeps_length",
    "test_summarise_collapses_taps_to_count",
    "test_summarise_collapses_long_wait_for",
    "test_batch_flow_timeout_aborts_mid_loop",
    "test_batch_unknown_sub_op_rejected_by_validate",
    "test_batch_validate_blocks_dispatch",
    "test_snapshot_cache_hit_when_gen_matches",
    "test_describe_miss_includes_nearby_and_hint",
    "test_describe_full_match_omits_nearby",
    "test_find_target_prefers_clickable_ancestor_over_bare_label",
    "test_key_back_refused_when_ime_hidden",
    "test_key_back_allowed_when_ime_visible",
    "test_key_back_force_override_bypasses_check",
    "test_dismiss_ime_noop_when_ime_hidden",
    "test_validate_accepts_dismiss_ime",
    "test_describe_failure_does_not_abort_batch",
    "test_activity_task_id_extracts_tN",
    "test_trace_start_sets_state",
    "test_trace_start_rejects_missing_dir",
    "test_trace_start_rejects_bad_format",
    "test_trace_stop_clears_state",
    "test_validate_rejects_trace_start_without_dir",
    "test_validate_accepts_trace_stop",
    "test_bump_mutation_submits_capture_when_trace_active",
]


def main() -> int:
    failed = 0
    for name in ALL:
        fn = globals()[name]
        try:
            ok = fn()
        except AssertionError as e:
            ok = False
            print(f"FAIL {name}: {e}", file=sys.__stderr__)
        except Exception as e:
            ok = False
            print(f"FAIL {name}: {type(e).__name__}: {e}", file=sys.__stderr__)
        marker = "ok" if ok else "FAIL"
        print(f"{marker} {name}")
        if not ok:
            failed += 1
    if failed:
        print(f"\n{failed}/{len(ALL)} tests failed", file=sys.stderr)
        return 1
    print(f"\nall {len(ALL)} tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
