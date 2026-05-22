#!/usr/bin/env python3
"""
ui_act.py — perform an Android UI action (tap / type / key) by uid or selector.

Usage:
    ui_act.py [--serial S] tap   <uid|selector>     [--timeout SEC]
    ui_act.py [--serial S] type  <uid|selector> "<text>" [--timeout SEC]
    ui_act.py [--serial S] key   <KEYCODE>
    ui_act.py [--serial S] back
    ui_act.py [--serial S] home

Examples:
    ui_act.py tap u3
    ui_act.py tap 'text="Sign in"'
    ui_act.py type u4 "alice@example.com"
    ui_act.py key KEYCODE_ENTER
    ui_act.py back

Resolution flow for tap/type:
  1. Read the cached snapshot at $TMPDIR/android-skill-<serial>.xml
     (written by ui_snapshot.py). If absent or stale, dump fresh.
  2. Re-parse, re-prune, re-assign uids, find the requested target.
  3. If not found and --timeout > 0, re-dump and retry until match or timeout.
  4. Tap the centre of bounds, or focus then `input text` for type.

Type rules:
  - Text containing space is sent via `adb shell input text` with %s escaping
    (Android's `input` substitutes %s for space).
  - We tap the target first to focus it, then dispatch the text.

`type "..."` does NOT clear the field. Issue a `key KEYCODE_DEL` loop or
use `--clear` first.
"""

from __future__ import annotations

import argparse
import functools
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

# Re-use the snapshot parser by importing — both files live in the same dir.
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))
import ui_snapshot  # noqa: E402  — sibling module


def adb(serial: str | None, *args: str, capture: bool = True, timeout: int = 10) -> subprocess.CompletedProcess:
    # Default 10s timeout: input/keyevent calls return in ms; if adb hangs we
    # want the script to fail loudly rather than block forever.
    cmd = [ui_snapshot.adb_bin()]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    try:
        return subprocess.run(cmd, capture_output=capture, timeout=timeout)
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"ui_act: adb call timed out after {timeout}s: {' '.join(cmd)}\n")
        raise SystemExit(124)


def load_snapshot(serial: str | None, force_dump: bool, *, compressed: bool = True,
                  backend: str = "auto") -> list[ui_snapshot.Node]:
    cache = Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-{serial or 'default'}.xml"
    if force_dump or not cache.exists():
        xml, sz = ui_snapshot.run_adb_dump(serial, compressed=compressed, backend=backend)
        ui_snapshot.set_screen_size(serial, sz)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(xml)
    else:
        xml = cache.read_bytes()
    root = ui_snapshot.build_tree(xml)
    screen = ui_snapshot.get_screen_size(serial)
    nodes = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
    for i, n in enumerate(nodes, 1):
        n.uid = f"u{i}"
    return nodes


def find_target(nodes: list[ui_snapshot.Node], target: str) -> ui_snapshot.Node | None:
    """target is either a uid (u3) or a selector (text="...", id=..., desc=...).

    Selector ranking when multiple nodes match (e.g. a non-clickable
    TextView header AND a TextView child of a clickable row both with
    `text="Impostazioni"`):

      1. clickable=true on the node itself
      2. clickable=true on a parent/ancestor (matches inside a row)
      3. has bounds
      4. tree order (stable tiebreak)

    Without (2) the older ranking landed on the first matching label —
    typically the page TITLE rather than the intended row — and the
    subsequent `wait_for` timed out 5 seconds later. Preferring matches
    with a clickable ancestor fires the tap on the row instead.
    """
    if target.startswith("u") and target[1:].isdigit():
        for n in nodes:
            if n.uid == target:
                return n
        return None
    selectors = [s.strip() for s in target.split(",") if s.strip()]
    if not selectors:
        return None
    matches = [n for n in nodes if ui_snapshot.selector_match(n, selectors)]
    if not matches:
        return None

    def has_clickable_ancestor(node: ui_snapshot.Node) -> bool:
        cur = getattr(node, "parent", None)
        while cur is not None:
            if getattr(cur, "clickable", False):
                return True
            cur = getattr(cur, "parent", None)
        return False

    matches.sort(key=lambda n: (
        not n.clickable,
        not has_clickable_ancestor(n),
        n.bounds is None,
    ))
    return matches[0]


def tap_at(serial: str | None, x: int, y: int) -> int:
    r = adb(serial, "shell", "input", "tap", str(x), str(y))
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", errors="replace"))
    else:
        # Mutating action — invalidate uid sidecar immediately so a
        # subsequent `tap uX` cannot read a stale map. Idempotent.
        ui_snapshot.invalidate_meta_sidecar(serial)
    return r.returncode


# ---------------------------------------------------------------------------
# Daemon thin-client (opt-in).
#
# When the daemon is reachable (UDS at $TMPDIR/android-skill-daemon.<serial>.sock),
# tap/type/key/snapshot operations route through it so the u2 connection stays
# warm across CLI invocations. On any error (socket missing, connect refused,
# bad response) the caller falls back to the direct path — no silent
# regression.
#
# Auto-spawn: if the socket does not exist and ANDROID_SKILL_USE_DAEMON is not
# explicitly set to "0", we attempt one detached spawn of
# `android_skill_daemon.py --detach`. The spawn is best-effort; if it fails we
# fall back transparently to the direct path.
# ---------------------------------------------------------------------------

def _daemon_socket_path(serial: str | None):
    from pathlib import Path as _Path
    return _Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-daemon.{serial or 'default'}.sock"


def _daemon_enabled() -> bool:
    return os.environ.get("ANDROID_SKILL_USE_DAEMON", "1") not in ("0", "false", "no", "off")


def _try_spawn_daemon(serial: str | None) -> None:
    """Best-effort detached spawn. Returns immediately; caller polls socket."""
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    daemon_py = os.path.join(here, "android_skill_daemon.py")
    if not os.path.isfile(daemon_py):
        return
    cmd = [sys.executable, daemon_py, "--detach"]
    if serial:
        cmd += ["--serial", serial]
    try:
        # detach: stdout/stderr to devnull, no stdin, fully decoupled
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except Exception as e:
        sys.stderr.write(f"ui_act: daemon spawn failed ({e}); using direct path\n")


def _daemon_request(serial: str | None, op: str, op_args: dict) -> tuple[int, str, str, bool] | None:
    """Send one request to the daemon. Returns (rc, out, err) or None on failure.

    Stale-socket recovery: a daemon killed with SIGKILL leaves its UDS file
    behind (the kernel does not unlink AF_UNIX sockets on process exit). A
    connect to that path fails. Without recovery, every subsequent CLI call
    would skip spawn (`socket.exists() == True`), connect-fail, and fall
    through to the direct path forever. Recovery: on connect failure to an
    existing socket file, unlink it and attempt a single spawn-and-retry.
    The spawn itself is gated by the daemon's flock-on-pidfile guard, so
    racing recoverers cannot produce two daemons.
    """
    if not _daemon_enabled():
        return None
    import socket as _sock
    import json as _json
    sock_path = _daemon_socket_path(serial)

    def _wait_for_socket(deadline: float) -> bool:
        while time.monotonic() < deadline:
            if sock_path.exists():
                return True
            time.sleep(0.05)
        return False

    if not sock_path.exists():
        # Cold start: fire-and-forget spawn. Run THIS call via the direct
        # path so first-call latency stays sane (no 1.5 s blocking wait
        # for the daemon socket to appear). Subsequent calls hit the
        # warm daemon. Returning None signals the caller to fall through.
        _try_spawn_daemon(serial)
        return None

    def _try_connect():
        s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
        s.settimeout(30.0)
        s.connect(str(sock_path))
        return s

    try:
        s = _try_connect()
    except Exception:
        # Stale socket: file exists but no listener. Unlink + spawn retry.
        try:
            sock_path.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            return None
        _try_spawn_daemon(serial)
        if not _wait_for_socket(time.monotonic() + 1.5):
            return None
        try:
            s = _try_connect()
        except Exception:
            return None

    try:
        payload = _json.dumps({"op": op, "args": op_args}, ensure_ascii=False) + "\n"
        s.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return None
    finally:
        try:
            s.close()
        except Exception:
            pass

    try:
        resp = _json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
    except Exception:
        return None
    return (
        int(resp.get("rc", 1)),
        resp.get("out", ""),
        resp.get("err", ""),
        bool(resp.get("post_sync_handled", False)),
    )


def _daemon_batch(
    serial: str | None,
    ops: list[dict],
    stop_on_error: bool = True,
    wait_for_daemon: bool = False,
    wait_timeout_s: float = 2.0,
    flow_timeout_ms: int | None = None,
) -> list[tuple[int, str, str, bool]] | None:
    """Send a list of ops to the daemon in one round-trip.

    Returns a list of (rc, out, err, post_sync_handled) tuples — one per
    sub-op that ran. Returns None on any transport failure (caller
    should fall back to per-op direct execution).

    `ops` is a list of dicts shaped like
        {"op": "tap"|"type"|"key"|"snapshot"|...,
         "args": {...}}

    When `wait_for_daemon=True` and the socket is missing on entry, spawn
    the daemon and wait up to `wait_timeout_s` for the socket to appear
    before sending the batch. Single-op callers leave this False to keep
    cold-start latency low; batch callers (where one round-trip amortises
    N ops) opt in so first-call doesn't degrade to per-op subprocess
    fallback — see ui_run_flow.py.
    """
    if not _daemon_enabled():
        return None
    import socket as _sock
    import json as _json
    sock_path = _daemon_socket_path(serial)

    def _wait_for_socket(deadline: float) -> bool:
        while time.monotonic() < deadline:
            if sock_path.exists():
                return True
            time.sleep(0.05)
        return False

    if not sock_path.exists():
        _try_spawn_daemon(serial)
        if not wait_for_daemon:
            return None  # Cold start: caller falls back; daemon warms async.
        if not _wait_for_socket(time.monotonic() + wait_timeout_s):
            return None  # Spawn didn't materialise in time; caller falls back.

    def _try_connect():
        s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
        s.settimeout(60.0)
        s.connect(str(sock_path))
        return s

    try:
        s = _try_connect()
    except Exception:
        try:
            sock_path.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            return None
        _try_spawn_daemon(serial)
        if wait_for_daemon and _wait_for_socket(time.monotonic() + wait_timeout_s):
            try:
                s = _try_connect()
            except Exception:
                return None
        else:
            return None

    try:
        batch_args: dict = {"ops": ops, "stop_on_error": stop_on_error}
        if flow_timeout_ms is not None:
            batch_args["flow_timeout_ms"] = int(flow_timeout_ms)
        payload = _json.dumps({
            "op": "batch",
            "args": batch_args,
        }, ensure_ascii=False) + "\n"
        s.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(8192)
            if not chunk:
                break
            buf += chunk
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return None
    finally:
        try:
            s.close()
        except Exception:
            pass

    try:
        full = _json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
    except Exception:
        return None
    results = full.get("results") or []
    out: list[tuple[int, str, str, bool]] = []
    for r in results:
        out.append((
            int(r.get("rc", 1)),
            r.get("out", ""),
            r.get("err", ""),
            bool(r.get("post_sync_handled", False)),
        ))
    # Surface top-level batch errors (no per-op results, e.g. validate
    # pre-pass rejection or `batch needs non-empty 'ops' list`).
    # Without this, `ui_run_flow` silently exits 0 because the empty
    # results list prints nothing and `_print_results` aggregates rc=0.
    if not out:
        top_rc = int(full.get("rc", 0))
        top_err = full.get("err", "")
        top_out = full.get("out", "")
        if top_rc != 0 or top_err or top_out:
            out.append((top_rc, top_out, top_err, False))
    return out


def _daemon_window_sig(serial: str | None) -> tuple[str, int] | None:
    """Ask the daemon for the cached window signature. Returns (sig, rotation)
    or None on failure (caller falls back to direct compute)."""
    resp = _daemon_request(serial, "window_sig", {})
    if resp is None:
        return None
    rc, out, _err, _post = resp
    if rc != 0 or not out:
        return None
    try:
        import json as _json
        d = _json.loads(out)
        return d.get("sig", ""), int(d.get("rotation", 0))
    except Exception:
        return None


def _selector_to_u2_kwargs(selectors: list[str]) -> dict | None:
    """Translate the skill's selector grammar into uiautomator2 keyword args.

    Returns None if any clause cannot be expressed in u2 — caller should
    fall back to the XML-dump path.

    Mapping:
      text="X"        -> text="X"
      text~"X"        -> textContains="X"
      desc="X"        -> description="X"
      desc~"X"        -> descriptionContains="X"
      id=full:id/x    -> resourceId="full:id/x"
      id=short        -> resourceIdMatches=".*:id/short$"
      class=FQN       -> className="FQN"
      class=Short     -> classNameMatches=".*\\.Short$"
      clickable=true  -> clickable=True (similar for false)
      focused=true    -> focused=True (similar for false)

    Memoised: pure function over the input list — same selectors recur
    constantly in keypad-style flows (`text="0"`, `text="ABC"` typed
    dozens of times). Cache by tuple-of-selectors since list isn't
    hashable. Returns a fresh dict copy per call so callers can mutate
    without poisoning the cache.
    """
    cached = _selector_to_u2_kwargs_cached(tuple(selectors))
    if cached is None:
        return None
    return dict(cached)


@functools.lru_cache(maxsize=256)
def _selector_to_u2_kwargs_cached(selectors: tuple[str, ...]) -> tuple[tuple[str, object], ...] | None:
    """Inner memoised core. Returns sorted tuple-of-pairs (hashable +
    cache-friendly); caller in `_selector_to_u2_kwargs` rebuilds a dict
    so mutations don't leak between calls."""
    result = _selector_to_u2_kwargs_uncached(list(selectors))
    if result is None:
        return None
    return tuple(sorted(result.items()))


def _selector_to_u2_kwargs_uncached(selectors: list[str]) -> dict | None:
    out: dict = {}
    for raw in selectors:
        clause = raw.strip()
        if not clause:
            continue
        # text~"..."
        if clause.startswith('text~"') and clause.endswith('"'):
            out["textContains"] = clause[6:-1]
        elif clause.startswith('text="') and clause.endswith('"'):
            out["text"] = clause[6:-1]
        elif clause.startswith('desc~"') and clause.endswith('"'):
            out["descriptionContains"] = clause[6:-1]
        elif clause.startswith('desc="') and clause.endswith('"'):
            out["description"] = clause[6:-1]
        elif clause.startswith("id~"):
            # Substring match against the full resource-id; covers both
            # `id~"login"` for `com.x:id/login_btn` and arbitrary fragments.
            v = clause[3:].strip().strip('"')
            out["resourceIdMatches"] = rf".*{re.escape(v)}.*"
        elif clause.startswith("id="):
            rid = clause[3:]
            if ":id/" in rid:
                out["resourceId"] = rid
            else:
                out["resourceIdMatches"] = rf".*:id/{re.escape(rid)}$"
        elif clause.startswith("class~"):
            v = clause[6:].strip().strip('"')
            out["classNameMatches"] = rf".*{re.escape(v)}.*"
        elif clause.startswith("class="):
            cls = clause[6:]
            if "." in cls:
                out["className"] = cls
            else:
                out["classNameMatches"] = rf".*\.{re.escape(cls)}$"
        elif clause == "clickable=true":
            out["clickable"] = True
        elif clause == "clickable=false":
            out["clickable"] = False
        elif clause == "focused=true":
            out["focused"] = True
        elif clause == "focused=false":
            out["focused"] = False
        else:
            return None
    return out or None


def _u2_native_act(
    serial: str | None,
    target: str,
    op: str,
    timeout: float,
    *,
    text: str | None = None,
) -> int | None:
    """Single-round-trip tap/type via u2's on-device agent.

    Returns:
      0  on success.
      1  on failure that is final (target genuinely not present after
         timeout; selector mapping rejected) — caller should NOT fall back.
      None when we cannot even attempt (u2 unimportable, connection
        refused, RemoteDisconnected, mapping unsupported) — caller falls
        back to the XML-dump path.

    op: 'click' | 'type'. For 'type', `text` is the string to set.

    Notes: skips the two-consecutive-dump stability check we hand-roll in
    the XML path. u2's selector resolve uses the on-device accessibility
    tree, which already coalesces mid-frame events; mid-animation
    mis-resolves are rare and the cost-benefit favours speed.
    """
    if is_uid(target):
        return None
    selectors = [s.strip() for s in target.split(",") if s.strip()]
    kwargs = _selector_to_u2_kwargs(selectors)
    if kwargs is None:
        return None
    try:
        import uiautomator2 as u2  # type: ignore
    except ImportError:
        return None

    # u2 across CLI invocations is wobbly: jsonrpc occasionally returns
    # RemoteDisconnected on the first call after a socket idle. One quick
    # reconnect-and-retry covers that without hiding real failures.
    last_exc: Exception | None = None
    for attempt in (0, 1):
        try:
            d = u2.connect(serial) if serial else u2.connect()
            sel = d(**kwargs)
            if not sel.exists(timeout=timeout):
                # Real "not found" — caller should not fall back. But the
                # XML path may have richer pre-query diagnostics, so mark
                # this as fall-through-able the first time we see it.
                return None if attempt == 0 else 1
            if op == "click":
                sel.click()
                return 0
            if op == "type":
                if text is None:
                    return None
                sel.click()
                # set_text replaces existing content; clear/replace is a
                # single agent call rather than the Ctrl+A+DEL chain.
                sel.set_text(text)
                return 0
            return None
        except Exception as e:
            last_exc = e
            # Retry once on transient transport errors.
            msg = str(e)
            if "RemoteDisconnected" in msg or "Connection refused" in msg or "Broken pipe" in msg:
                continue
            sys.stderr.write(f"ui_act: u2 native {op} failed ({e}); falling back to XML path\n")
            return None
    if last_exc is not None:
        sys.stderr.write(
            f"ui_act: u2 native {op} failed after retry ({last_exc}); falling back to XML path\n"
        )
    return None


def _u2_send_keys(serial: str | None, text: str) -> int:
    """Type via uiautomator2's send_keys. Goes through the device-side
    accessibility agent and handles Unicode (emoji, accents, CJK) that the
    raw `input text` command silently drops.

    Returns 0 on success, non-zero on failure. Caller is responsible for
    invalidating the uid sidecar after a successful call.
    """
    try:
        import uiautomator2 as u2  # type: ignore
    except ImportError:
        sys.stderr.write(
            "ui_act: uiautomator2 not importable; cannot type non-ASCII text. "
            "Install with `${CLAUDE_SKILL_DIR}/scripts/install_u2.sh` or use "
            "ASCII-only text with --backend raw.\n"
        )
        return 1
    try:
        d = u2.connect(serial) if serial else u2.connect()
        d.send_keys(text, clear=False)
        return 0
    except Exception as e:
        sys.stderr.write(f"ui_act: u2 send_keys failed: {e}\n")
        return 1


def type_text(serial: str | None, text: str, *, backend: str = "auto") -> int:
    """Type `text` into the focused field.

    Routing:
      - ASCII text -> raw `adb shell input text` (fast, no deps).
      - non-ASCII text + backend in {auto, u2} -> u2 `send_keys` (handles
        Unicode correctly via the device accessibility agent).
      - non-ASCII text + backend == 'raw' -> fail-closed; raw `input text`
        silently corrupts non-ASCII to '?'.
    """
    if not text.isascii():
        if backend == "raw":
            sys.stderr.write(
                "ui_act: text contains non-ASCII characters; "
                "the raw `adb shell input text` backend cannot type these "
                "(silently substitutes '?'). Use --backend u2 (or auto) and "
                "ensure uiautomator2 is installed.\n"
            )
            return 1
        rc = _u2_send_keys(serial, text)
        if rc == 0:
            ui_snapshot.invalidate_meta_sidecar(serial)
        return rc

    # ASCII fast path: raw `input text`. `%s` is interpreted as space on
    # device, so we replace literal spaces with `%s` so the command line
    # doesn't break them up before reaching `input`.
    payload = text.replace(" ", "%s")
    r = adb(serial, "shell", "input", "text", payload)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", errors="replace"))
    else:
        ui_snapshot.invalidate_meta_sidecar(serial)
    return r.returncode


def keyevent(serial: str | None, code: str) -> int:
    r = adb(serial, "shell", "input", "keyevent", code)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", errors="replace"))
    else:
        ui_snapshot.invalidate_meta_sidecar(serial)
    return r.returncode


def is_uid(target: str) -> bool:
    return target.startswith("u") and target[1:].isdigit()


def resolve_tap_target(
    serial: str | None,
    target: str,
    timeout: float,
    *,
    compressed: bool = True,
    require_stable: bool = True,
    backend: str = "auto",
) -> ui_snapshot.Node:
    """Resolve a tap target.

    For uid form: read from the cached snapshot. uids are only meaningful
    inside a single snapshot, so a fresh dump would re-number them.

    For selector form: ALWAYS dump fresh (codex finding 2 — first lookup
    using cache could resolve against the previous screen after a
    UI-mutating action). When `require_stable` is true, also require that
    the target appears at the same bounds in two consecutive fresh dumps —
    this defeats mid-animation false hits.
    """
    deadline = time.monotonic() + max(0.0, timeout)
    uid_form = is_uid(target)

    if uid_form:
        # uid lookup: read the sidecar written by ui_snapshot.py, which
        # captures the EXACT printed uid -> bounds map (post-filter, post-cap).
        # Do NOT re-dump XML — that would renumber uids. On any mismatch,
        # fail-closed and instruct the caller to re-snapshot or use a selector.
        sidecar = ui_snapshot.load_meta_sidecar(serial)
        if not sidecar:
            raise SystemExit(
                f"ui_act: no uid sidecar for {target!r}. "
                "Run scripts/ui_snapshot.py first, or use a selector instead."
            )
        header, records = sidecar
        if header.get("cache_version") != ui_snapshot.CACHE_VERSION:
            raise SystemExit(
                f"ui_act: uid sidecar version mismatch (have {header.get('cache_version')!r}, "
                f"need {ui_snapshot.CACHE_VERSION!r}). Re-run scripts/ui_snapshot.py."
            )
        # Fix 3: prefer the daemon's cached window-sig (single UDS round-
        # trip, ~1 ms when cache hits) over the direct dumpsys-twice path
        # (~50-80 ms). Falls back transparently when daemon unavailable.
        _cached = _daemon_window_sig(serial)
        if _cached is not None:
            cur_sig, _rot = _cached
        else:
            cur_sig, _rot = ui_snapshot.compute_window_sig(serial)
        if cur_sig == ui_snapshot.SIG_UNAVAILABLE:
            raise SystemExit(
                f"ui_act: cannot read device window state to validate uid {target!r}. "
                "Re-run scripts/ui_snapshot.py or use a selector."
            )
        if header.get("window_sig_hash") != cur_sig:
            raise SystemExit(
                f"ui_act: window changed since snapshot (sig mismatch). "
                f"Re-run scripts/ui_snapshot.py or use a selector. target={target!r}"
            )
        try:
            created_ms = int(header.get("created_ms", "0"))
        except (TypeError, ValueError):
            created_ms = 0
        age_ms = int(time.time() * 1000) - created_ms
        ttl_raw = os.environ.get("ANDROID_SKILL_UID_TTL_MS", "15000")
        try:
            ttl_ms = max(0, int(ttl_raw))
        except (TypeError, ValueError):
            sys.stderr.write(
                f"ui_act: ANDROID_SKILL_UID_TTL_MS={ttl_raw!r} is not an int; using 15000\n"
            )
            ttl_ms = 15000
        if age_ms > ttl_ms:
            raise SystemExit(
                f"ui_act: uid sidecar expired ({age_ms}ms > {ttl_ms}ms). "
                "Re-run scripts/ui_snapshot.py."
            )
        rec = next((r for r in records if r.get("uid") == target), None)
        if not rec:
            avail = [r.get("uid") for r in records[:12] if r.get("uid")]
            raise SystemExit(
                f"ui_act: uid {target!r} not in sidecar. Available: {avail}"
            )
        cx_raw, cy_raw = rec.get("cx"), rec.get("cy")
        if cx_raw is None or cy_raw is None:
            raise SystemExit(
                f"ui_act: uid {target!r} has invalid bounds in sidecar "
                f"(cx={cx_raw!r}, cy={cy_raw!r}). Re-run scripts/ui_snapshot.py."
            )
        try:
            cx = int(cx_raw)
            cy = int(cy_raw)
        except (TypeError, ValueError):
            raise SystemExit(
                f"ui_act: uid {target!r} has invalid bounds in sidecar "
                f"(cx={cx_raw!r}, cy={cy_raw!r}). Re-run scripts/ui_snapshot.py."
            )
        # Construct a Node-like object that the caller can read like the
        # existing nodes-from-XML path (caller computes (x1+x2)//2 = cx).
        return ui_snapshot.Node(
            uid=rec.get("uid", target),
            cls=rec.get("cls", ""),
            text=rec.get("text", ""),
            desc=rec.get("desc", ""),
            rid=rec.get("rid", ""),
            bounds=(cx, cy, cx, cy),
            clickable=bool(rec.get("clickable", False)),
            focused=bool(rec.get("focused", False)),
        )

    # Selector form: always fresh.
    prev_sig: tuple | None = None
    while True:
        nodes = load_snapshot(serial, force_dump=True, compressed=compressed, backend=backend)
        n = find_target(nodes, target)
        if n is not None and n.bounds is not None:
            sig = (n.text, n.desc, n.rid, n.bounds)
            if not require_stable or sig == prev_sig:
                return n
            prev_sig = sig
        if time.monotonic() >= deadline:
            if n is not None and n.bounds is not None:
                # Found but never matched the prior dump within the timeout —
                # accept the latest hit rather than failing outright.
                sys.stderr.write(
                    f"ui_act: target {target!r} unstable across dumps; "
                    "tapping latest position anyway.\n"
                )
                return n
            raise SystemExit(f"ui_act: target not found: {target!r}")
        time.sleep(0.12)


def wait_for_post_action(
    serial: str | None,
    *,
    wait_for: list[str] | None,
    wait_stable_ms: int,
    timeout_ms: int,
    compressed: bool = True,
    fail_on_timeout: bool = False,
    backend: str = "auto",
) -> None:
    """After an action, block until the next state is observable. Strategy:

    1. --wait-for SELECTOR: re-dump until selector matches (or disappears for
       `!selector` form — not implemented in v1).
    2. --wait-stable-ms: re-dump until two byte-equal dumps `wait_stable_ms`
       apart confirm the UI has settled.
    3. neither: return immediately.

    Caller bounds the wait by `timeout_ms`.
    """
    # NOTE: sidecar invalidation now happens inside the mutating primitives
    # (tap_at/type_text/keyevent) so it lands BEFORE any --post-wait-ms sleep
    # and before a possibly-failing follow-up call (e.g. clear keyevents
    # before `input text`). See codex review HIGH 1 / MEDIUM 3.
    if not wait_for and wait_stable_ms <= 0:
        return
    deadline = time.monotonic() + (timeout_ms / 1000.0)

    def _dump() -> bytes:
        xml, sz = ui_snapshot.run_adb_dump(serial, compressed=compressed, backend=backend)
        ui_snapshot.set_screen_size(serial, sz)
        return xml

    if wait_for:
        # Same positive/negative split as ui_snapshot.acquire_xml: '!sel' at
        # the wait level means 'no node in the tree matches' (spinner gone).
        pos_selectors = [s for s in wait_for if not s.startswith("!")]
        neg_clauses = [s[1:].lstrip() for s in wait_for if s.startswith("!")]
        while True:
            xml = _dump()
            try:
                root = ui_snapshot.build_tree(xml)
                screen = ui_snapshot.get_screen_size(serial)
                pruned = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
                pos_ok = (not pos_selectors) or any(
                    ui_snapshot.selector_match(n, pos_selectors) for n in pruned
                )
                neg_ok = all(
                    not any(ui_snapshot._match_clause(n, c) for n in pruned)
                    for c in neg_clauses
                )
                if pos_ok and neg_ok:
                    cache = Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-{serial or 'default'}.xml"
                    cache.write_bytes(xml)
                    return
            except SystemExit:
                pass
            if time.monotonic() >= deadline:
                sys.stderr.write(
                    f"ui_act: --wait-for {wait_for} timed out after {timeout_ms}ms\n"
                )
                if fail_on_timeout:
                    raise SystemExit(124)
                return
            time.sleep(0.15)

    # wait-stable path
    prev = _dump()
    while True:
        time.sleep(wait_stable_ms / 1000.0)
        cur = _dump()
        if cur == prev:
            cache = Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-{serial or 'default'}.xml"
            cache.write_bytes(cur)
            return
        prev = cur
        if time.monotonic() >= deadline:
            sys.stderr.write(
                f"ui_act: UI did not settle within {timeout_ms}ms\n"
            )
            if fail_on_timeout:
                raise SystemExit(124)
            return


def wait_until_focused(
    serial: str | None,
    target: str,
    timeout_ms: int,
    *,
    compressed: bool = True,
    backend: str = "auto",
) -> bool:
    """Poll until the target's `focused` attribute is true. Used by `type` to
    know the field has actually accepted focus before sending text — replaces
    the old fixed 200ms sleep, which was both too short on cold paths and too
    long on warm ones."""
    if is_uid(target):
        # Can't validate focused state for a uid (cached, stale on next dump).
        return False
    deadline = time.monotonic() + (timeout_ms / 1000.0)
    selector = [s.strip() for s in target.split(",") if s.strip()]
    while True:
        nodes = load_snapshot(serial, force_dump=True, compressed=compressed, backend=backend)
        for n in nodes:
            if ui_snapshot.selector_match(n, selector) and n.focused:
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.08)


def parse_args() -> argparse.Namespace:
    # Shared flags via parents=[shared] so they work on either side of the
    # subcommand: `ui_act.py --wait-for X tap T` and `ui_act.py tap T --wait-for X`
    # both parse the same way.
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--serial", help="adb device serial")
    shared.add_argument("--timeout", type=float, default=5.0,
                        help="seconds to keep re-dumping while waiting for target (default 5)")
    shared.add_argument("--wait-for", action="append", default=[],
                        help='after the action, poll dumps until this selector matches. '
                             'Most reliable sync. Repeatable (AND).')
    shared.add_argument("--wait-stable-ms", type=int, default=0,
                        help="after the action, poll until two dumps N ms apart are byte-identical")
    shared.add_argument("--post-wait-ms", type=int, default=0,
                        help="crude fixed sleep after the action; prefer --wait-for")
    shared.add_argument("--no-compressed", action="store_true",
                        help="disable `uiautomator dump --compressed`")
    shared.add_argument("--no-stable-resolve", action="store_true",
                        help="skip the two-consecutive-dumps stability check on selector targets")
    shared.add_argument("--fail-on-timeout", action="store_true",
                        help="exit 124 when --wait-for / --wait-stable-ms times out (for triage scripts)")
    shared.add_argument("--backend", default="auto", choices=["auto", "u2", "raw"],
                        help="UI backend for snapshot/poll. auto: prefer u2 if available.")

    p = argparse.ArgumentParser(
        description="Tap / type / key on Android via adb.",
        parents=[shared],
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    tap = sub.add_parser("tap", help="tap a uid or selector", parents=[shared])
    tap.add_argument("target")
    tap_pt = sub.add_parser("tap-point", help="tap raw screen coordinates (no snapshot lookup)", parents=[shared])
    tap_pt.add_argument("x", type=int)
    tap_pt.add_argument("y", type=int)
    typ = sub.add_parser("type", help="focus a uid/selector then type text", parents=[shared])
    typ.add_argument("target")
    typ.add_argument("text")
    typ.add_argument("--clear", action="store_true",
                     help="clear the field before typing")
    typ.add_argument("--clear-method", default="auto",
                     choices=["auto", "select-all", "del-loop"],
                     help="auto: try Ctrl+A+DEL (Android 11+), fall back to del-loop. "
                          "select-all: force keycombination 113 29 + DEL. "
                          "del-loop: legacy KEYCODE_MOVE_END + DEL×N (default 500-cap).")
    typ.add_argument("--clear-max", type=int, default=500,
                     help="cap on DEL keystrokes for del-loop method (default 500)")
    key = sub.add_parser("key", help="send a key event by name (e.g. KEYCODE_ENTER)", parents=[shared])
    key.add_argument("code")
    sub.add_parser("back", help="shortcut for key KEYCODE_BACK", parents=[shared])
    sub.add_parser("home", help="shortcut for key KEYCODE_HOME", parents=[shared])
    return p.parse_args()


def main() -> int:
    args = parse_args()
    serial = ui_snapshot.resolve_serial(args.serial)
    compressed = not args.no_compressed
    timeout_ms = int(args.timeout * 1000)

    # Argparse + parents=[shared] gotcha: when --backend is given BEFORE the
    # subcommand, the subparser's `default="auto"` re-overwrites it on the
    # final Namespace. Recover the user's intent by scanning sys.argv.
    for i, tok in enumerate(sys.argv[1:], start=1):
        if tok == "--backend" and i + 1 < len(sys.argv):
            cand = sys.argv[i + 1]
            if cand in ("auto", "u2", "raw"):
                args.backend = cand
        elif tok.startswith("--backend="):
            cand = tok.split("=", 1)[1]
            if cand in ("auto", "u2", "raw"):
                args.backend = cand

    def _post_sync() -> None:
        if args.post_wait_ms:
            time.sleep(args.post_wait_ms / 1000.0)
        wait_for_post_action(
            serial,
            wait_for=args.wait_for or None,
            wait_stable_ms=args.wait_stable_ms,
            timeout_ms=timeout_ms,
            compressed=compressed,
            fail_on_timeout=args.fail_on_timeout,
            backend=args.backend,
        )

    if args.cmd == "tap":
        # Daemon thin-client first: warm u2 connection, no per-call connect
        # cost. Pass post-sync vocabulary so the daemon does the wait
        # in-process — eliminates the client-side dump-loop tax.
        if args.backend in ("auto", "u2") and not is_uid(args.target):
            d_resp = _daemon_request(serial, "tap", {
                "target": args.target, "timeout": args.timeout,
                "post_wait_ms": args.post_wait_ms,
                "wait_for": args.wait_for or None,
                "wait_stable_ms": args.wait_stable_ms,
                "timeout_ms": timeout_ms,
                "fail_on_timeout": args.fail_on_timeout,
            })
            if d_resp is not None:
                rc, out, err, post_handled = d_resp
                if out:
                    sys.stderr.write(out)
                if err:
                    sys.stderr.write(err)
                if rc == 0 and not post_handled:
                    _post_sync()
                return rc

        # Direct u2-native fast path (no daemon): skips the XML dump +
        # selector resolve for selector-form targets when u2 is reachable.
        # Falls back to XML on transport error or unsupported selector clauses.
        if args.backend in ("auto", "u2"):
            fast_rc = _u2_native_act(serial, args.target, "click", args.timeout)
            if fast_rc is not None:
                if fast_rc == 0:
                    print(f"tap {args.target} (u2-native)", file=sys.stderr)
                    ui_snapshot.invalidate_meta_sidecar(serial)
                    _post_sync()
                return fast_rc

        n = resolve_tap_target(
            serial, args.target, args.timeout,
            compressed=compressed,
            require_stable=not args.no_stable_resolve,
            backend=args.backend,
        )
        x1, y1, x2, y2 = n.bounds  # type: ignore[misc]
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        print(f"tap {n.uid or args.target} @ {cx},{cy}", file=sys.stderr)
        rc = tap_at(serial, cx, cy)
        if rc == 0:
            _post_sync()
        return rc

    if args.cmd == "tap-point":
        rc = tap_at(serial, args.x, args.y)
        if rc == 0:
            _post_sync()
        return rc

    if args.cmd == "type":
        # Daemon thin-client first. Daemon's set_text replaces the field
        # in one round-trip, handles --clear implicitly, and runs the
        # post-sync (wait_for/wait_stable_ms) in-process.
        if (
            args.backend in ("auto", "u2")
            and args.clear_method == "auto"
            and not is_uid(args.target)
        ):
            d_resp = _daemon_request(serial, "type", {
                "target": args.target, "text": args.text, "timeout": args.timeout,
                "post_wait_ms": args.post_wait_ms,
                "wait_for": args.wait_for or None,
                "wait_stable_ms": args.wait_stable_ms,
                "timeout_ms": timeout_ms,
                "fail_on_timeout": args.fail_on_timeout,
            })
            if d_resp is not None:
                rc, out, err, post_handled = d_resp
                if out:
                    sys.stderr.write(out)
                if err:
                    sys.stderr.write(err)
                if rc == 0 and not post_handled:
                    _post_sync()
                return rc

        # Direct u2-native fast path (no daemon): u2's set_text() replaces
        # the field's content in one round-trip — handles `--clear` implicitly
        # without our Ctrl+A+DEL chain. Skipped when --clear-method is forced
        # (user wants the explicit method).
        if (
            args.backend in ("auto", "u2")
            and args.clear_method == "auto"
        ):
            fast_rc = _u2_native_act(
                serial, args.target, "type", args.timeout, text=args.text
            )
            if fast_rc is not None:
                if fast_rc == 0:
                    print(f"type {args.target} (u2-native)", file=sys.stderr)
                    ui_snapshot.invalidate_meta_sidecar(serial)
                    _post_sync()
                return fast_rc

        n = resolve_tap_target(
            serial, args.target, args.timeout,
            compressed=compressed,
            require_stable=not args.no_stable_resolve,
            backend=args.backend,
        )
        x1, y1, x2, y2 = n.bounds  # type: ignore[misc]
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        rc = tap_at(serial, cx, cy)
        if rc != 0:
            return rc

        # Replace fixed 200ms focus sleep with poll on the `focused` attribute.
        # Falls back to a short floor (120ms) when the field is a uid (cached
        # snapshot can't validate focus state) or when polling timed out — many
        # IMEs accept input even before reporting focused=true.
        if not is_uid(args.target):
            if not wait_until_focused(serial, args.target, timeout_ms=1500, compressed=compressed, backend=args.backend):
                time.sleep(0.12)
        else:
            time.sleep(0.12)

        if args.clear:
            # Two strategies. Ctrl+A + DEL is two adb calls regardless of field
            # length, on Android 11+ where `input keycombination` exists.
            # Pre-Android-11 it silently no-ops, leaving the field unchanged;
            # the auto path detects this by re-reading the field afterwards
            # and falls back to DEL × N if nothing changed.
            method = args.clear_method
            cur_len = len(n.text or "")

            def _select_all_then_del() -> bool:
                """Returns True iff Ctrl+A + DEL appears to have cleared."""
                # 113 = KEYCODE_CTRL_LEFT, 29 = KEYCODE_A
                r = adb(serial, "shell", "input", "keycombination", "113", "29")
                if r.returncode != 0:
                    return False
                time.sleep(0.08)
                keyevent(serial, "KEYCODE_DEL")
                time.sleep(0.15)
                # Verify by re-dumping (only when we have a selector form;
                # uid form can't validate post-clear).
                if is_uid(args.target):
                    return True  # assume success — no way to validate
                try:
                    nodes2 = load_snapshot(serial, force_dump=True, compressed=compressed, backend=args.backend)
                    n2 = find_target(nodes2, args.target)
                    if n2 is not None and not (n2.text or ""):
                        return True
                except SystemExit:
                    pass
                return False

            def _del_loop() -> None:
                if cur_len > args.clear_max:
                    sys.stderr.write(
                        f"ui_act: --clear (del-loop): field length {cur_len} > "
                        f"--clear-max {args.clear_max}; clearing trailing "
                        f"{args.clear_max} chars only.\n"
                    )
                effective = min(cur_len, args.clear_max) if cur_len > 0 else 0
                if effective == 0:
                    return
                keyevent(serial, "KEYCODE_MOVE_END")
                # Batch DEL × N into one input keyevent call (Android 7+).
                batch = ["KEYCODE_DEL"] * effective
                r = adb(serial, "shell", "input", "keyevent", *batch)
                if r.returncode != 0:
                    for _ in range(effective):
                        keyevent(serial, "KEYCODE_DEL")

            if method == "del-loop":
                _del_loop()
            elif method == "select-all":
                if not _select_all_then_del():
                    sys.stderr.write(
                        "ui_act: --clear-method=select-all reports no change; "
                        "either Android <11 or hardware keyboard not plumbed.\n"
                    )
            else:  # auto
                if not _select_all_then_del():
                    _del_loop()

        rc = type_text(serial, args.text, backend=args.backend)
        if rc == 0:
            _post_sync()
        return rc

    def _route_key(code: str) -> int:
        # Daemon thin-client for key events when on u2 backend. Same
        # post-sync vocabulary as tap/type so a follow-up `--wait-for`
        # runs in the warm daemon, not in a client dump loop.
        if args.backend in ("auto", "u2"):
            d_resp = _daemon_request(serial, "key", {
                "code": code,
                "post_wait_ms": args.post_wait_ms,
                "wait_for": args.wait_for or None,
                "wait_stable_ms": args.wait_stable_ms,
                "timeout_ms": timeout_ms,
                "fail_on_timeout": args.fail_on_timeout,
            })
            if d_resp is not None:
                rc, out, err, post_handled = d_resp
                if out:
                    sys.stderr.write(out)
                if err:
                    sys.stderr.write(err)
                if rc == 0 and not post_handled:
                    _post_sync()
                return rc
        rc = keyevent(serial, code)
        if rc == 0:
            _post_sync()
        return rc

    if args.cmd == "key":
        return _route_key(args.code)
    if args.cmd == "back":
        return _route_key("KEYCODE_BACK")
    if args.cmd == "home":
        return _route_key("KEYCODE_HOME")

    return 64  # unreachable


if __name__ == "__main__":
    sys.exit(main())
