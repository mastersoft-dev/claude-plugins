#!/usr/bin/env python3
"""android_skill_daemon.py — long-lived UDS server for the android-testing skill.

Purpose
-------
Each ``ui_act.py`` / ``ui_snapshot.py`` invocation today is a fresh Python
process. That re-pays the ``u2.connect()`` cost (~700 ms on a real
device) on every action — which dominates the per-call latency our
u2-native fast path was supposed to remove.

This daemon is the structural fix:

* Holds a single warm ``u2.connect(serial)`` for the lifetime of the
  process. Reconnects only on transient transport failure.
* Maintains the **XML cache** opportunistically via a single background
  worker thread. After every successful mutating op, a refresh is
  enqueued; the worker debounces, runs ``uiautomator dump`` once, and
  atomically renames the XML cache file. A generation counter discards
  stale refreshes that completed *after* a newer mutation.
* **Does NOT touch the uid sidecar.** The sidecar is the public uid map
  for ``tap uN`` and is stamped from the *exact* node list a user saw
  printed. It is written exclusively by the ``snapshot`` op (where the
  caller's filters and ``--max-lines`` define which uids exist). BG
  refresh writes raw XML only; sidecar is left alone or invalidated
  on mutation, never silently rewritten.

Protocol (NDJSON over UDS)
--------------------------
One request per connection. Request shape::

    {"op": "<op>", "args": {...}}

Response::

    {"rc": <int>, "out": "<stdout>", "err": "<stderr>"}

Operations: ``health``, ``quit``, ``tap``, ``type``, ``key``,
``snapshot``.

Lifecycle
---------
Lazy fork-and-detach: ui_act/ui_snapshot detect a missing socket and
spawn the daemon (``--detach``); they connect, send the request, print
the response. Idle exit after 300 s; the next call re-spawns. Falls
back transparently to the direct path on any daemon connect failure.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

# Make sibling modules importable when invoked as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ui_snapshot  # noqa: E402

IDLE_EXIT_SEC = 300
DEBOUNCE_MS = 200
MAX_REQUEST_BYTES = 256 * 1024


def socket_path(serial: str | None) -> Path:
    return Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-daemon.{serial or 'default'}.sock"


def pidfile_path(serial: str | None) -> Path:
    return Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-daemon.{serial or 'default'}.pid"


# ---------------------------------------------------------------------------
# Daemon state
# ---------------------------------------------------------------------------

class Daemon:
    def __init__(self, serial: str | None) -> None:
        self.serial = serial
        self._u2_handle: Any = None
        self._u2_lock = threading.Lock()

        self._mutation_gen = 0
        self._gen_lock = threading.Lock()
        # Fix 3: cached (sig, rotation, mutation_gen). None ⇒ recompute.
        self._sig_cache: tuple[str, int, int] | None = None
        # Fix 7 (snapshot cache): mutation_gen at the time the on-disk
        # XML cache file was last written. -1 ⇒ no cache known. Used by
        # _op_snapshot to skip the live `uiautomator dump` round-trip
        # when nothing has mutated since the last refresh.
        self._xml_cache_gen: int = -1
        # Fix 9 (tap_macro sleep portability): toybox `sleep` accepts
        # decimal seconds on AOSP API 26+. Probe once via `getprop` and
        # cache the answer. None = not yet probed.
        self._sleep_decimal_supported: bool | None = None
        # Fix 10 (wedge detector): timestamps of recent transport-layer
        # u2 failures. 3 inside a 30s window ⇒ emit a breadcrumb so the
        # operator sees the daemon is fighting the connection. Locked
        # separately from `_u2_lock` because the wedge check fires
        # inside `_u2_call_with_retry`'s exception path while
        # `_u2_lock` is already held.
        self._wedge_failures: list[float] = []
        self._wedge_lock = threading.Lock()
        # Fix 11 (op journal): append per-request {ts, op, rc, ms, gen}
        # to JSONL on every handle() call. Forensic + benchmarking
        # primitive — `tail journal | jq` answers "why did step N
        # fail" and `bench.sh` consumes it for p50/p95 stats. Lock
        # serialises file appends across the daemon's worker threads.
        self._journal_lock = threading.Lock()
        # Fix 16 (BG trace): when active, every `_bump_mutation()` spawns
        # a screencap worker on a separate thread that uses the adb path
        # (no u2 lock contention) so the capture runs CONCURRENTLY with
        # whatever op fires next. Batch wall-clock no longer pays per-
        # mutation trace overhead. Frames named `<gen>-<op>.<ext>`.
        self._trace_dir: Path | None = None
        self._trace_format: str = "jpeg"  # png|jpeg; jpeg via post-conversion
        self._trace_jpeg_quality: int = 85
        self._trace_lock = threading.Lock()
        self._trace_executor: Any = None  # lazy ThreadPoolExecutor
        # Fix 12 (BG-refresh-aware snapshot): wall-clock of the last
        # `_bump_mutation()`. Read by `_op_snapshot` to decide whether
        # to wait briefly for the BG refresh worker to land before
        # firing a live dump. Negative sentinel means "no mutation
        # ever" — first snapshot of a fresh daemon takes the live
        # path immediately.
        self._last_mutation_at: float = -1.0
        self._refresh_event = threading.Event()
        self._stop = threading.Event()

        self._last_request = time.monotonic()
        # Fix 5: adaptive idle. Track inter-arrival EMA so frequent
        # callers keep their daemon longer than 5 minutes.
        self._inter_arrival_ema_sec: float = 60.0

        self._refresh_thread = threading.Thread(
            target=self._refresh_worker, name="bg-refresh", daemon=True
        )
        self._refresh_thread.start()

    # --- u2 connection management ------------------------------------------

    def _u2_dev(self):
        """Return the warm u2.Device handle, reconnecting once on stale."""
        with self._u2_lock:
            if self._u2_handle is not None:
                return self._u2_handle
            import uiautomator2 as u2  # type: ignore
            self._u2_handle = u2.connect(self.serial) if self.serial else u2.connect()
            return self._u2_handle

    def _drop_u2(self) -> None:
        with self._u2_lock:
            self._u2_handle = None
            # Fix 4: also drop the shared handle so ui_snapshot reconnects.
            ui_snapshot.set_u2_device_handle(self.serial, None)

    # --- BG trace capture --------------------------------------------------

    def _trace_pool(self) -> Any:
        """Lazily-created bounded executor for BG screencap frames.
        Max 2 workers so unmanaged mutation bursts cannot spawn unbounded
        captures. Daemon-thread workers die with the process — no
        explicit shutdown required. Lock-guarded init prevents two
        concurrent first-mutations from racing the allocation."""
        if getattr(self, "_trace_executor", None) is not None:
            return self._trace_executor
        with self._trace_lock:
            if getattr(self, "_trace_executor", None) is None:
                from concurrent.futures import ThreadPoolExecutor
                self._trace_executor = ThreadPoolExecutor(
                    max_workers=2, thread_name_prefix="bg-trace"
                )
            return self._trace_executor

    def _capture_trace_frame(self, gen: int, op_label: str) -> None:
        """Submit a screencap capture to the BG pool. Filename is
        `<gen>-<op>.<ext>` so directory listing reads chronologically.
        Capture uses the adb exec-out path so it does NOT contend with
        the u2 lock the next op is about to acquire.

        Also appends a JSONL entry to `<trace_dir>/trace.jsonl` so the
        human can reconstruct the op-sequence with `jq` without
        correlating filenames manually."""
        with self._trace_lock:
            tdir = self._trace_dir
            tfmt = self._trace_format
            tquality = getattr(self, "_trace_jpeg_quality", 85)
        if tdir is None:
            return
        safe_label = "".join(c if c.isalnum() or c in "-_." else "_" for c in op_label)[:40] or "op"
        ext = "jpg" if tfmt == "jpeg" else "png"
        frame_name = f"{gen:04d}-{safe_label}.{ext}"
        path = tdir / frame_name

        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
            entry = json.dumps({
                "ts": ts, "gen": gen, "op": op_label, "frame": frame_name,
            }, ensure_ascii=False)
            with open(tdir / "trace.jsonl", "a", encoding="utf-8") as fp:
                fp.write(entry + "\n")
        except Exception:
            pass

        def _do_capture() -> None:
            cmd = [ui_snapshot.adb_bin()]
            if self.serial:
                cmd += ["-s", self.serial]
            cmd += ["exec-out", "screencap", "-p"]
            try:
                if tfmt == "png":
                    with open(path, "wb") as fp:
                        subprocess.run(cmd, stdout=fp, timeout=10, check=False)
                    return
                r = subprocess.run(cmd, capture_output=True, timeout=10, check=False)
                if r.returncode != 0 or not r.stdout:
                    return
                try:
                    from PIL import Image  # type: ignore
                    import io
                    img = Image.open(io.BytesIO(r.stdout))
                    img.save(path, "JPEG", quality=tquality)
                except Exception:
                    with open(path, "wb") as fp:
                        fp.write(r.stdout)
            except Exception:
                pass

        try:
            self._trace_pool().submit(_do_capture)
        except Exception:
            pass

    # --- mutation generation + BG refresh ----------------------------------

    def _bump_mutation(self, op_label: str = "mut") -> int:
        with self._gen_lock:
            self._mutation_gen += 1
            # Fix 3: invalidate cached window-sig on every mutation —
            # the on-device window state may now differ.
            self._sig_cache = None
            self._refresh_event.set()
            # Fix 12: track wall-clock of last mutation so _op_snapshot
            # can decide whether to wait briefly for the BG refresh
            # to land instead of firing a redundant live dump. Only
            # meaningful right after the bump — stale value beyond
            # the BG refresh window is harmless (snapshot just live-
            # dumps as before).
            self._last_mutation_at = time.monotonic()
            cur_gen = self._mutation_gen
        # BG trace capture outside _gen_lock — uses its own _trace_lock.
        if getattr(self, "_trace_dir", None) is not None:
            self._capture_trace_frame(cur_gen, op_label)
        return cur_gen

    def _acquire_xml(self, force_dump: bool = False) -> tuple[bytes, bool]:
        """Read the current accessibility-tree XML — cache-aware.

        Returns `(xml_bytes, cache_hit)`. Used by `_op_snapshot`,
        `_op_describe`, and `_op_resolve_tap_sequence` so the cache hit
        policy lives in one place. On miss (or `force_dump=True`),
        runs a live `uiautomator dump` and updates the cache via
        `_write_xml_cache`. Raises on dump failure.
        """
        cache_path = ui_snapshot.meta_path(self.serial).with_suffix(".xml")
        if not force_dump:
            with self._gen_lock:
                gen_match = (
                    self._xml_cache_gen == self._mutation_gen
                    and self._xml_cache_gen >= 0
                )
            if gen_match and cache_path.exists():
                try:
                    return cache_path.read_bytes(), True
                except Exception:
                    pass  # fall through to live dump
        xml, sz = ui_snapshot.run_adb_dump(self.serial, compressed=True, backend="u2")
        ui_snapshot.set_screen_size(self.serial, sz)
        self._write_xml_cache(xml)
        return xml, False

    def _write_xml_cache(self, xml: bytes, gen: int | None = None) -> None:
        """Write `xml` to the canonical cache path and mark `_xml_cache_gen`.

        `gen` defaults to current `_mutation_gen` (call site has just
        produced a dump that reflects post-mutation state). Pass an
        explicit gen when the dump was started under a known earlier
        gen — see `_refresh_worker`.

        Atomicity: the eligibility check, file `os.replace`, and marker
        update happen under `_gen_lock`. Without that, two concurrent
        BG dumps can race — the slower one (older gen) finishing last
        clobbers the newer file and the marker is left advertising
        fresh content that is actually stale, so the next snapshot
        cache_hit returns garbage. Codex review HIGH 1.
        """
        cache = ui_snapshot.meta_path(self.serial).with_suffix(".xml")
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".xml.tmp")
        try:
            tmp.write_bytes(xml)
        except Exception:
            try:
                tmp.unlink(missing_ok=True)  # type: ignore[call-arg]
            except Exception:
                pass
            return
        with self._gen_lock:
            target = gen if gen is not None else self._mutation_gen
            if target < self._xml_cache_gen:
                # An equal-or-newer dump already landed; discard ours
                # so we don't regress the on-disk file.
                try:
                    tmp.unlink(missing_ok=True)  # type: ignore[call-arg]
                except Exception:
                    pass
                return
            try:
                os.replace(tmp, cache)
            except Exception:
                try:
                    tmp.unlink(missing_ok=True)  # type: ignore[call-arg]
                except Exception:
                    pass
                return
            self._xml_cache_gen = target

    def _refresh_worker(self) -> None:
        """Single worker. Debounces mutations; refreshes XML cache; never sidecar."""
        while not self._stop.is_set():
            triggered = self._refresh_event.wait(timeout=1.0)
            if self._stop.is_set():
                return
            if not triggered:
                continue
            # Debounce: wait DEBOUNCE_MS after the last trigger we saw.
            time.sleep(DEBOUNCE_MS / 1000.0)
            # Coalesce any further triggers that arrived during debounce.
            self._refresh_event.clear()

            with self._gen_lock:
                start_gen = self._mutation_gen

            try:
                xml, sz = ui_snapshot.run_adb_dump(self.serial, compressed=True, backend="u2")
                ui_snapshot.set_screen_size(self.serial, sz)
            except Exception as e:
                sys.stderr.write(f"daemon: BG refresh failed: {e}\n")
                continue

            # Discard if a newer mutation happened during the dump.
            with self._gen_lock:
                end_gen = self._mutation_gen
            if start_gen != end_gen:
                continue

            # Helper marks _xml_cache_gen monotonically — racing back-fill
            # with a stale dump cannot regress the marker.
            self._write_xml_cache(xml, gen=start_gen)

    # --- request dispatch --------------------------------------------------

    def handle(self, req: dict) -> dict:
        op = req.get("op")
        args = req.get("args") or {}
        # Fix 5: update inter-arrival EMA before bumping last_request.
        now = time.monotonic()
        gap = max(0.0, now - self._last_request)
        # 0.3 weight on the new sample — responsive but not jittery.
        self._inter_arrival_ema_sec = 0.7 * self._inter_arrival_ema_sec + 0.3 * gap
        self._last_request = now

        # Fix 11: every handle() request is journaled. Wraps dispatch
        # with wall-clock timing so `bench.sh` can compute per-op
        # p50/p95 from a single emulator session. Errors during the
        # dispatch still produce a journal entry (rc=70 + exc_class).
        start = time.monotonic()
        try:
            resp = self._dispatch(op, args)
        except Exception:
            resp = {
                "rc": 70, "out": "",
                "err": "daemon: handler exception:\n" + traceback.format_exc(),
            }
        ms = int((time.monotonic() - start) * 1000)
        self._write_journal(op, args, resp, ms)
        return resp

    def _dispatch(self, op: str | None, args: dict) -> dict:
        """Inner dispatch table. Separated from `handle()` so the
        journal wrapper can wrap a single try/except without changing
        each op's individual error handling."""
        try:
            if op == "health":
                return self._op_health()
            if op == "quit":
                self._stop.set()
                return {"rc": 0, "out": "bye", "err": ""}
            if op == "tap":
                return self._op_tap(args)
            if op == "tap_point":
                return self._op_tap_point(args)
            if op == "tap_macro":
                return self._op_tap_macro(args)
            if op == "resolve_then_tap_sequence":
                return self._op_resolve_tap_sequence(args)
            if op == "describe":
                return self._op_describe(args)
            if op == "swipe":
                return self._op_swipe(args)
            if op == "long_press":
                return self._op_long_press(args)
            if op == "sleep":
                return self._op_sleep(args)
            if op == "type":
                return self._op_type(args)
            if op == "key":
                return self._op_key(args)
            if op == "snapshot":
                return self._op_snapshot(args)
            if op == "batch":
                return self._op_batch(args)
            if op == "window_sig":
                return self._op_window_sig(args)
            if op == "screencap":
                return self._op_screencap(args)
            if op == "trace_start":
                return self._op_trace_start(args)
            if op == "trace_stop":
                return self._op_trace_stop(args)
            if op == "dismiss_ime":
                return self._op_dismiss_ime(args)
            return {"rc": 64, "out": "", "err": f"daemon: unknown op {op!r}\n"}
        except Exception:
            return {
                "rc": 70,
                "out": "",
                "err": "daemon: handler exception:\n" + traceback.format_exc(),
            }

    def _journal_path(self) -> Path:
        """JSONL path. One per serial so multi-device fleets don't
        interleave entries."""
        base = Path(os.environ.get("TMPDIR", "/tmp"))
        return base / f"android-skill-journal.{self.serial or 'default'}.jsonl"

    @staticmethod
    def _summarise_args(op: str | None, args: dict) -> dict:
        """Strip args to the fields useful for forensics + benchmarking
        without bloating the log. Drop verbose payloads (image bytes,
        long text strings) and compress arrays to lengths."""
        if not args:
            return {}
        out: dict = {}
        for k, v in args.items():
            if k in ("target", "code", "path", "backend", "format", "miss_policy"):
                out[k] = v
            elif k in ("ms", "x", "y", "x1", "y1", "x2", "y2",
                       "delay_ms", "duration_ms", "post_wait_ms",
                       "wait_stable_ms", "timeout_ms", "pre_macro_sleep_ms",
                       "quality", "max_lines"):
                out[k] = v
            elif k == "text":
                # Length only — text may contain secrets / large payloads.
                out["text_len"] = len(v) if isinstance(v, str) else None
            elif k == "wait_for":
                if isinstance(v, list):
                    n = len(v)
                    out["wait_for"] = v if n <= 3 else f"{n} clauses"
                else:
                    out["wait_for"] = v
            elif k == "taps" and isinstance(v, list):
                out["taps_n"] = len(v)
            elif k == "selectors" and isinstance(v, list):
                out["selectors_n"] = len(v)
            elif k == "ops" and isinstance(v, list):
                out["sub_ops"] = [(s.get("op") if isinstance(s, dict) else None) for s in v[:20]]
                if len(v) > 20:
                    out["sub_ops_truncated"] = True
            # else: drop silently
        return out

    def _write_journal(self, op: str | None, args: dict, resp: dict, ms: int) -> None:
        """Append one JSONL entry. Best-effort — write failures don't
        break the response. Uses a flock-free lock since only this
        daemon writes (one process per serial), and a thread lock
        suffices to prevent torn lines from concurrent worker threads.
        """
        try:
            entry = {
                "ts": time.time(),
                "op": op,
                "rc": int(resp.get("rc", 0)),
                "ms": ms,
                "gen": self._mutation_gen,
                "args": self._summarise_args(op, args),
            }
            err = resp.get("err")
            if err:
                # Trim — full traceback bloats the log; first line carries
                # the typed reason ("daemon: tap target not found: ...").
                first_line = err.splitlines()[0] if err else ""
                entry["err1"] = first_line[:200]
            line = json.dumps(entry, ensure_ascii=False) + "\n"
            path = self._journal_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with self._journal_lock:
                with open(path, "a", encoding="utf-8") as fp:
                    fp.write(line)
        except Exception:
            # Journal failures are intentionally silent. We do NOT want
            # a full disk or perms error to break in-flight UI driving.
            pass

    def _op_health(self) -> dict:
        return {
            "rc": 0,
            "out": json.dumps({
                "serial": self.serial,
                "u2_warm": self._u2_handle is not None,
                "mutation_gen": self._mutation_gen,
                "idle_sec": int(time.monotonic() - self._last_request),
            }),
            "err": "",
        }

    # --- u2 selector helpers (mirror ui_act._selector_to_u2_kwargs) --------

    @staticmethod
    def _to_kwargs(selectors: list[str]) -> dict | None:
        # Imported lazily so daemon doesn't depend on ui_act at module load.
        import ui_act  # noqa: WPS433
        return ui_act._selector_to_u2_kwargs(selectors)

    @staticmethod
    def _split_selectors(target: str) -> list[str]:
        return [s.strip() for s in target.split(",") if s.strip()]

    def _u2_call_with_retry(self, fn):
        """Invoke fn(d) once with one reconnect on RemoteDisconnected.

        u2.Device wraps a single jsonrpc HTTP session; concurrent calls
        from different request-serving threads are not guaranteed safe.
        Serialise through `_u2_lock` so two `tap` requests don't interleave
        on the same TCP socket. Per-call cost: u2 ops are 200-400 ms each,
        so the serialisation tax is negligible vs the safety guarantee.

        Lock ordering invariant (deadlock guard): inside this method we
        always acquire `_u2_lock` first, then optionally `_wedge_lock`
        (success: clear failures; double-fail: record). Nothing else in
        the daemon takes `_wedge_lock` then tries to take `_u2_lock`,
        so the partial order u2_lock → wedge_lock holds globally. If
        you add a new caller of `_record_wedge_failure` or any code
        that touches `_wedge_failures`, keep this ordering.

        Lock ordering invariant (deadlock guard): inside this method we
        always acquire `_u2_lock` first, then optionally `_wedge_lock`
        (success: clear failures; double-fail: record). Nothing else in
        the daemon takes `_wedge_lock` then tries to take `_u2_lock`,
        so the partial order u2_lock → wedge_lock holds globally. If
        you add a new caller of `_record_wedge_failure` or any code
        that touches `_wedge_failures`, keep this ordering.

        Wedge detection (Fix 10): every transport-layer failure is
        recorded in a 30-second sliding window. When ≥3 failures
        accumulate, we emit a single visible breadcrumb and clear the
        window so the message doesn't spam every subsequent failure.
        The handle drop already happens via the existing reset on the
        same code path — we're just escalating visibility so an
        operator running a long session sees `daemon: wedge detected`
        in stderr instead of silently spending minutes on a stuck
        atx-agent. A successful call clears the window — flaky-but-
        recovering connections don't trip the alarm.
        """
        with self._u2_lock:
            for attempt in (0, 1):
                try:
                    result = fn(self._u2_dev_unlocked())
                    # Successful call clears the failure window. We
                    # only count "couldn't recover within this retry"
                    # as a wedge symptom; transient blips followed by
                    # success are normal on USB.
                    with self._wedge_lock:
                        if self._wedge_failures:
                            self._wedge_failures.clear()
                    return result
                except Exception as e:
                    msg = str(e)
                    if "RemoteDisconnected" in msg or "Connection refused" in msg or "Broken pipe" in msg:
                        self._u2_handle = None
                        # Fix 4: also drop shared handle so ui_snapshot
                        # doesn't reuse a dead TCP session.
                        ui_snapshot.set_u2_device_handle(self.serial, None)
                        # Wedge bookkeeping — only counts when BOTH
                        # attempts in this retry loop fail (recorded
                        # below after the loop, not here). On attempt
                        # 0 we just reconnect; the next iteration may
                        # succeed and clear the window.
                        continue
                    raise
            # Both attempts failed transient — record one wedge sample
            # (this whole call counted as one failure, not two) and
            # re-raise so the caller sees the original exception type.
            self._record_wedge_failure()
            return fn(self._u2_dev_unlocked())

    def _foreground_activity_brief(self) -> str:
        """Cheap one-shot read of the current top activity. Used to tag
        error breadcrumbs so the LLM knows which screen produced the
        failure without re-snapshotting. Best-effort; returns empty
        string on error."""
        try:
            cmd = [ui_snapshot.adb_bin()]
            if self.serial:
                cmd += ["-s", self.serial]
            cmd += ["shell", "dumpsys", "activity", "activities"]
            r = subprocess.run(cmd, capture_output=True, timeout=2)
            text = r.stdout.decode("utf-8", errors="replace")
            for line in text.splitlines():
                if "topResumedActivity=" in line or "ResumedActivity:" in line:
                    return line.strip()[:160]
        except Exception:
            pass
        return ""

    _TASK_ID_RE = re.compile(r"\bt(\d+)\b")

    def _activity_task_id(self) -> str:
        """Extract the `tN` task identifier from the top resumed
        activity. Used by `_op_batch` to detect mid-flow activity
        recreation (a different `tN` after a mutating op means the
        original task was destroyed and a new one took its place —
        the wizard state from earlier ops is gone). Returns "" on
        any failure so the stability gate fails-open."""
        line = self._foreground_activity_brief()
        if not line:
            return ""
        m = self._TASK_ID_RE.search(line)
        return m.group(1) if m else ""

    def _hint(self, kind: str, **ctx: Any) -> str:
        """Build a hint line that tells the LLM what to try next. Hints
        are emitted on every recoverable failure so the model can
        self-correct within a session: change selector, add
        `wait_for_any`, run `describe` first, etc.

        `kind` keys (extend as new error sites need hints):
          tap_not_found      — sel.exists/click failed for a selector
          wait_for_timeout   — AND wait_for hit timeout_ms
          wait_for_any_timeout — OR wait_for_any hit timeout_ms
          wait_stable_timeout  — wait_stable_ms hit timeout_ms
          resolve_miss       — resolve_then_tap_sequence selector miss
          shell_input_rc     — adb shell input returned non-zero
        """
        fg = self._foreground_activity_brief()
        fg_line = f"hint: foreground={fg}\n" if fg else ""
        if kind == "tap_not_found":
            return (
                fg_line
                + "hint: target not present on the current screen. Run a "
                + "`describe` op with the same selector to verify resolution. "
                + "If the post-state branches, use `wait_for_any` to wait "
                + "for either branch. If the selector resolves intermittently "
                + "(animation), add `wait_stable_ms` or a `sleep` before "
                + "this op.\n"
            )
        if kind == "wait_for_timeout":
            wf = ctx.get("wait_for") or []
            if len(wf) >= 2:
                return (
                    fg_line
                    + "hint: `wait_for` is AND-on-one-node — listing N clauses "
                    + "means find ONE node that satisfies ALL of them. For "
                    + "'either A OR B appeared', use `wait_for_any: [...]` "
                    + f"instead. Current clauses: {wf}.\n"
                )
            # single-clause timeout: different cure surface
            sel = wf[0] if wf else "(none)"
            return (
                fg_line
                + f"hint: `wait_for {sel!r}` timed out — the screen is not "
                + "what you expected. Try in order: (1) `describe` on the "
                + "selector you EXPECT plus a couple of alternatives — the "
                + "miss response includes `nearby[]` listing what IS on "
                + "screen. (2) Check the `foreground` line above — different "
                + "activity → wake / dismiss / launch first. (3) Extend "
                + "`timeout_ms` if the transition is genuinely slow.\n"
            )
        if kind == "wait_for_any_timeout":
            return (
                fg_line
                + "hint: none of the alternative selectors appeared within "
                + "the timeout. The screen may have settled on a third "
                + "state — re-check with a `describe` op, or extend "
                + "`timeout_ms`.\n"
            )
        if kind == "wait_stable_timeout":
            return (
                fg_line
                + "hint: the screen never settled (two consecutive equal "
                + "dumps within `wait_stable_ms` window) — animation in "
                + "flight, or a periodic clock tick is forcing changes. "
                + "Try `wait_for` on a specific anchor selector instead.\n"
            )
        if kind == "resolve_miss":
            sel = ctx.get("selector")
            return (
                fg_line
                + f"hint: selector {sel!r} did not match in the pre-macro "
                + "dump. Either the screen isn't what you expected (run "
                + "`describe` first to verify), the layout differs from "
                + "your assumption (mode-toggling keypads break "
                + "`assume_stable_coords` — split into per-mode batches), "
                + "or pass `miss_policy:'skip'` if intermittent.\n"
            )
        if kind == "shell_input_rc":
            return (
                fg_line
                + "hint: the device's `input` shell command returned "
                + "non-zero. Common causes: device locked, device offline, "
                + "input subsystem busy. Check `adb devices` and try one "
                + "more time after a short sleep.\n"
            )
        return fg_line

    def _record_wedge_failure(self) -> None:
        """Append now() to the wedge-failure window, prune old entries,
        emit a one-shot breadcrumb when the threshold trips. Cheap;
        runs only on the unhappy path."""
        now = time.monotonic()
        with self._wedge_lock:
            self._wedge_failures.append(now)
            self._wedge_failures = [t for t in self._wedge_failures if now - t < 30.0]
            if len(self._wedge_failures) >= 3:
                self._wedge_failures.clear()
                sys.stderr.write(
                    "daemon: wedge detected (3 transport failures in 30s); "
                    "u2 handle dropped for fresh reconnect on next call\n"
                )

    def _u2_dev_unlocked(self):
        """Lazy-init u2 handle WITHOUT taking the lock. Caller must hold it.

        Fix 4: after first connect, share this handle with `ui_snapshot`
        so its BG-refresh dumps reuse the same TCP session instead of
        opening a second one. The lock is shared too so daemon ops and
        BG dumps can't interleave.
        """
        if self._u2_handle is not None:
            return self._u2_handle
        import uiautomator2 as u2  # type: ignore
        self._u2_handle = u2.connect(self.serial) if self.serial else u2.connect()
        ui_snapshot.set_u2_device_handle(self.serial, self._u2_handle, self._u2_lock)
        return self._u2_handle

    # --- tap / type / key --------------------------------------------------

    # --- post-action wait, daemon-side ------------------------------------

    def _wait_for_via_u2(self, wait_for: list[str], deadline: float) -> bool | None:
        """Try to satisfy `wait_for` using u2's native `wait()`/`wait_gone()`.

        Returns:
          True   — all clauses satisfied within remaining deadline.
          False  — timeout.
          None   — selector not u2-mappable; caller falls back to dump-poll.

        Semantics match the dump-poll path:
          * Positive clauses are AND-joined onto a SINGLE node — must all
            hold simultaneously on the same matched element. Combined
            into one u2 kwargs dict via `_to_kwargs(pos_selectors)`.
          * Negation clauses (`!sel`) are checked one-by-one via
            `wait_gone()`; "gone" semantics don't aggregate onto a single
            node, so the per-clause split is safe.
          * If `_to_kwargs` rejects the combined positives (multiple
            clauses mapping to the same u2 keyword, or any unmappable
            clause), return None and let dump-poll handle it.
        """
        pos_selectors: list[str] = []
        neg_selectors: list[str] = []
        for raw in wait_for:
            clause = raw.strip()
            if clause.startswith("!"):
                neg_selectors.append(clause[1:].lstrip())
            else:
                pos_selectors.append(clause)

        pos_kwargs: dict | None = None
        if pos_selectors:
            pos_kwargs = self._to_kwargs(pos_selectors)
            if pos_kwargs is None:
                return None
            # _to_kwargs builds a flat dict; if two clauses produce the
            # same u2 keyword (e.g. two `text="..."`) the dict silently
            # collapses to the last value. Detect that collision so we
            # fall back to dump-poll instead of waiting on a degraded sel.
            seen_keys: set[str] = set()
            for raw in pos_selectors:
                clause_kw = self._to_kwargs([raw])
                if clause_kw is None:
                    return None
                for k in clause_kw:
                    if k in seen_keys:
                        return None
                    seen_keys.add(k)

        neg_kwargs_list: list[dict] = []
        for n in neg_selectors:
            kw = self._to_kwargs([n])
            if kw is None:
                return None
            neg_kwargs_list.append(kw)

        # Positive AND: single u2 selector, single wait() — guarantees all
        # positive clauses hold on ONE matched node, matching dump-poll.
        if pos_kwargs is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False

            def _do_pos(d, kwargs=pos_kwargs, remaining=remaining):
                return bool(d(**kwargs).wait(timeout=remaining))

            try:
                ok = self._u2_call_with_retry(_do_pos)
            except Exception:
                return None
            if not ok:
                return False

        # Negation clauses can be checked in any order; "gone" doesn't
        # need to collapse onto one node.
        for kw in neg_kwargs_list:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False

            def _do_neg(d, kwargs=kw, remaining=remaining):
                return bool(d(**kwargs).wait_gone(timeout=remaining))

            try:
                ok = self._u2_call_with_retry(_do_neg)
            except Exception:
                return None
            if not ok:
                return False
        return True

    def _post_sync_in_daemon(
        self,
        post_wait_ms: int,
        wait_for: list[str] | None,
        wait_stable_ms: int,
        timeout_ms: int,
        fail_on_timeout: bool,
        wait_for_any: list[str] | None = None,
    ) -> tuple[bool, str]:
        """Run the post-action sync IN the daemon so the client doesn't
        re-enter its dump loop. Returns (ok, stderr_breadcrumb).

        Strategy:
          1. fixed `post_wait_ms` sleep (rare; last resort).
          2. `wait_for` — AND across clauses on a SINGLE node. Try u2
             native `wait()`/`wait_gone()` first (one on-device RTT per
             clause). Fall back to dump-poll when u2 can't express a
             clause.
          3. `wait_for_any` — OR across clauses (first selector that
             matches ANY node wins). Useful for "settled on screen X
             OR screen Y" branches. Always uses dump-poll — u2's wait
             is single-selector AND-only.
          4. `wait_stable_ms` — re-dump until two dumps N ms apart match.

        On timeout: returns (False, breadcrumb). Caller decides rc.
        """
        if post_wait_ms:
            time.sleep(post_wait_ms / 1000.0)
        if not wait_for and not wait_for_any and wait_stable_ms <= 0:
            return True, ""

        deadline = time.monotonic() + (timeout_ms / 1000.0)

        def _dump() -> bytes:
            xml, sz = ui_snapshot.run_adb_dump(self.serial, compressed=True, backend="u2")
            ui_snapshot.set_screen_size(self.serial, sz)
            return xml

        if wait_for_any:
            # OR semantics: dump-poll until any clause matches any node.
            # No u2 native fast path here (u2's selector is AND-only on
            # one node); the cost is still bounded by `timeout_ms`.
            while True:
                try:
                    xml = _dump()
                    root = ui_snapshot.build_tree(xml)
                    screen = ui_snapshot.get_screen_size(self.serial)
                    pruned = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
                    for sel in wait_for_any:
                        # Each selector may itself carry comma-AND clauses.
                        clauses = [c.strip() for c in sel.split(",") if c.strip()]
                        if any(ui_snapshot.selector_match(n, clauses) for n in pruned):
                            self._write_xml_cache(xml)
                            return True, ""
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    msg = (
                        f"daemon: --wait-for-any {wait_for_any} timed out after {timeout_ms}ms\n"
                        + self._hint("wait_for_any_timeout")
                    )
                    return (not fail_on_timeout), msg
                time.sleep(0.15)

        if wait_for:
            # Fast path: u2 native wait. Skips the dump-and-prune loop.
            u2_result = self._wait_for_via_u2(wait_for, deadline)
            if u2_result is True:
                # Refresh the XML cache so subsequent uses see the settled
                # post-wait state. One dump, not N.
                try:
                    xml = _dump()
                    self._write_xml_cache(xml)
                except Exception:
                    pass
                return True, ""
            if u2_result is False:
                msg = (
                    f"daemon: --wait-for {wait_for} timed out after {timeout_ms}ms\n"
                    + self._hint("wait_for_timeout", wait_for=wait_for)
                )
                return (not fail_on_timeout), msg
            # u2_result is None — selector not u2-mappable; dump-poll fallback.
            pos_selectors = [s for s in wait_for if not s.startswith("!")]
            neg_clauses = [s[1:].lstrip() for s in wait_for if s.startswith("!")]
            while True:
                try:
                    xml = _dump()
                    root = ui_snapshot.build_tree(xml)
                    screen = ui_snapshot.get_screen_size(self.serial)
                    pruned = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
                    pos_ok = (not pos_selectors) or any(
                        ui_snapshot.selector_match(n, pos_selectors) for n in pruned
                    )
                    neg_ok = all(
                        not any(ui_snapshot._match_clause(n, c) for n in pruned)
                        for c in neg_clauses
                    )
                    if pos_ok and neg_ok:
                        self._write_xml_cache(xml)
                        return True, ""
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    msg = (
                        f"daemon: --wait-for {wait_for} timed out after {timeout_ms}ms\n"
                        + self._hint("wait_for_timeout", wait_for=wait_for)
                    )
                    return (not fail_on_timeout), msg
                time.sleep(0.15)

        # wait-stable path
        prev: bytes | None = None
        prev_at = 0.0
        while True:
            try:
                xml = _dump()
                now = time.monotonic()
                if prev is not None and xml == prev and (now - prev_at) * 1000.0 >= wait_stable_ms:
                    self._write_xml_cache(xml)
                    return True, ""
                prev = xml
                prev_at = now
            except Exception:
                pass
            if time.monotonic() >= deadline:
                msg = (
                    f"daemon: --wait-stable-ms {wait_stable_ms} timed out after {timeout_ms}ms\n"
                    + self._hint("wait_stable_timeout")
                )
                return (not fail_on_timeout), msg
            time.sleep(0.10)

    @staticmethod
    def _post_sync_args(args: dict) -> tuple[int, list[str] | None, int, int, bool]:
        post_wait_ms = int(args.get("post_wait_ms", 0) or 0)
        wait_for = args.get("wait_for") or None
        if wait_for is not None and not isinstance(wait_for, list):
            wait_for = [wait_for]
        wait_stable_ms = int(args.get("wait_stable_ms", 0) or 0)
        timeout_ms = int(args.get("timeout_ms", 5000) or 5000)
        fail_on_timeout = bool(args.get("fail_on_timeout", False))
        return post_wait_ms, wait_for, wait_stable_ms, timeout_ms, fail_on_timeout

    # --- ops ---------------------------------------------------------------

    def _op_tap(self, args: dict) -> dict:
        target = args.get("target")
        timeout = float(args.get("timeout", 5.0))
        if not target:
            return {"rc": 64, "out": "", "err": "daemon: tap missing 'target'\n"}
        selectors = self._split_selectors(target)
        kwargs = self._to_kwargs(selectors)
        if kwargs is None:
            return {"rc": 65, "out": "", "err": f"daemon: selector not u2-mappable: {target!r}\n"}

        # Fix 8: when batch context proves the selector resolves NOW
        # (prior op's `wait_for` matched this exact target and returned
        # True), skip the `sel.exists(timeout=N)` pre-check. Saves one
        # jsonrpc round-trip (~50-100 ms over USB) per tap. Only set by
        # _op_batch — never by external callers.
        already_proven = bool(args.get("_already_proven", False))

        # Clickable-ancestor resolution — ADAPTIVE.
        #
        # u2's default selector match returns the FIRST tree-order
        # match. On Compose UIs, the same `text=` often appears on the
        # screen TITLE (not clickable) AND inside a clickable row — u2
        # picks the title, the tap fires on a no-op, and downstream
        # `wait_for` times out 5 seconds later.
        #
        # Earlier fix: always dump the tree + find_target + walk to
        # clickable ancestor. Cost: ~50-100 ms tree dump on EVERY tap,
        # even when u2's pick is already clickable (the common case on
        # flat UIs). For a 20-op batch that's ~1-2 s wasted.
        #
        # Adaptive version: skip the tree path when the selector
        # explicitly constrains clickability (`,clickable=true`) OR
        # when the selector is `id=` / `class=*Button*` etc. that
        # rarely collides with a non-interactive sibling. Always do
        # the tree path for `text=` and `desc=` since those are the
        # selectors that hit the title-vs-row ambiguity.
        #
        # Skipped also for `uX` uids (no ambiguity by design).
        tap_coord: tuple[int, int] | None = None
        ambiguity_prone = any(
            s.startswith("text=") or s.startswith("text~") or
            s.startswith("desc=") or s.startswith("desc~")
            for s in selectors
        )
        clickability_constrained = any(
            s == "clickable=true" or s == "clickable=True" for s in selectors
        )
        if (ambiguity_prone and not clickability_constrained
                and not (target.startswith("u") and target[1:].isdigit())):
            try:
                xml, _ = self._acquire_xml()
                root = ui_snapshot.build_tree(xml)
                screen = ui_snapshot.get_screen_size(self.serial)
                nodes = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
                for i, n in enumerate(nodes, 1):
                    n.uid = f"u{i}"
                import ui_act as _ui_act
                match = _ui_act.find_target(nodes, target)
                if match is not None:
                    # Walk to nearest clickable ancestor if the match itself isn't clickable.
                    bounds_node = match
                    if not match.clickable:
                        cur = getattr(match, "parent", None)
                        while cur is not None:
                            if getattr(cur, "clickable", False) and getattr(cur, "bounds", None) is not None:
                                bounds_node = cur
                                break
                            cur = getattr(cur, "parent", None)
                    if bounds_node.bounds is not None:
                        x1, y1, x2, y2 = bounds_node.bounds
                        tap_coord = ((x1 + x2) // 2, (y1 + y2) // 2)
            except Exception:
                tap_coord = None  # fall back to u2 selector path

        def go(d):
            if tap_coord is not None:
                # Tree-resolved coordinate path. u2's `click(x, y)` is a
                # raw input event — same semantics as `adb shell input
                # tap` but stays on the warm u2 connection. Skips the
                # selector-match ambiguity entirely.
                d.click(tap_coord[0], tap_coord[1])
                return ("ok", None)
            sel = d(**kwargs)
            if not already_proven:
                if not sel.exists(timeout=timeout):
                    return ("notfound", None)
            sel.click()
            return ("ok", None)

        status, _ = self._u2_call_with_retry(go)
        if status != "ok":
            return {
                "rc": 1, "out": "",
                "err": f"daemon: tap target not found: {target!r}\n"
                       + self._hint("tap_not_found"),
            }
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation("tap")

        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        if already_proven and not breadcrumb:
            breadcrumb = "daemon: tap skipped exists() (proven by prior wait_for)\n"
        elif already_proven:
            breadcrumb = "daemon: tap skipped exists() (proven by prior wait_for)\n" + breadcrumb
        return {
            "rc": rc, "out": f"tap {target} (daemon)\n",
            "err": breadcrumb,
            "post_sync_handled": True,
        }

    def _device_supports_decimal_sleep(self) -> bool:
        """Probe (once per daemon lifetime) whether toybox `sleep` accepts
        decimal seconds. AOSP toybox supports it on API 26+; older
        builds parse `sleep 0.08` as `sleep 0`. Probe via `getprop` —
        cheaper and more reliable than running an actual `sleep` test.
        """
        if self._sleep_decimal_supported is not None:
            return self._sleep_decimal_supported
        try:
            cmd = [ui_snapshot.adb_bin()]
            if self.serial:
                cmd += ["-s", self.serial]
            cmd += ["shell", "getprop", "ro.build.version.sdk"]
            r = subprocess.run(cmd, capture_output=True, timeout=3)
            sdk_text = r.stdout.decode("ascii", errors="replace").strip() or "0"
            sdk = int(sdk_text) if sdk_text.isdigit() else 0
            self._sleep_decimal_supported = sdk >= 26
        except Exception:
            self._sleep_decimal_supported = False
        return self._sleep_decimal_supported

    def _op_tap_macro(self, args: dict) -> dict:
        """Dispatch N coordinate taps as a single `adb exec-out sh -c ...`
        invocation. One host↔device round-trip for the whole sequence
        instead of N. Saves ~150-250 ms per tap on top of the
        already-warm-daemon baseline. The trade-off: no per-tap
        verification, no selector resolution — caller passes resolved
        coords (typically via `resolve_then_tap_sequence` or a prior
        snapshot pass).

        Args:
            taps: list of [x, y] integer pairs. Required, non-empty.
            delay_ms: between-taps sleep, clamped [0, 1000]. Default 80.
            post_wait_ms / wait_for / wait_stable_ms / timeout_ms /
              fail_on_timeout: standard post-sync vocabulary; runs ONCE
              after the entire macro, never between taps.

        Failure model: all-or-nothing. If the shell call returns
        non-zero, we don't know which tap failed. v1 accepts that — the
        canonical use case (keypad-style sequences) treats the whole
        sequence as one logical action.
        """
        taps = args.get("taps")
        if not isinstance(taps, list) or not taps:
            return {"rc": 64, "out": "", "err": "daemon: tap_macro needs non-empty 'taps' list\n"}
        coords: list[tuple[int, int]] = []
        for i, pt in enumerate(taps):
            if not (isinstance(pt, (list, tuple)) and len(pt) == 2):
                return {"rc": 64, "out": "", "err": f"daemon: tap_macro taps[{i}] must be [x,y]\n"}
            try:
                coords.append((int(pt[0]), int(pt[1])))
            except (TypeError, ValueError):
                return {"rc": 64, "out": "", "err": f"daemon: tap_macro taps[{i}] not numeric\n"}
        delay_ms = int(args.get("delay_ms", 80) or 0)
        delay_ms = max(0, min(delay_ms, 1000))
        delay_s = delay_ms / 1000.0

        # Decide sleep clause. On pre-API-26 toybox `sleep 0.08` parses
        # to `sleep 0`, which is harmless but useless — drop entirely.
        # The kernel input subsystem naturally spaces consecutive
        # `input tap` events ~30-50 ms apart, which is enough for most
        # buttons (animation-locked dialogs may need explicit delay,
        # but those break tap_macro's stable-coord contract anyway).
        use_decimal_sleep = self._device_supports_decimal_sleep()
        if delay_ms > 0 and use_decimal_sleep:
            sleep_clause: str | None = f"sleep {delay_s:.3f}"
        else:
            sleep_clause = None

        parts: list[str] = []
        for i, (x, y) in enumerate(coords):
            if i > 0 and sleep_clause is not None:
                parts.append(sleep_clause)
            parts.append(f"input tap {x} {y}")
        pipe = "; ".join(parts)

        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["exec-out", "sh", "-c", pipe]
        # Generous timeout: per-tap shell cost ~10-30 ms, plus the
        # configured delays, plus a 2× safety margin. Bottoms out at
        # 5 s so trivial macros don't hit a too-tight bound.
        budget = 5.0 + len(coords) * 0.05 + (delay_s * len(coords) * 2.0)
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=budget)
        except subprocess.TimeoutExpired:
            return {"rc": 124, "out": "", "err": f"daemon: tap_macro timed out after {budget:.1f}s\n"}
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: tap_macro shell failed: {e}\n"}
        if r.returncode != 0:
            err_text = r.stderr.decode("utf-8", errors="replace").strip() or "(no stderr)"
            return {
                "rc": r.returncode, "out": "",
                "err": f"daemon: tap_macro rc={r.returncode}: {err_text}\n",
            }

        # The macro is one atomic shell call. Bump mutation once: the
        # cache validity check (`_xml_cache_gen == _mutation_gen`)
        # only cares delta-or-not, and bumping per-tap would add no
        # information while inviting confusion.
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation("tap_macro")

        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {
            "rc": rc, "out": f"tap_macro {len(coords)} taps (daemon)\n",
            "err": breadcrumb,
            "post_sync_handled": True,
        }

    def _op_sleep(self, args: dict) -> dict:
        """Plain sleep, daemon-side. No mutation, no post_sync. The
        intended use is the LLM declaring an animation gap inside a
        batch — e.g. after a mode-toggle that recomposes a keypad,
        before a `tap_macro` whose fixed coords would otherwise hit
        not-yet-bound click handlers.

        Why an explicit op instead of relying on `wait_for`: `wait_for`
        proves a node is RENDERED, not that its click handler is
        BOUND. Compose can finish its frame before the gesture
        listener attaches. The LLM, having explored the surface, knows
        which transitions need a settle delay; the daemon shouldn't
        guess.
        """
        try:
            ms = int(args.get("ms", 0) or 0)
        except (TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: sleep: 'ms' must be an integer\n"}
        ms = max(0, min(ms, 10000))
        if ms > 0:
            time.sleep(ms / 1000.0)
        return {"rc": 0, "out": f"sleep {ms}ms (daemon)\n", "err": ""}

    def _op_tap_point(self, args: dict) -> dict:
        """Raw coord tap, no selector resolution, no exists() probe.
        For LLMs replaying a known coord OR clicking a region with no
        accessibility node (Compose Canvas, custom-draw widgets).

        Args:
            x, y: integer coords. Required.
            post_wait_ms / wait_for / wait_stable_ms / timeout_ms /
              fail_on_timeout: standard post-sync vocabulary.
        """
        try:
            x = int(args["x"]); y = int(args["y"])
        except (KeyError, TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: tap_point needs integer 'x' and 'y'\n"}
        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["shell", "input", "tap", str(x), str(y)]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=5)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: tap_point failed: {e}\n"}
        if r.returncode != 0:
            return {"rc": r.returncode, "out": "",
                    "err": f"daemon: tap_point rc={r.returncode}: {r.stderr.decode('utf-8', errors='replace')}\n"}
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation()
        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {"rc": rc, "out": f"tap_point ({x},{y}) (daemon)\n",
                "err": breadcrumb, "post_sync_handled": True}

    def _op_swipe(self, args: dict) -> dict:
        """Single swipe gesture via `adb shell input swipe x1 y1 x2 y2 dur`.
        For scrolling lists, dragging sliders, dismissing drawers.
        Duration in ms (default 300; 50-1500 sane range).

        Args:
            x1, y1, x2, y2: integer coords. Required.
            duration_ms: default 300, clamped [10, 5000].
            post_wait_ms / wait_for / ...: standard post-sync.
        """
        try:
            x1 = int(args["x1"]); y1 = int(args["y1"])
            x2 = int(args["x2"]); y2 = int(args["y2"])
        except (KeyError, TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: swipe needs integer 'x1','y1','x2','y2'\n"}
        dur = int(args.get("duration_ms", 300) or 300)
        dur = max(10, min(dur, 5000))
        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(dur)]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10 + dur / 1000.0)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: swipe failed: {e}\n"}
        if r.returncode != 0:
            return {"rc": r.returncode, "out": "",
                    "err": f"daemon: swipe rc={r.returncode}: {r.stderr.decode('utf-8', errors='replace')}\n"}
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation()
        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {"rc": rc, "out": f"swipe ({x1},{y1})→({x2},{y2}) {dur}ms (daemon)\n",
                "err": breadcrumb, "post_sync_handled": True}

    def _op_long_press(self, args: dict) -> dict:
        """Long-press at a coord via `adb shell input swipe x y x y dur`
        (same start/end = long press). Default duration 1500 ms — UI
        kit convention for revealing admin-mode menus, settings entry
        on locked kiosks.

        Args:
            x, y: integer coords. Required.
            duration_ms: default 1500, clamped [400, 10000].
            post_wait_ms / wait_for / ...: standard post-sync.
        """
        try:
            x = int(args["x"]); y = int(args["y"])
        except (KeyError, TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: long_press needs integer 'x' and 'y'\n"}
        dur = int(args.get("duration_ms", 1500) or 1500)
        dur = max(400, min(dur, 10000))
        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["shell", "input", "swipe", str(x), str(y), str(x), str(y), str(dur)]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10 + dur / 1000.0)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: long_press failed: {e}\n"}
        if r.returncode != 0:
            return {"rc": r.returncode, "out": "",
                    "err": f"daemon: long_press rc={r.returncode}: {r.stderr.decode('utf-8', errors='replace')}\n"}
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation()
        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {"rc": rc, "out": f"long_press ({x},{y}) {dur}ms (daemon)\n",
                "err": breadcrumb, "post_sync_handled": True}

    def _op_describe(self, args: dict) -> dict:
        """Dry-run resolve: takes a list of selectors, returns each one's
        match info + centroid coords WITHOUT dispatching any taps.

        Use cases:
          - LLM has just read a snapshot and wants to verify the next
            5 selectors all resolve before committing to a macro.
          - Caller wants to check whether `assume_stable_coords` would
            actually hold (e.g., are all targets really clickable
            nodes, or do some land on non-clickable text labels?).
          - Pre-computing coords to feed into `tap_macro` from a script
            without going through `resolve_then_tap_sequence` (which
            requires the stable-coords affirmation).

        Args:
            selectors: list[str]. Required, non-empty.
            only_clickable: bool — restrict find_target to clickable
              nodes only (default false; matches `find_target`'s
              clickable-preferred behaviour).

        Output: rc=0; out is JSON. Each entry has:
            selector, found, x, y, bounds (x1,y1,x2,y2), text, desc,
            id, class, clickable. Missing selectors get found=false +
            null coords. rc=0 even if some selectors missed — caller
            decides what to do.
        """
        selectors = args.get("selectors")
        if not isinstance(selectors, list) or not selectors:
            return {"rc": 64, "out": "", "err": "daemon: describe needs non-empty 'selectors' list\n"}

        try:
            xml, _ = self._acquire_xml()
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: describe dump failed: {e}\n"}

        import ui_act  # noqa: WPS433
        try:
            root = ui_snapshot.build_tree(xml)
        except SystemExit as e:
            return {"rc": 1, "out": "", "err": f"daemon: describe parse failed: {e}\n"}
        screen = ui_snapshot.get_screen_size(self.serial)
        only_clickable = bool(args.get("only_clickable", False))
        nodes = ui_snapshot.prune(root, only_clickable=only_clickable, screen_size=screen)
        for i, n in enumerate(nodes, 1):
            n.uid = f"u{i}"

        results: list[dict] = []
        for sel in selectors:
            entry: dict
            if not isinstance(sel, str) or not sel.strip():
                entry = {"selector": sel, "found": False, "error": "bad selector"}
                results.append(entry)
                continue
            node = ui_act.find_target(nodes, sel)
            if node is None or node.bounds is None:
                results.append({"selector": sel, "found": False})
                continue
            x1, y1, x2, y2 = node.bounds
            results.append({
                "selector": sel,
                "found": True,
                "x": (x1 + x2) // 2,
                "y": (y1 + y2) // 2,
                "bounds": [x1, y1, x2, y2],
                "text": node.text or "",
                "desc": node.desc or "",
                "id": node.rid or "",
                "class": node.cls or "",
                "clickable": bool(node.clickable),
                "uid": node.uid,
            })

        found_count = sum(1 for r in results if r.get("found"))
        # When any selector misses, include a `nearby` sample of
        # text= / desc= values currently on screen. Lets the LLM
        # see "the screen has 'Conferma' but I asked for 'Salva'"
        # without re-dumping or escalating to a screencap. Caller-
        # observable correction signal at the moment of confusion.
        payload: dict[str, Any] = {
            "matched": found_count,
            "total": len(selectors),
            "results": results,
        }
        if found_count < len(selectors):
            payload["foreground"] = ui_snapshot.get_foreground_activity(self.serial)
            seen: set[str] = set()
            nearby: list[dict[str, Any]] = []
            for n in nodes:
                if len(nearby) >= 12:
                    break
                label = (n.text or n.desc or "").strip()
                if not label or label in seen:
                    continue
                seen.add(label)
                kind = "text" if (n.text or "").strip() else "desc"
                nearby.append({
                    "selector": f'{kind}="{label}"',
                    "clickable": bool(n.clickable),
                })
            payload["nearby"] = nearby
            payload["hint"] = (
                "selector miss — nearby[] lists what IS on screen "
                "right now. Match against your intent before "
                "escalating to ui_snapshot or a frame Read."
            )
        return {
            "rc": 0,
            "out": json.dumps(payload, ensure_ascii=False) + "\n",
            "err": "",
        }

    def _op_resolve_tap_sequence(self, args: dict) -> dict:
        """Resolve N selectors against ONE pre-macro dump, then dispatch
        the resolved coords via `_op_tap_macro`. The whole sequence
        runs against frozen coords — between taps the UI mutates but
        no further selector resolution happens. Net cost for N taps:
        one dump (or cache hit) + one shell macro round-trip.

        Caller MUST pass `assume_stable_coords: true`. Without that
        affirmation we refuse with rc=64 because the failure mode of a
        moving target is silent empty-space taps. The contract:
        callers commit that selectors stay co-resident on a stable
        layout (keypad, dialog, list-of-buttons). Mode-toggling
        keypads break the contract — see plan §E for the verification
        sub-sequences that respect it.

        Args:
            selectors: list[str] of selector clauses (same grammar as
                ui_act / ui_snapshot — supports comma-joined AND).
            assume_stable_coords: REQUIRED, must be literal True.
            delay_ms: forwarded to tap_macro.
            miss_policy: "abort" (default) returns rc=1 on first
                unresolved selector; "skip" drops it and continues.
            post_wait_ms / wait_for / wait_stable_ms / timeout_ms /
              fail_on_timeout: forwarded to tap_macro's post-sync.
        """
        if args.get("assume_stable_coords") is not True:
            return {
                "rc": 64, "out": "",
                "err": "daemon: resolve_then_tap_sequence requires "
                       "'assume_stable_coords': true (caller asserts that "
                       "selectors are co-resident on a stable layout — "
                       "see plan §E)\n",
            }
        selectors = args.get("selectors")
        if not isinstance(selectors, list) or not selectors:
            return {"rc": 64, "out": "", "err": "daemon: resolve_then_tap_sequence needs non-empty 'selectors' list\n"}
        miss_policy = args.get("miss_policy") or "abort"
        if miss_policy not in ("abort", "skip"):
            return {"rc": 64, "out": "", "err": f"daemon: resolve_then_tap_sequence: bad miss_policy {miss_policy!r}\n"}

        # Post-mutation stabilisation guard.
        #
        # Race: caller does `tap "ABC"` (mode-toggle on keypad) → `sleep
        # 250ms` → `resolve_then_tap_sequence ["F","F"]`. The wait_for
        # on the toggle proved "F" RENDERED, but Compose's click handler
        # may still be binding to the new layout. The dump reads valid
        # coords; the taps land on screen position F but on the OLD
        # layout's handler (or no handler), so input is silently dropped.
        #
        # Mitigation: enforce a minimum 250 ms gap since `_last_mutation_at`
        # before the pre-macro dump. The caller's `sleep` counts toward
        # this gap — if they already slept enough, this is a no-op.
        # Override with `min_post_mutation_ms` (set to 0 to disable for
        # known-non-toggling layouts like a static dialpad).
        try:
            min_gap_raw = args.get("min_post_mutation_ms", 250)
            min_gap_ms = max(0, int(min_gap_raw))
        except (TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: resolve_then_tap_sequence: 'min_post_mutation_ms' must be int\n"}
        if min_gap_ms > 0 and self._last_mutation_at > 0:
            elapsed_ms = int((time.monotonic() - self._last_mutation_at) * 1000)
            remaining_ms = min_gap_ms - elapsed_ms
            if remaining_ms > 0:
                time.sleep(remaining_ms / 1000.0)

        try:
            xml, _ = self._acquire_xml(force_dump=True)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: resolve_then_tap_sequence dump failed: {e}\n"}

        # Reuse ui_act.find_target — the selector grammar lives there
        # and we want exact parity with what `tap` resolves to. Lazy
        # import to avoid daemon↔ui_act module-load coupling.
        import ui_act  # noqa: WPS433
        try:
            root = ui_snapshot.build_tree(xml)
        except SystemExit as e:
            return {"rc": 1, "out": "", "err": f"daemon: resolve_then_tap_sequence parse failed: {e}\n"}
        screen = ui_snapshot.get_screen_size(self.serial)
        nodes = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
        for i, n in enumerate(nodes, 1):
            n.uid = f"u{i}"

        coords: list[list[int]] = []
        skipped: list[str] = []
        for sel in selectors:
            if not isinstance(sel, str) or not sel.strip():
                return {"rc": 64, "out": "", "err": f"daemon: resolve_then_tap_sequence: bad selector {sel!r}\n"}
            node = ui_act.find_target(nodes, sel)
            if node is None or node.bounds is None:
                if miss_policy == "abort":
                    return {
                        "rc": 1, "out": "",
                        "err": f"daemon: resolve_then_tap_sequence: selector not found: {sel!r}\n"
                               + self._hint("resolve_miss", selector=sel),
                    }
                skipped.append(sel)
                continue
            x1, y1, x2, y2 = node.bounds
            coords.append([(x1 + x2) // 2, (y1 + y2) // 2])

        if not coords:
            return {"rc": 1, "out": "", "err": "daemon: resolve_then_tap_sequence: every selector was skipped — nothing to tap\n"}

        # Optional pre-macro settle. Use case: caller just toggled a
        # mode/dialog whose Compose recompose finished rendering (so
        # the resolve-time dump captured correct coords) but whose
        # click handlers need a frame or two to bind. wait_for proves
        # rendering, NOT interactivity — explicit sleep covers the gap.
        try:
            pre_sleep = int(args.get("pre_macro_sleep_ms", 0) or 0)
        except (TypeError, ValueError):
            pre_sleep = 0
        pre_sleep = max(0, min(pre_sleep, 5000))
        if pre_sleep > 0:
            time.sleep(pre_sleep / 1000.0)

        # Forward post-sync vocabulary to the macro so the wait_for at
        # the end of the sequence runs once (not per tap).
        #
        # Post-sync ownership: `_op_tap_macro` is the post-sync caller.
        # We do NOT call `_post_sync_in_daemon` here — that would run
        # the wait_for twice and could trip a `fail_on_timeout` guard
        # the second time when the post-state has settled past the
        # wait_for marker. If you ever inline the macro logic instead
        # of delegating, move post-sync up here.
        macro_args: dict = {"taps": coords}
        for key in ("delay_ms", "post_wait_ms", "wait_for", "wait_stable_ms", "timeout_ms", "fail_on_timeout"):
            if key in args:
                macro_args[key] = args[key]
        resp = self._op_tap_macro(macro_args)
        # Rewrite stdout to reflect the higher-level op; keep tap_macro's
        # err breadcrumb so post-sync timeout messages still surface.
        if int(resp.get("rc", 1)) == 0:
            resp = dict(resp)
            resp["out"] = f"resolve_then_tap_sequence {len(coords)} taps (daemon)\n"
            if skipped:
                extra = f"daemon: resolve_then_tap_sequence skipped {len(skipped)} selector(s): {skipped}\n"
                resp["err"] = (resp.get("err") or "") + extra
        return resp

    def _op_type(self, args: dict) -> dict:
        target = args.get("target")
        text = args.get("text", "")
        timeout = float(args.get("timeout", 5.0))
        if target is None or text is None:
            return {"rc": 64, "out": "", "err": "daemon: type needs 'target' and 'text'\n"}
        selectors = self._split_selectors(target)
        kwargs = self._to_kwargs(selectors)
        if kwargs is None:
            return {"rc": 65, "out": "", "err": f"daemon: selector not u2-mappable: {target!r}\n"}

        # EditText-finding resolution.
        #
        # u2's selector match on `text="Nome *"` returns the LABEL
        # TextView, not the adjacent EditText. set_text on a TextView
        # is a no-op (label not a text-input). Same selector-ambiguity
        # bug `_op_tap` has for clickable rows — different fix shape.
        #
        # Mitigation: dump the tree, find_target → match, then look for
        # an EditText sibling (forward in tree order, closest first) or
        # descendant. Tap THAT EditText by coord, then set_text via the
        # bounded EditText selector via u2. Falls through to original
        # u2 path on any failure.
        # Skipped for `uX` uids (no ambiguity) and `class=*EditText*`
        # selectors (already targeting the input directly).
        edit_coord: tuple[int, int] | None = None
        if (not (target.startswith("u") and target[1:].isdigit())
                and "EditText" not in target):
            try:
                xml, _ = self._acquire_xml()
                root = ui_snapshot.build_tree(xml)
                screen = ui_snapshot.get_screen_size(self.serial)
                nodes = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
                for i, n in enumerate(nodes, 1):
                    n.uid = f"u{i}"
                import ui_act as _ui_act
                match = _ui_act.find_target(nodes, target)
                if match is not None and "EditText" not in (match.cls or "") and match.bounds is not None:
                    # Pick the EditText whose bounds CONTAIN the label's
                    # bounds. On Compose floating-label fields, the label
                    # is rendered INSIDE the EditText box (floating to
                    # the top when populated). On Material View fields,
                    # the label sits above but the parent container is
                    # spatially shared. Containment is the most reliable
                    # cross-style rule: if the label's centre falls
                    # within the EditText's bounds, they belong together.
                    #
                    # Falls back to nearest-EditText-by-vertical-distance
                    # only when no containment match (handles labels
                    # rendered just above the field with no overlap).
                    lx1, ly1, lx2, ly2 = match.bounds
                    lbl_cx = (lx1 + lx2) // 2
                    lbl_cy = (ly1 + ly2) // 2

                    contained_in: ui_snapshot.Node | None = None
                    nearest: ui_snapshot.Node | None = None
                    nearest_dy = 10**9
                    for n in nodes:
                        if "EditText" not in (n.cls or "") or n.bounds is None:
                            continue
                        ex1, ey1, ex2, ey2 = n.bounds
                        # Containment: label centre inside the EditText.
                        if ex1 <= lbl_cx <= ex2 and ey1 <= lbl_cy <= ey2:
                            contained_in = n
                            break
                        # Fallback metric.
                        cy = (ey1 + ey2) // 2
                        dy = abs(cy - lbl_cy)
                        # Same-y two-column rows: also require horizontal
                        # overlap with label, otherwise prefer the
                        # EditText whose x-range overlaps the label's.
                        cx = (ex1 + ex2) // 2
                        horiz_overlap = max(0, min(ex2, lx2) - max(ex1, lx1))
                        # weight: dy strongly; horiz miss adds penalty.
                        penalty = 0 if horiz_overlap > 0 else abs(cx - lbl_cx)
                        score = dy * 4 + penalty
                        if score < nearest_dy:
                            nearest_dy = score
                            nearest = n
                    pick = contained_in if contained_in is not None else nearest
                    if pick is not None and pick.bounds is not None:
                        x1, y1, x2, y2 = pick.bounds
                        edit_coord = ((x1 + x2) // 2, (y1 + y2) // 2)
            except Exception:
                edit_coord = None  # fall back to u2 selector path

        def go(d):
            if edit_coord is not None:
                # Tree-resolved EditText. Click by coord to focus,
                # settle 200 ms for Compose to update focus + IME, then
                # clear + send_keys to the currently-focused field.
                #
                # Earlier this used `d(focused=True).set_text(text)`,
                # but `focused=true` is resolved by u2 BEFORE the new
                # focus state lands on emulator (Compose frame lag),
                # so set_text wrote to the PREVIOUS focused field —
                # turning a 3-field form fill into a single-field
                # overwrite chain. send_keys hits the currently-
                # focused field directly via the IME, no selector
                # lookup. clear=True wipes any prior value first.
                d.click(edit_coord[0], edit_coord[1])
                import time as _time
                _time.sleep(0.2)
                d.clear_text()
                d.send_keys(text)
                return "ok"
            sel = d(**kwargs)
            if not sel.exists(timeout=timeout):
                return "notfound"
            sel.click()
            sel.set_text(text)  # set_text replaces — handles --clear implicitly
            return "ok"

        status = self._u2_call_with_retry(go)
        if status != "ok":
            return {"rc": 1, "out": "", "err": f"daemon: type target not found: {target!r}\n"}
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation("type")

        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {
            "rc": rc, "out": f"type {target} (daemon)\n",
            "err": breadcrumb,
            "post_sync_handled": True,
        }

    def _op_key(self, args: dict) -> dict:
        code = args.get("code")
        if not code:
            return {"rc": 64, "out": "", "err": "daemon: key needs 'code'\n"}

        # BACK semantic guard.
        #
        # `KEYCODE_BACK` is double-overloaded on Android: it dismisses
        # the IME if one is up, OTHERWISE navigates the activity back
        # (popping a fragment, exiting a wizard step, or closing the
        # whole activity). LLMs reach for it to "close the keyboard"
        # after typing a text field — which silently destroys the
        # wizard state when the IME isn't actually visible. Observed
        # failure: type 3 fields → key BACK → wizard step popped →
        # form filled values lost; the rest of the batch runs on a
        # different screen.
        #
        # Guard: if code resolves to BACK, query the IME visibility
        # via dumpsys input_method (mInputShown=true). Refuse with
        # rc=64 + actionable hint when IME isn't up. Override with
        # explicit `force: true` for the rare case where BACK is
        # genuinely meant to navigate.
        normalized = code.upper().replace("KEYCODE_", "")
        if normalized == "BACK" and not args.get("force", False):
            ime_visible = self._is_ime_visible()
            if not ime_visible:
                return {
                    "rc": 64, "out": "",
                    "err": (
                        "daemon: key BACK refused — no IME visible, so BACK "
                        "would navigate the activity back (likely popping the "
                        "current wizard step). If you meant to dismiss a "
                        "keyboard that just isn't up, this is a no-op already. "
                        "If you genuinely want to navigate back, pass "
                        "`force: true`. To dismiss IME safely from any state, "
                        "use the `dismiss_ime` op which checks first.\n"
                    ),
                }

        def go(d):
            d.press(code.lower().replace("keycode_", ""))
            return "ok"

        try:
            self._u2_call_with_retry(go)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: key {code} failed: {e}\n"}
        ui_snapshot.invalidate_meta_sidecar(self.serial)
        self._bump_mutation(f"key_{code}")

        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {
            "rc": rc, "out": f"key {code} (daemon)\n",
            "err": breadcrumb,
            "post_sync_handled": True,
        }

    def _is_ime_visible(self) -> bool:
        """True iff the soft input method is currently shown. Queried
        via `adb shell dumpsys input_method | grep mInputShown=true`.
        ~30 ms cost; only called for BACK-key safety check."""
        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["shell", "dumpsys", "input_method"]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=4)
            txt = r.stdout.decode("utf-8", errors="replace")
            for line in txt.splitlines():
                if "mInputShown=" in line:
                    return "mInputShown=true" in line
        except Exception:
            pass
        return False

    def _op_dismiss_ime(self, args: dict) -> dict:
        """Hide the soft keyboard if visible; no-op if not.
        Replaces the LLM reflex of `key BACK` to close the keyboard,
        which silently navigates the activity when IME isn't up.

        No `force` flag — this op is INTENTIONALLY safe by construction.
        """
        if not self._is_ime_visible():
            return {"rc": 0, "out": "dismiss_ime: no IME visible (no-op)\n", "err": ""}

        def go(d):
            d.press("back")
            return "ok"

        try:
            self._u2_call_with_retry(go)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: dismiss_ime failed: {e}\n"}
        # `dismiss_ime` is NOT a screen mutation — the underlying
        # activity tree is unchanged. Do NOT bump mutation_gen; that
        # would invalidate the XML cache for no reason and force the
        # next snapshot to live-dump.
        ok, breadcrumb = self._post_sync_in_daemon(*self._post_sync_args(args))
        rc = 0 if ok else 124
        return {
            "rc": rc, "out": "dismiss_ime ok\n",
            "err": breadcrumb,
            "post_sync_handled": True,
        }

    # --- snapshot ----------------------------------------------------------

    def _op_snapshot(self, args: dict) -> dict:
        """Reuse ui_snapshot's pruning / sidecar-write paths via the warm u2 handle.

        We dump XML through ui_snapshot.run_adb_dump (which is what its
        main() uses under the hood) but with backend forced to u2 so the
        warm connection is exercised.

        Fix 7 (snapshot cache): when no mutation has happened since the
        last on-disk cache write, skip the live dump and reuse the file.
        Most batch flows snapshot right after a tap whose `wait_for`
        already settled and refreshed the cache — saves one
        `uiautomator dump` round-trip (~200-500 ms). Caller can force a
        fresh dump with `force_dump=True`.

        Note: an earlier "BG-refresh-aware wait" attempt (poll for BG
        cache to land before falling to live dump) was reverted —
        measurement showed BG cycle (DEBOUNCE_MS + dump) routinely
        exceeded any sensible wait budget, so the wait was net-neutral
        or net-negative. The right fix for the "tap → immediate snap"
        pattern is for the caller to chain `wait_for` on the tap, which
        already updates the cache via `_post_sync_in_daemon`.
        """
        only_clickable = bool(args.get("only_clickable", False))
        query = args.get("query") or []
        max_lines = int(args.get("max_lines", 0))
        include_bounds = bool(args.get("include_bounds", True))
        force_dump = bool(args.get("force_dump", False))

        try:
            xml, cache_hit = self._acquire_xml(force_dump=force_dump)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: snapshot dump failed: {e}\n"}

        # Build the printed list with the same filters as ui_snapshot.main.
        screen = ui_snapshot.get_screen_size(self.serial)
        root = ui_snapshot.build_tree(xml)
        nodes_pre_query = ui_snapshot.prune(root, only_clickable=only_clickable, screen_size=screen)
        if query:
            nodes = [n for n in nodes_pre_query if ui_snapshot.selector_match(n, query)]
        else:
            nodes = nodes_pre_query

        for i, n in enumerate(nodes, 1):
            n.uid = f"u{i}"
        lines = [ui_snapshot.format_node(n, include_bounds=include_bounds) for n in nodes]
        dropped = 0
        if max_lines and len(lines) > max_lines:
            dropped = len(lines) - max_lines
            lines = lines[:max_lines]
            nodes = nodes[:max_lines]

        # Sidecar: explicit snapshot writer ONLY. Window-sig race protected
        # by ui_snapshot.write_meta_sidecar's internal pre/post compare.
        sig_pre, _ = ui_snapshot.compute_window_sig(self.serial)
        ui_snapshot.write_meta_sidecar(
            self.serial, nodes,
            foreground=ui_snapshot.get_foreground_activity(self.serial),
            sig_pre=sig_pre,
        )

        out = "\n".join(lines)
        if lines:
            out += "\n"
        if dropped:
            out += f"-- {dropped} more nodes; raise --max-lines or use --query to narrow --\n"
        err = "daemon: snapshot cache_hit\n" if cache_hit else ""
        return {"rc": 0, "out": out, "err": err}

    # --- screencap (lets flow-runner chain action+screenshot in one batch) -

    def _op_screencap(self, args: dict) -> dict:
        """Save a screencap to `args["path"]` (default /tmp/screencap.png).

        Two backends:
          - "u2" (default): reuse the warm uiautomator2 connection. The
            on-device agent streams the framebuffer back without invoking
            `screencap -p`'s PNG encoder for every shot. Typical wall-clock:
            150-400 ms vs 500-1500 ms for the adb path.
          - "adb": shell out to `adb exec-out screencap -p`. Kept as a
            regression escape hatch and as automatic fallback when u2 is
            wedged.

        Two formats: "png" (lossless, default) and "jpeg" (size + speed
        win when the consumer doesn't need pixel-exact output). JPEG
        only valid with the u2 backend — `screencap` cannot emit JPEG
        device-side.
        """
        path = args.get("path") or "/tmp/screencap.png"
        backend = args.get("backend") or "u2"
        if backend not in ("u2", "adb"):
            return {"rc": 64, "out": "", "err": f"daemon: screencap: bad backend {backend!r} (use 'u2' or 'adb')\n"}
        fmt = (args.get("format") or "png").lower()
        if fmt not in ("png", "jpeg"):
            return {"rc": 64, "out": "", "err": f"daemon: screencap: bad format {fmt!r} (use 'png' or 'jpeg')\n"}
        if fmt == "jpeg" and backend == "adb":
            return {"rc": 64, "out": "", "err": "daemon: screencap: format 'jpeg' requires backend 'u2'\n"}
        quality = int(args.get("quality", 85) or 85)
        quality = max(1, min(quality, 100))

        if backend == "u2":
            try:
                if fmt == "png":
                    # u2's screenshot(path) writes PNG directly via the
                    # on-device agent — skips Pillow round-trip.
                    self._u2_call_with_retry(lambda d: d.screenshot(path))
                else:
                    # JPEG path: pull a PIL Image, encode host-side.
                    # u2 always returns PIL when called without a path.
                    img = self._u2_call_with_retry(lambda d: d.screenshot())
                    if img is None:
                        raise RuntimeError("u2 screenshot returned None")
                    img.save(path, "JPEG", quality=quality)
                try:
                    sz = os.path.getsize(path)
                except OSError:
                    sz = -1
                return {"rc": 0, "out": f"screencap -> {path} ({sz} bytes, backend=u2, format={fmt})\n", "err": ""}
            except Exception as e:
                # Transport failures, missing Pillow, agent crash —
                # degrade to adb path so the caller still gets a PNG.
                # JPEG can't fall back (adb path can't encode), so
                # surface the failure instead.
                if fmt == "jpeg":
                    return {"rc": 1, "out": "", "err": f"daemon: screencap u2/jpeg failed: {e}\n"}
                sys.stderr.write(f"daemon: screencap u2 backend failed ({e}); falling back to adb\n")
                # fall through to adb path below

        cmd = [ui_snapshot.adb_bin()]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += ["exec-out", "screencap", "-p"]
        try:
            with open(path, "wb") as fp:
                r = subprocess.run(cmd, stdout=fp, timeout=10)
        except Exception as e:
            return {"rc": 1, "out": "", "err": f"daemon: screencap failed: {e}\n"}
        if r.returncode != 0:
            return {"rc": r.returncode, "out": "", "err": f"daemon: screencap rc={r.returncode}\n"}
        try:
            sz = os.path.getsize(path)
        except OSError:
            sz = -1
        return {"rc": 0, "out": f"screencap -> {path} ({sz} bytes, backend=adb)\n", "err": ""}

    # --- BG trace ops ------------------------------------------------------

    def _op_trace_start(self, args: dict[str, Any]) -> dict[str, Any]:
        """Enable per-mutation BG screencap capture. Until `trace_stop`
        (or daemon idle-exit), every successful mutating op spawns a
        capture worker that writes `<gen>-<op>.<ext>` into `dir`. The
        capture runs concurrently with the next op via the adb-exec-out
        path — no u2 lock contention, no per-op wall-clock penalty.

        args:
          dir: required, output directory (created if missing)
          format: "jpeg" (default) or "png"
          quality: jpeg quality 1-100 (default 85; ignored for png)
        """
        d = args.get("dir")
        if not isinstance(d, str) or not d:
            return {"rc": 64, "out": "", "err": "daemon: trace_start: 'dir' required\n"}
        fmt = (args.get("format") or "jpeg").lower()
        if fmt not in ("png", "jpeg"):
            return {"rc": 64, "out": "", "err": f"daemon: trace_start: bad format {fmt!r}\n"}
        try:
            quality = int(args.get("quality", 85) or 85)
        except (TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: trace_start: 'quality' must be int\n"}
        quality = max(1, min(quality, 100))
        path = Path(d)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return {"rc": 1, "out": "", "err": f"daemon: trace_start: mkdir {path}: {e}\n"}
        with self._trace_lock:
            self._trace_dir = path
            self._trace_format = fmt
            self._trace_jpeg_quality = quality
        # Stay silent on `out` — the trace dir is forensic state for the
        # human, not something to print as part of the batch's user-
        # visible output. Surfacing the path tempts the LLM to `Read()`
        # a frame.
        return {"rc": 0, "out": "", "err": ""}

    def _op_trace_stop(self, args: dict[str, Any]) -> dict[str, Any]:
        """Disable BG capture. In-flight workers complete on their
        own — daemon-thread workers cannot be cancelled mid-write
        without risking truncated frames. Returns immediately.

        Stays silent on `out` so neither the start nor the stop of a
        trace surfaces in the batch's user-visible output.
        """
        with self._trace_lock:
            self._trace_dir = None
        return {"rc": 0, "out": "", "err": ""}

    # --- batch -------------------------------------------------------------

    @staticmethod
    def _validate_batch_ops(ops: list[Any]) -> str:
        """Return a human-readable error string, or empty string when
        the batch shape is valid. Structural-only checks: op name,
        required args present, args of plausible types. No selector
        resolution (would require a dump and defeat the fast-fail
        purpose).
        """
        # Per-op required-args registry. Keyed by op name → list of
        # (arg_key, predicate). Add a row when introducing a new op.
        from typing import Callable as _Callable
        required: dict[str, list[tuple[str, _Callable[[Any], bool]]]] = {
            "tap": [("target", lambda v: isinstance(v, str) and v != "")],
            "tap_point": [
                ("x", lambda v: isinstance(v, (int, float))),
                ("y", lambda v: isinstance(v, (int, float))),
            ],
            "tap_macro": [
                ("taps", lambda v: bool(isinstance(v, list) and v and all(
                    isinstance(p, (list, tuple)) and len(p) == 2
                    and all(isinstance(c, (int, float)) for c in p)
                    for p in v
                ))),
            ],
            "resolve_then_tap_sequence": [
                ("selectors", lambda v: bool(isinstance(v, list) and v and all(isinstance(s, str) and s for s in v))),
                ("assume_stable_coords", lambda v: v is True),
            ],
            "describe": [
                ("selectors", lambda v: bool(isinstance(v, list) and v and all(isinstance(s, str) and s for s in v))),
            ],
            "swipe": [
                ("x1", lambda v: isinstance(v, (int, float))),
                ("y1", lambda v: isinstance(v, (int, float))),
                ("x2", lambda v: isinstance(v, (int, float))),
                ("y2", lambda v: isinstance(v, (int, float))),
            ],
            "long_press": [
                ("x", lambda v: isinstance(v, (int, float))),
                ("y", lambda v: isinstance(v, (int, float))),
            ],
            "sleep": [("ms", lambda v: isinstance(v, (int, float)))],
            "type": [
                ("target", lambda v: isinstance(v, str) and v != ""),
                ("text", lambda v: isinstance(v, str)),
            ],
            "key": [("code", lambda v: isinstance(v, str) and v != "")],
            "screencap": [],  # path optional — defaults to /tmp/screencap.png
            "snapshot": [],
            "window_sig": [],
            "health": [],
            "trace_start": [("dir", lambda v: isinstance(v, str) and v != "")],
            "trace_stop": [],
            "dismiss_ime": [],
        }
        # Post-sync vocabulary every op accepts.
        # `wait_for` / `wait_for_any` / `wait_stable_ms` / `timeout_ms` /
        # `fail_on_timeout` / `post_wait_ms`. Plus daemon-internal
        # `_already_proven` (set by `_op_batch` to skip redundant
        # exists() probes between same-target taps).
        post_sync_keys = {
            "wait_for", "wait_for_any", "wait_stable_ms",
            "timeout_ms", "fail_on_timeout", "post_wait_ms",
            "_already_proven",
        }
        # Per-op allowed `args` keys. Keyed by op → set of allowed keys.
        # Catches the LLM's most common error: writing `timeout` (seconds)
        # instead of `timeout_ms` (ms). Without the allowlist the unknown
        # field is silently ignored, the wait_for hits its 5-second
        # default, the LLM thinks the screen never rendered, and bails
        # to a screencap. With the allowlist, the validator points at
        # the right name BEFORE any op runs.
        allowed: dict[str, set[str]] = {
            "tap": {"target"} | post_sync_keys,
            "tap_point": {"x", "y"} | post_sync_keys,
            "tap_macro": {"taps", "delay_ms"} | post_sync_keys,
            "resolve_then_tap_sequence": {"selectors", "assume_stable_coords", "delay_ms", "miss_policy", "min_post_mutation_ms"} | post_sync_keys,
            "describe": {"selectors", "only_clickable"},
            "swipe": {"x1", "y1", "x2", "y2", "duration_ms"} | post_sync_keys,
            "long_press": {"x", "y", "duration_ms"} | post_sync_keys,
            "sleep": {"ms"},
            "type": {"target", "text", "clear", "clear_method", "clear_max"} | post_sync_keys,
            "key": {"code", "force"} | post_sync_keys,
            "screencap": {"path", "backend", "format", "quality"},
            "snapshot": {"only_clickable", "max_lines", "include_bounds", "query"} | post_sync_keys,
            "window_sig": set(),
            "health": set(),
            "trace_start": {"dir", "format", "quality"},
            "trace_stop": set(),
            "dismiss_ime": post_sync_keys,
        }
        # Common LLM typos → canonical key. Surfaced in the error
        # message so the LLM corrects in one round-trip.
        suggest = {
            "timeout": "timeout_ms (int milliseconds, e.g. 8000 not 8)",
            "wait_stable": "wait_stable_ms (int milliseconds)",
            "post_wait": "post_wait_ms (int milliseconds)",
            "duration": "duration_ms (int milliseconds)",
            "selector": "selectors ([list of strings])",
            "tap": "taps ([[x,y],...] list of pairs)",
        }

        for i, sub in enumerate(ops):
            if not isinstance(sub, dict):
                return f"daemon: batch[{i}] must be a dict, got {type(sub).__name__}\n"
            op = sub.get("op")
            if not isinstance(op, str) or not op:
                return f"daemon: batch[{i}] missing 'op' (got {op!r})\n"
            if op not in required:
                return f"daemon: batch[{i}] unknown op {op!r} (allowed: {sorted(required.keys())})\n"
            sub_args = sub.get("args") or {}
            if not isinstance(sub_args, dict):
                return f"daemon: batch[{i}] 'args' must be a dict, got {type(sub_args).__name__}\n"
            for key, predicate in required[op]:
                if key not in sub_args:
                    return f"daemon: batch[{i}] op={op} missing required arg {key!r}\n"
                if not predicate(sub_args[key]):
                    return f"daemon: batch[{i}] op={op} arg {key!r} failed type/shape check (got {sub_args[key]!r})\n"
            # Reject unknown args. The silent-ignore failure mode is
            # the worst kind: the op runs with defaults, looks broken,
            # the LLM blames the screen, and reaches for a screencap.
            unknown = set(sub_args.keys()) - allowed[op]
            if unknown:
                bad = sorted(unknown)[0]
                hint = suggest.get(bad, "")
                msg = f"daemon: batch[{i}] op={op} unknown arg {bad!r}"
                if hint:
                    msg += f" — did you mean `{hint}`?"
                msg += f" allowed: {sorted(allowed[op])}\n"
                return msg
        return ""

    def _op_batch(self, args: dict) -> dict:
        """Execute a list of sub-ops in order, single round-trip from
        the client's POV. NOT transactional — UI mutations don't roll
        back. The win is amortising IPC + u2 lock acquire across N ops.

        args: {"ops": [{"op":"tap","args":{...}}, ...],
               "stop_on_error": bool (default True)}

        Returns: {"rc": 0|first_nonzero, "out": "...", "err": "...",
                  "results": [{"rc","out","err","post_sync_handled"}, ...]}
        """
        ops = args.get("ops")
        if not isinstance(ops, list) or not ops:
            return {"rc": 64, "out": "", "err": "daemon: batch needs non-empty 'ops' list\n"}
        stop_on_error = bool(args.get("stop_on_error", True))
        # Fix 14 (total batch budget): wall-clock cap across the whole
        # flow, regardless of per-op timeouts. Without this, an LLM
        # session can hang indefinitely when one op's `wait_for`
        # times out at 5 s and the next op's wait_for times out at
        # 5 s and so on — the budget is N×5 s. Setting flow_timeout_ms
        # to e.g. 30000 caps the whole flow at 30 s, returning rc=124
        # with a synthetic timeout entry inserted into `results`.
        # Default: unlimited (None).
        try:
            flow_timeout_ms_raw = args.get("flow_timeout_ms")
            flow_timeout_ms = int(flow_timeout_ms_raw) if flow_timeout_ms_raw is not None else None
        except (TypeError, ValueError):
            return {"rc": 64, "out": "", "err": "daemon: batch 'flow_timeout_ms' must be integer ms\n"}
        if flow_timeout_ms is not None and flow_timeout_ms <= 0:
            return {"rc": 64, "out": "", "err": "daemon: batch 'flow_timeout_ms' must be > 0\n"}
        flow_deadline = (time.monotonic() + flow_timeout_ms / 1000.0) if flow_timeout_ms else None

        # Fix 13 (flow validate pre-pass): walk the whole list once
        # before dispatching ANY op. Catches typos / shape errors
        # cheaply — much better than discovering at op[7] that op[8]'s
        # selector is missing a quote, by which time op[0..6] have
        # already mutated the device. Validation is structural only;
        # we don't try to resolve selectors here (would force a dump).
        validate_err = self._validate_batch_ops(ops)
        if validate_err:
            return {"rc": 64, "out": "", "err": validate_err}

        # Activity-stability guard.
        #
        # Long batches can be silently broken when the app's activity
        # is recreated mid-flow (process death + restore, screensaver
        # idle-timer firing, force-stop racing a tap). The new screen
        # may LOOK similar enough that ops keep dispatching, but they
        # land on a different task and the test result is meaningless.
        #
        # Capture `topResumedActivity` task id at batch start; check
        # again after every MUTATING op. On change, abort the rest of
        # the batch with rc=124 + clear breadcrumb naming the drift.
        # Disable with `track_activity_stability: false` for batches
        # that legitimately cross activity boundaries.
        track_stability = bool(args.get("track_activity_stability", True))
        start_task_id: str = self._activity_task_id() if track_stability else ""

        results: list[dict] = []
        agg_rc = 0
        out_parts: list[str] = []
        err_parts: list[str] = []
        # Fix 8: carry "the previous op's wait_for proved selector S exists
        # right now" forward. When the next op is a tap on selector S, the
        # daemon can skip the redundant sel.exists() pre-check and save one
        # jsonrpc round-trip. Tracked only across the same batch — never
        # leaks across separate requests.
        proven_target: str | None = None
        # Fix 15 (parallel read-only stages): identify runs of consecutive
        # read-only ops and dispatch them via ThreadPoolExecutor. Saves
        # ~100 ms per stage when the batch has e.g.
        # `[snapshot, screencap, window_sig]`. Mutating ops force a
        # stage flush — they MUST run in order so the next read sees
        # post-mutation state. Per-thread internal locks (`_u2_lock`,
        # `_gen_lock`) serialise where needed; this just unlocks the
        # case where two ops legitimately have no dependency.
        # NOTE: `sleep` is intentionally NOT in this set. It's read-only
        # for state but the LLM uses it to sequence wall-clock time
        # (animation gaps between actions) — parallelising 3×100 ms
        # sleeps would collapse 300 ms of intent into 100 ms.
        READ_ONLY_OPS = frozenset({"snapshot", "window_sig", "screencap", "describe", "health"})

        def _dispatch_one(idx_sub: tuple[int, dict]) -> tuple[int, dict, dict]:
            idx, payload = idx_sub
            sub_op_local = payload["sub_op"]
            sub_args_local = payload["sub_args"]
            if sub_op_local not in (
                "tap", "tap_point", "tap_macro", "resolve_then_tap_sequence",
                "describe",
                "swipe", "long_press", "sleep",
                "type", "key", "snapshot", "window_sig", "health", "screencap",
                "trace_start", "trace_stop", "dismiss_ime",
            ):
                return idx, payload, {
                    "rc": 64, "out": "",
                    "err": f"daemon: batch[{idx}]: unsupported sub-op {sub_op_local!r}\n",
                }
            return idx, payload, self.handle({"op": sub_op_local, "args": sub_args_local})

        def _flush_parallel(stage: list[tuple[int, dict]]) -> bool:
            """Run a stage of consecutive read-only ops concurrently.
            Returns True if caller should keep dispatching, False if
            stop_on_error fired and we recorded a failure."""
            nonlocal agg_rc
            if not stage:
                return True
            if len(stage) == 1:
                idx, payload, resp = _dispatch_one(stage[0])
                _consume(idx, payload, resp)
                return _continue_after(resp, payload.get("sub_op"))
            # Use a small pool; more than 4 doesn't help on USB-bound
            # I/O, and avoids hammering the device with N concurrent
            # adb sessions on big batches.
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(4, len(stage))) as pool:
                completed = list(pool.map(_dispatch_one, stage))
            # Restore declared order (pool.map already preserves it,
            # but be defensive).
            completed.sort(key=lambda t: t[0])
            for idx, payload, resp in completed:
                _consume(idx, payload, resp)
                if not _continue_after(resp, payload.get("sub_op")):
                    return False
            return True

        def _consume(idx: int, payload: dict, resp: dict) -> None:
            results.append({
                "rc": int(resp.get("rc", 1)),
                "out": resp.get("out", ""),
                "err": resp.get("err", ""),
                "post_sync_handled": bool(resp.get("post_sync_handled", False)),
            })
            if resp.get("out"):
                out_parts.append(resp["out"])
            if resp.get("err"):
                err_parts.append(resp["err"])

        # Non-fatal ops: their failure NEVER aborts the batch, regardless
        # of stop_on_error. Lets the LLM embed verification ops mid-batch
        # (`describe`, `snapshot`) without splitting the batch on every
        # diagnostic. A failed describe still records rc in results so
        # the LLM sees it; the batch keeps going.
        #
        # Mutating ops keep the original stop_on_error semantic — a
        # failed tap mid-flow still aborts (the downstream state is
        # unknown). Verification ops are read-only by definition; their
        # failure indicates the screen isn't what the caller expected,
        # which is information, not a flow-blocking error.
        NON_FATAL_OPS = frozenset({"describe", "snapshot", "window_sig", "health"})

        def _continue_after(resp: dict, sub_op_name: str | None = None) -> bool:
            nonlocal agg_rc
            sub_rc = int(resp.get("rc", 1))
            if sub_rc != 0 and sub_op_name in NON_FATAL_OPS:
                # Capture rc into agg_rc only for the FINAL outcome; do
                # NOT abort. Caller's results[] already includes the
                # failed op's rc/err for downstream inspection.
                if agg_rc == 0:
                    agg_rc = sub_rc
                return True
            if sub_rc != 0 and stop_on_error:
                agg_rc = sub_rc
                return False
            if sub_rc != 0 and agg_rc == 0:
                agg_rc = sub_rc
            return True

        ro_stage: list[tuple[int, dict]] = []
        timed_out = False
        for i, sub in enumerate(ops):
            # Total-flow budget check fires BEFORE each sub-op (and
            # before flushing a pending read-only stage) so we never
            # start work we know will exceed the cap.
            if flow_deadline is not None and time.monotonic() >= flow_deadline:
                if ro_stage:
                    if not _flush_parallel(ro_stage):
                        ro_stage = []
                        break
                    ro_stage = []
                results.append({
                    "rc": 124, "out": "",
                    "err": f"daemon: batch flow_timeout_ms={flow_timeout_ms} exceeded "
                           f"before op[{i}] (op={sub.get('op')!r})\n",
                    "post_sync_handled": False,
                })
                err_parts.append(results[-1]["err"])
                agg_rc = 124
                timed_out = True
                break
            sub_op = sub.get("op")
            sub_args = dict(sub.get("args") or {})
            if (
                sub_op == "tap"
                and proven_target is not None
                and sub_args.get("target") == proven_target
                and not sub_args.get("_already_proven")
            ):
                sub_args["_already_proven"] = True

            payload = {"sub_op": sub_op, "sub_args": sub_args}
            if sub_op in READ_ONLY_OPS:
                # Buffer for parallel dispatch when the run reaches ≥2
                # consecutive read-only ops. Single-op runs flush
                # sequentially in `_flush_parallel` so behaviour stays
                # identical.
                ro_stage.append((i, payload))
                continue

            # Mutating op (or unsupported) — flush any pending read-only
            # stage first so ordering is preserved, then dispatch this
            # op sequentially.
            if ro_stage:
                if not _flush_parallel(ro_stage):
                    ro_stage = []
                    break
                ro_stage = []

            _, _, resp = _dispatch_one((i, payload))
            # `proven_target` carry-forward applies only to the
            # mutating-tap path (read-only stages don't take taps).
            wait_for = sub_args.get("wait_for")
            if isinstance(wait_for, str):
                wait_for = [wait_for]
            if (
                int(resp.get("rc", 1)) == 0
                and isinstance(wait_for, list)
                and len(wait_for) == 1
                and not wait_for[0].startswith("!")
            ):
                proven_target = wait_for[0]
            else:
                proven_target = None
            _consume(i, payload, resp)
            # Activity-stability check (post-mutation only).
            # `dismiss_ime` is also skipped — it's a UI nudge, not a
            # screen mutation. `sleep` similarly skipped.
            if (
                track_stability
                and start_task_id
                and int(resp.get("rc", 1)) == 0
                and sub_op not in ("sleep", "snapshot", "describe", "window_sig",
                                   "screencap", "health", "trace_start",
                                   "trace_stop", "dismiss_ime")
            ):
                cur_task_id = self._activity_task_id()
                if cur_task_id and cur_task_id != start_task_id:
                    drift_err = (
                        f"daemon: batch[{i}] activity drift detected — "
                        f"task id was {start_task_id!r} at batch start, "
                        f"now {cur_task_id!r}. The activity was recreated "
                        f"(idle screensaver fired / force-stop raced / "
                        f"deep link replaced the task). Form state from "
                        f"prior ops is gone; aborting before next op runs "
                        f"on a different screen. Re-launch the activity, "
                        f"re-anchor the start screen, and resubmit. Disable "
                        f"this check via `track_activity_stability: false` "
                        f"in the batch root if the drift is intentional.\n"
                    )
                    results.append({
                        "rc": 124, "out": "", "err": drift_err,
                        "post_sync_handled": False,
                    })
                    err_parts.append(drift_err)
                    agg_rc = 124
                    break
            if not _continue_after(resp, sub_op):
                break

        # Flush trailing read-only stage if loop ended cleanly.
        if not timed_out and ro_stage:
            _flush_parallel(ro_stage)
            ro_stage = []

        return {
            "rc": agg_rc,
            "out": "".join(out_parts),
            "err": "".join(err_parts),
            "results": results,
        }

    # --- window-sig cache (Fix 3) -----------------------------------------

    def _op_window_sig(self, args: dict) -> dict:
        """Return (sig, rotation) using a generation-keyed cache. Saves
        ~50-80 ms per `tap uX` lookup when no mutation has happened
        since the last sig computation.

        Stale-return guard: a mutation landing while we're inside
        `compute_window_sig` would make the result reflect the OLD
        window. Recompute up to 3 times when `_mutation_gen` changes
        during compute. If all 3 attempts race a mutation, return
        `SIG_UNAVAILABLE` so the caller fails-closed on the uid lookup
        instead of accepting a coarse-hash that might falsely match.
        """
        # Cached only when mutation_gen has not advanced. Cache is
        # invalidated by `_bump_mutation` setting `_sig_cache = None`.
        with self._gen_lock:
            cached = self._sig_cache
            cur_gen = self._mutation_gen
        if cached is not None and cached[2] == cur_gen:
            sig, rot, _ = cached
            return {
                "rc": 0,
                "out": json.dumps({"sig": sig, "rotation": rot, "cached": True, "mutation_gen": cur_gen}),
                "err": "",
            }

        sig = ""
        rot = 0
        stable = False
        for _ in range(3):
            with self._gen_lock:
                start_gen = self._mutation_gen
            sig, rot = ui_snapshot.compute_window_sig(self.serial)
            with self._gen_lock:
                end_gen = self._mutation_gen
                if start_gen == end_gen:
                    self._sig_cache = (sig, rot, end_gen)
                    cur_gen = end_gen
                    stable = True
                    break
                cur_gen = end_gen
            # else mutation landed during compute → loop and try again
        if not stable:
            # All 3 attempts saw a mutation racing the compute. The
            # signature we captured may not reflect the current window.
            # `compute_window_sig` is intentionally coarse — many real
            # mutations preserve the same hash — so returning it could
            # silently pass a sidecar check that should have failed.
            # Force fail-closed on the caller side by returning the
            # SIG_UNAVAILABLE sentinel.
            sig = ui_snapshot.SIG_UNAVAILABLE
        return {
            "rc": 0,
            "out": json.dumps({"sig": sig, "rotation": rot, "cached": False, "mutation_gen": cur_gen}),
            "err": "",
        }

    # --- main loop ---------------------------------------------------------

    def serve(self, sock_path: Path) -> None:
        # Clean up stale socket if present.
        try:
            sock_path.unlink()
        except FileNotFoundError:
            pass

        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(sock_path))
        srv.listen(8)
        srv.settimeout(1.0)

        # Record the inode of OUR socket file. The orphan-detection check
        # below compares the current path's inode to ours; mismatch means
        # another daemon unlinked + re-bound and we are an orphan, so we
        # exit. Same `(st_dev, st_ino)` pair guards the `finally` unlink
        # so we never delete a winner's socket on the way out.
        try:
            owned_stat = sock_path.stat()
            owned_ident = (owned_stat.st_dev, owned_stat.st_ino)
        except FileNotFoundError:
            owned_ident = None

        def _still_own_socket() -> bool:
            if owned_ident is None:
                return True
            try:
                cur = sock_path.stat()
            except FileNotFoundError:
                return False
            return (cur.st_dev, cur.st_ino) == owned_ident

        try:
            while not self._stop.is_set():
                # Idle exit (Fix 5: adaptive).
                # Window scales with observed inter-arrival cadence so
                # frequent users keep the daemon longer than 5 min, while
                # truly idle daemons exit faster.
                idle_window = max(60.0, min(1800.0, 4.0 * self._inter_arrival_ema_sec))
                if time.monotonic() - self._last_request > idle_window:
                    sys.stderr.write(
                        f"daemon: idle {int(idle_window)}s (adaptive); exiting.\n"
                    )
                    return
                # Orphan detection: socket replaced under us.
                if not _still_own_socket():
                    sys.stderr.write(
                        "daemon: socket replaced by another instance; exiting.\n"
                    )
                    return
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                except OSError as e:
                    if e.errno == errno.EBADF:
                        return
                    raise
                threading.Thread(
                    target=self._serve_one, args=(conn,), daemon=True
                ).start()
        finally:
            srv.close()
            # Only unlink if the file at this path is STILL our socket.
            # If another daemon replaced it, blindly unlinking would
            # orphan that daemon and leave clients hanging.
            if _still_own_socket():
                try:
                    sock_path.unlink()
                except FileNotFoundError:
                    pass

    def _serve_one(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(30.0)
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
                if len(buf) > MAX_REQUEST_BYTES:
                    self._reply(conn, {
                        "rc": 64, "out": "",
                        "err": f"daemon: request exceeds {MAX_REQUEST_BYTES} bytes\n",
                    })
                    return
            line, _ = buf.split(b"\n", 1)
            try:
                req = json.loads(line.decode("utf-8"))
            except Exception as e:
                self._reply(conn, {"rc": 64, "out": "", "err": f"daemon: bad JSON: {e}\n"})
                return
            resp = self.handle(req)
            self._reply(conn, resp)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    @staticmethod
    def _reply(conn: socket.socket, resp: dict) -> None:
        line = json.dumps(resp, ensure_ascii=False) + "\n"
        try:
            conn.sendall(line.encode("utf-8"))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI entry — supports both server-side run and a thin --request client form.
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--serial", default=None, help="adb serial (else $ANDROID_SERIAL or session file)")
    p.add_argument("--detach", action="store_true",
                   help="double-fork into the background and exit immediately")
    p.add_argument("--request", default=None,
                   help='one-shot client mode: send this JSON request to the daemon and print the response')
    return p.parse_args(argv)


def daemonize() -> None:
    """Standard double-fork detach. Stdout/stderr go to /dev/null."""
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def main() -> int:
    args = parse_args(sys.argv[1:])
    serial = ui_snapshot.resolve_serial(args.serial)

    # Client mode: send a single request, print response, exit.
    if args.request is not None:
        sock_path = socket_path(serial)
        if not sock_path.exists():
            sys.stderr.write(f"daemon: socket missing at {sock_path}\n")
            return 2
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(30.0)
            sock.connect(str(sock_path))
            sock.sendall((args.request.rstrip("\n") + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
            sock.close()
        except Exception as e:
            sys.stderr.write(f"daemon: client send failed: {e}\n")
            return 2
        try:
            resp = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
        except Exception as e:
            sys.stderr.write(f"daemon: bad response: {e}\n")
            return 2
        if resp.get("out"):
            sys.stdout.write(resp["out"])
        if resp.get("err"):
            sys.stderr.write(resp["err"])
        return int(resp.get("rc", 1))

    # Server mode.
    if args.detach:
        daemonize()

    # Single-instance guard. flock on a pidfile prevents two daemons from
    # racing (concurrent CLI calls both spawning a daemon). The flock
    # is held for the lifetime of this process; a crash releases it on
    # close. EWOULDBLOCK -> another daemon is starting or running, exit
    # silently and let the caller's client-side retry connect to the winner.
    pf = pidfile_path(serial)
    try:
        pf_fd = os.open(str(pf), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        sys.stderr.write(f"daemon: cannot open pidfile {pf}: {e}\n")
        return 2
    try:
        fcntl.flock(pf_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
            sys.stderr.write(
                f"daemon: another instance is already running (pidfile {pf} locked); exiting.\n"
            )
            os.close(pf_fd)
            return 0
        os.close(pf_fd)
        sys.stderr.write(f"daemon: flock failed: {e}\n")
        return 2

    os.ftruncate(pf_fd, 0)
    os.write(pf_fd, str(os.getpid()).encode("utf-8"))

    try:
        d = Daemon(serial)
        d.serve(socket_path(serial))
    finally:
        try:
            fcntl.flock(pf_fd, fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            os.close(pf_fd)
        except Exception:
            pass
        try:
            pf.unlink()
        except FileNotFoundError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
