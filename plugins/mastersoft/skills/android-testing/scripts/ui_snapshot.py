#!/usr/bin/env python3
"""
ui_snapshot.py — dump the on-screen view hierarchy as a compact text listing.

Pipeline:
  1. adb -s <serial> shell uiautomator dump /sdcard/window_dump.xml
  2. adb -s <serial> exec-out cat /sdcard/window_dump.xml   (portable stdout path)
  3. Parse XML; assign stable per-call uids (u1, u2, ...).
  4. Prune nodes that carry no identifying attribute and no useful children.
  5. Emit one line per surviving node.

Output line format:
    [uid]  Class  text="..."  desc="..."  id=...  b=cx,cy

`b=cx,cy` is the centre point of the node's bounds rectangle, not the rectangle
itself. ui_act.py reads this to issue `adb shell input tap`. Use
--include-bounds=false to strip bounds when only reading state.

The pruner keeps a node when ANY of:
  - text is non-empty
  - content-desc is non-empty
  - resource-id is non-empty
  - clickable=true (and the node has at least one of the above OR a kept descendant)
  - it has at least one kept descendant (then it is rendered as a path in
    --expand mode, otherwise collapsed)

Cache:
  The raw XML is cached at $TMPDIR/android-skill-<serial>.xml so ui_act.py
  can resolve uids without re-dumping. Pass --no-cache to skip.

Selectors recognised by --query:
  text="..."        exact match against the @text attribute
  text~"..."        substring (case-insensitive) match
  desc="..."        exact match against @content-desc
  desc~"..."        substring match
  id=...            exact match against @resource-id (full or short form)
  class=...         exact match against @class (full or short form)
  uid=u3            match by previously-assigned uid (only meaningful if you
                    already had a snapshot; here it's a no-op since uids are
                    assigned post-prune for this call)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

DEVICE_DUMP_PATH = "/sdcard/window_dump.xml"


def find_adb() -> str:
    """Return a usable adb path. Prefer one on $PATH; otherwise probe common
    Android SDK locations so the skill works on a stock macOS without the
    SDK on PATH."""
    from shutil import which

    found = which("adb")
    if found:
        return found
    candidates = [
        os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb"),
        os.path.join(os.environ.get("ANDROID_SDK_ROOT", ""), "platform-tools", "adb"),
        os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
        os.path.expanduser("~/Android/Sdk/platform-tools/adb"),
        "/usr/local/opt/android-platform-tools/bin/adb",
        "/opt/homebrew/bin/adb",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    raise SystemExit("ui_snapshot: adb not found on PATH or in common SDK paths")


_ADB_BIN: str | None = None


def adb_bin() -> str:
    global _ADB_BIN
    if _ADB_BIN is None:
        _ADB_BIN = find_adb()
    return _ADB_BIN


def get_foreground_activity(serial: str | None) -> str:
    """Best-effort current top resumed activity, for empty-result diagnostics."""
    cmd = [adb_bin()]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell", "dumpsys", "activity", "activities"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=5).stdout.decode("utf-8", errors="replace")
        for line in out.splitlines():
            if "topResumedActivity" in line or "ResumedActivity" in line:
                return line.strip()
    except Exception:
        pass
    return "<unknown>"


@dataclass
class Node:
    uid: str = ""
    cls: str = ""
    text: str = ""
    desc: str = ""
    rid: str = ""
    bounds: tuple[int, int, int, int] | None = None
    clickable: bool = False
    enabled: bool = True
    focused: bool = False
    children: list["Node"] = field(default_factory=list)
    parent: "Node | None" = None

    def has_any_id(self) -> bool:
        return bool(self.text or self.desc or self.rid)


_BOUNDS_RE = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def parse_bounds(s: str) -> tuple[int, int, int, int] | None:
    m = _BOUNDS_RE.match(s or "")
    if not m:
        return None
    return tuple(int(g) for g in m.groups())  # type: ignore[return-value]


def short_class(fqn: str) -> str:
    if not fqn:
        return ""
    return fqn.rsplit(".", 1)[-1]


def short_id(rid: str) -> str:
    if not rid:
        return ""
    if ":" in rid:
        pkg, short = rid.split(":id/", 1) if ":id/" in rid else (rid, "")
        return short or rid
    return rid


_DUMP_SENTINEL = b"__ANDROID_SKILL_XML__\n"


def _u2_available() -> bool:
    """True iff the uiautomator2 lib is importable. Does NOT check whether
    atx-agent is running on the target device — that's per-device state and
    handled at connect time."""
    try:
        import uiautomator2  # noqa: F401
        return True
    except ImportError:
        return False


_U2_DEVICES: dict[str | None, object] = {}
# Fix 4: per-serial lock guarding u2 calls. Daemon injects its own lock
# via set_u2_device_handle so BG-refresh dumps and tap/type ops can't
# race on the same TCP session.
import threading as _threading  # local alias to avoid touching top imports
_U2_LOCKS: dict[str | None, "_threading.Lock"] = {}


def _u2_lock_for(serial: str | None) -> "_threading.Lock":
    lock = _U2_LOCKS.get(serial)
    if lock is None:
        lock = _threading.Lock()
        _U2_LOCKS[serial] = lock
    return lock


def set_u2_device_handle(serial: str | None, device: object | None,
                          lock: "_threading.Lock | None" = None) -> None:
    """Inject a warm u2.Device handle from the daemon so ui_snapshot
    reuses the same TCP session instead of opening a second one.

    `lock` should be the daemon's `_u2_lock`; ui_snapshot will acquire
    it around its own u2 calls so the daemon's tap/type and ui_snapshot's
    dumps don't interleave on the same jsonrpc HTTP session. Pass None
    to drop the cached handle (e.g. after a transport error).
    """
    if device is None:
        _U2_DEVICES.pop(serial, None)
        return
    _U2_DEVICES[serial] = device
    if lock is not None:
        _U2_LOCKS[serial] = lock


def _u2_dump(
    serial: str | None,
    compressed: bool = True,
    fetch_screen: bool = True,
) -> tuple[bytes, tuple[int, int] | None]:
    """Dump via uiautomator2 (persistent atx-agent on device).

    Faster than raw `adb shell uiautomator dump` because the on-device
    server stays warm. First call still pays a connect cost; subsequent
    calls in the same process amortize.

    Fix 4: serialised through `_U2_LOCKS[serial]` when the daemon has
    injected its own lock — prevents BG-refresh dumps from racing the
    daemon's tap/type calls on the same u2 jsonrpc session.
    """
    import uiautomator2 as u2  # type: ignore[import-not-found]

    if serial not in _U2_DEVICES:
        _U2_DEVICES[serial] = u2.connect(serial) if serial else u2.connect()

    lock = _u2_lock_for(serial)
    sz: tuple[int, int] | None = None
    with lock:
        d = _U2_DEVICES[serial]
        xml_str: str = d.dump_hierarchy(compressed=compressed)  # type: ignore[attr-defined]
        if fetch_screen:
            try:
                info = d.info  # type: ignore[attr-defined]
                sz = (int(info["displayWidth"]), int(info["displayHeight"]))
            except Exception:
                sz = None
    return xml_str.encode("utf-8"), sz


def run_adb_dump(
    serial: str | None,
    dump_to_stdout: bool = True,
    compressed: bool = True,
    fetch_screen: bool = True,
    backend: str = "auto",
) -> tuple[bytes, tuple[int, int] | None]:
    """Single-RTT dump: combine `wm size` and `uiautomator dump` + cat into one
    `adb exec-out sh -c '...'` invocation. Returns (xml_bytes, screen_size).

    Why: each adb command pays a connection-handshake cost (tens of ms over
    USB, ~5–15 ms over loopback to an emulator). The previous implementation
    issued three calls (`uiautomator dump`, `exec-out cat`, `wm size`) — this
    version issues exactly one.

    `--compressed` is supported by AOSP `uiautomator dump` since Jelly Bean
    MR2; modern devices accept it. Falls back to non-compressed automatically
    if the device returns an "Unknown option" line.

    backend: "auto" tries uiautomator2 (persistent on-device agent) when the
    Python lib is importable, else falls back to raw `adb`. "u2" forces the
    Python path; "raw" forces the adb-shell path.
    """
    if backend == "auto":
        backend = "u2" if _u2_available() else "raw"

    if backend == "u2":
        try:
            return _u2_dump(serial, compressed=compressed, fetch_screen=fetch_screen)
        except Exception as e:  # connect/atx-agent errors fall back to raw.
            sys.stderr.write(f"ui_snapshot: u2 backend failed ({e}); falling back to raw adb\n")
            backend = "raw"

    cmd = [adb_bin()]
    if serial:
        cmd += ["-s", serial]

    dump_arg = "--compressed " if compressed else ""
    parts: list[str] = []
    if fetch_screen:
        parts.append("wm size 2>/dev/null || true")
    parts.append(f"echo '{_DUMP_SENTINEL.rstrip().decode()}'")
    parts.append(
        f"uiautomator dump {dump_arg}{DEVICE_DUMP_PATH} >/dev/null 2>&1 && "
        f"cat {DEVICE_DUMP_PATH}"
    )
    shell_pipe = "; ".join(parts)
    full_cmd = cmd + ["exec-out", "sh", "-c", shell_pipe]

    r = subprocess.run(full_cmd, capture_output=True, timeout=15)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"ui_snapshot: dump pipeline failed (rc={r.returncode})")

    out = r.stdout
    screen: tuple[int, int] | None = None
    xml_bytes = out
    if fetch_screen and _DUMP_SENTINEL in out:
        wm_part, _, xml_bytes = out.partition(_DUMP_SENTINEL)
        m = re.search(rb"(\d+)x(\d+)", wm_part)
        if m:
            screen = (int(m.group(1)), int(m.group(2)))

    # Some devices reject `--compressed` silently and write an empty file.
    # Detect and retry once without the flag.
    if compressed and (not xml_bytes.strip() or b"<hierarchy" not in xml_bytes):
        return run_adb_dump(serial, dump_to_stdout, compressed=False, fetch_screen=fetch_screen)

    return xml_bytes, screen


def build_tree(xml_bytes: bytes) -> Node:
    # uiautomator emits <hierarchy>...<node .../></hierarchy>
    try:
        root_xml = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise SystemExit(f"ui_snapshot: XML parse error: {e}")

    root = Node(cls="<root>")

    def walk(xml_node: ET.Element, parent: Node) -> None:
        for child in xml_node:
            if child.tag != "node":
                walk(child, parent)
                continue
            node = Node(
                cls=child.attrib.get("class", ""),
                text=child.attrib.get("text", "") or "",
                desc=child.attrib.get("content-desc", "") or "",
                rid=child.attrib.get("resource-id", "") or "",
                bounds=parse_bounds(child.attrib.get("bounds", "")),
                clickable=child.attrib.get("clickable", "false") == "true",
                enabled=child.attrib.get("enabled", "true") == "true",
                focused=child.attrib.get("focused", "false") == "true",
                parent=parent,
            )
            parent.children.append(node)
            walk(child, node)

    walk(root_xml, root)
    return root


def is_offscreen(n: Node, screen_w: int = 0, screen_h: int = 0) -> bool:
    if n.bounds is None:
        return False
    x1, y1, x2, y2 = n.bounds
    if x2 <= x1 or y2 <= y1:
        return True
    if screen_w and screen_h:
        if x2 < 0 or y2 < 0 or x1 > screen_w or y1 > screen_h:
            return True
    return False


def prune(root: Node, only_clickable: bool, screen_size: tuple[int, int]) -> list[Node]:
    """Walk tree, keep nodes that are tappable / informative.

    Keep rule:
      - has any identifying attribute (text/desc/id), OR
      - is clickable AND has bounds (icon buttons, custom-drawn controls
        without text — these are the bulk of Compose / custom-view UIs).

    Drop offscreen nodes. With --only-clickable, restrict to nodes where
    clickable=true regardless of identifiers."""
    sw, sh = screen_size
    kept: list[Node] = []

    def visit(n: Node) -> None:
        if n.cls != "<root>" and not is_offscreen(n, sw, sh):
            informative = n.has_any_id()
            actionable = n.clickable and n.bounds is not None
            keep = informative or actionable
            if only_clickable:
                keep = actionable
            if keep:
                kept.append(n)
        for c in n.children:
            visit(c)

    visit(root)
    return kept


# Process-wide cache: screen size doesn't change unless the device rotates,
# and even then ui_snapshot is short-lived. ui_act.py also reads this when
# loading a cached snapshot, so caching avoids paying `wm size` per action.
_SCREEN_CACHE: dict[str | None, tuple[int, int]] = {}


def get_screen_size(serial: str | None) -> tuple[int, int]:
    if serial in _SCREEN_CACHE:
        return _SCREEN_CACHE[serial]
    cmd = [adb_bin()]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell", "wm", "size"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=5).stdout.decode()
        m = re.search(r"(\d+)x(\d+)", out)
        if m:
            sz = (int(m.group(1)), int(m.group(2)))
            _SCREEN_CACHE[serial] = sz
            return sz
    except Exception:
        pass
    return (0, 0)


def set_screen_size(serial: str | None, sz: tuple[int, int] | None) -> None:
    if sz is not None:
        _SCREEN_CACHE[serial] = sz


def selector_match(n: Node, selectors: list[str]) -> bool:
    """All selectors must match. Selector grammar — see docstring.

    A selector prefixed with '!' is negated: it matches when the underlying
    clause does NOT match. Useful for `--wait-for '!text="Loading"'` style
    waits. Negation is per-clause, not per-node — `selector_match` still
    returns True only when ALL clauses agree (negated or not).
    """
    for raw in selectors:
        negate = False
        s = raw
        if s.startswith("!"):
            negate = True
            s = s[1:].lstrip()
        if "=" not in s and "~" not in s:
            return False
        clause_matched = _match_clause(n, s)
        if negate:
            if clause_matched:
                return False
            continue
        if not clause_matched:
            return False
    return True


def _match_clause(n: Node, s: str) -> bool:
    """Evaluate a single selector clause against a node. Returns True iff
    the clause matches (caller handles `!` prefix for negation)."""
    if "=" not in s and "~" not in s:
        return False
    if s.startswith("text~"):
        v = s.split("~", 1)[1].strip().strip('"')
        return v.lower() in n.text.lower()
    if s.startswith("text="):
        v = s.split("=", 1)[1].strip().strip('"')
        return n.text == v
    if s.startswith("desc~"):
        v = s.split("~", 1)[1].strip().strip('"')
        return v.lower() in n.desc.lower()
    if s.startswith("desc="):
        v = s.split("=", 1)[1].strip().strip('"')
        return n.desc == v
    if s.startswith("id~"):
        v = s.split("~", 1)[1].strip().strip('"').lower()
        # Match substring against both full and short forms so callers can
        # write `id~"login"` and hit `com.example:id/login_btn`.
        return v in (n.rid or "").lower() or v in short_id(n.rid).lower()
    if s.startswith("id="):
        v = s.split("=", 1)[1].strip().strip('"')
        return n.rid == v or short_id(n.rid) == v
    if s.startswith("class~"):
        v = s.split("~", 1)[1].strip().strip('"').lower()
        return v in (n.cls or "").lower() or v in short_class(n.cls).lower()
    if s.startswith("class="):
        v = s.split("=", 1)[1].strip().strip('"')
        return n.cls == v or short_class(n.cls) == v
    if s.startswith("focused="):
        v = s.split("=", 1)[1].strip().strip('"').lower()
        return n.focused == (v in ("true", "1", "yes"))
    if s.startswith("clickable="):
        v = s.split("=", 1)[1].strip().strip('"').lower()
        return n.clickable == (v in ("true", "1", "yes"))
    return False


def format_node(n: Node, *, include_bounds: bool) -> str:
    parts: list[str] = [f"[{n.uid}]"]
    parts.append(f"{short_class(n.cls):<14}")
    if n.text:
        t = n.text.replace("\n", " ")
        if len(t) > 60:
            t = t[:57] + "..."
        parts.append(f'text="{t}"')
    if n.desc:
        d = n.desc.replace("\n", " ")
        if len(d) > 60:
            d = d[:57] + "..."
        parts.append(f'desc="{d}"')
    if n.rid:
        parts.append(f"id={short_id(n.rid)}")
    if n.clickable:
        parts.append("clickable")
    if include_bounds and n.bounds:
        x1, y1, x2, y2 = n.bounds
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        parts.append(f"b={cx},{cy}")
    return "  ".join(parts)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Dump the on-screen Android view hierarchy as a compact listing.",
    )
    p.add_argument("--serial", help="adb device serial; defaults to device_pick.sh session file or single device")
    p.add_argument("--only-clickable", action="store_true", help="keep only clickable nodes")
    p.add_argument("--query", action="append", default=[],
                   help='filter by selector (e.g. text="Sign in", id=login_btn). Repeatable.')
    p.add_argument("--max-lines", type=int, default=0, help="cap output line count (0 = no cap)")
    p.add_argument("--expand", help="(reserved) show full subtree under a uid; not implemented in v1")
    p.add_argument("--include-bounds", default="true", choices=["true", "false"],
                   help="include centre coords in output (default true)")
    p.add_argument("--include-system-ui", action="store_true",
                   help="(reserved) include nodes from the system UI overlay")
    p.add_argument("--no-cache", action="store_true", help="do not write XML cache file")
    p.add_argument("--cache-dir", default=os.environ.get("TMPDIR", "/tmp"),
                   help="where to cache the raw XML (default $TMPDIR or /tmp)")
    # Sync flags — defeat the accessibility-tree-lag race.
    p.add_argument("--post-wait-ms", type=int, default=0,
                   help="sleep N ms before dumping (crude; prefer --wait-stable or --wait-for)")
    p.add_argument("--wait-stable-ms", type=int, default=0,
                   help="poll until two consecutive dumps N ms apart are byte-identical (UI settled). "
                        "Bounded by --timeout-ms.")
    p.add_argument("--wait-for", action="append", default=[],
                   help='re-dump until at least one node matches this selector. Repeatable (AND).')
    p.add_argument("--timeout-ms", type=int, default=5000,
                   help="upper bound for --wait-stable-ms / --wait-for polling (default 5000)")
    p.add_argument("--no-compressed", action="store_true",
                   help="disable `uiautomator dump --compressed` (use only if device rejects it)")
    p.add_argument("--fail-on-timeout", action="store_true",
                   help="exit 124 when --wait-stable / --wait-for times out (for triage/escalation scripts)")
    p.add_argument("--backend", default="auto", choices=["auto", "u2", "raw"],
                   help="UI backend. auto: prefer uiautomator2 if importable, else raw adb. "
                        "u2: force the Python uiautomator2 path (requires `pip install uiautomator2` "
                        "and atx-agent running on device). raw: force `adb shell uiautomator dump`.")
    return p.parse_args()


def acquire_xml(
    serial: str | None,
    *,
    wait_stable_ms: int = 0,
    wait_for: list[str] | None = None,
    timeout_ms: int = 5000,
    compressed: bool = True,
    only_clickable_for_wait: bool = False,
    fail_on_timeout: bool = False,
    backend: str = "auto",
) -> bytes:
    """Run dumps until the UI is settled per the chosen sync strategy.

    Strategy precedence:
      1. --wait-for: re-dump until at least one node matches every selector.
      2. --wait-stable-ms: re-dump until two dumps `wait_stable_ms` apart are
         byte-identical (UI animation/layout has settled).
      3. neither: single dump, return immediately (legacy behaviour).
    """
    deadline = time.monotonic() + (timeout_ms / 1000.0) if (wait_stable_ms or wait_for) else 0.0

    def _one_dump() -> bytes:
        xml, sz = run_adb_dump(serial, compressed=compressed, backend=backend)
        set_screen_size(serial, sz)
        return xml

    if wait_for:
        last_xml = b""
        # Split positive vs negative selectors. Negative '!sel' at the wait
        # level means "no node in the tree matches this clause" — useful for
        # waiting for a spinner / dialog to go away. Positive selectors keep
        # AND-of-clauses-on-same-node semantics.
        pos_selectors = [s for s in wait_for if not s.startswith("!")]
        neg_clauses = [s[1:].lstrip() for s in wait_for if s.startswith("!")]
        while True:
            last_xml = _one_dump()
            try:
                root = build_tree(last_xml)
                screen = get_screen_size(serial)
                pruned = prune(root, only_clickable=only_clickable_for_wait, screen_size=screen)
                pos_ok = (not pos_selectors) or any(selector_match(n, pos_selectors) for n in pruned)
                neg_ok = all(
                    not any(_match_clause(n, c) for n in pruned)
                    for c in neg_clauses
                )
                if pos_ok and neg_ok:
                    return last_xml
            except SystemExit:
                pass
            if time.monotonic() >= deadline:
                sys.stderr.write(
                    f"ui_snapshot: --wait-for {wait_for} timed out after {timeout_ms}ms"
                    + ("\n" if fail_on_timeout else "; returning latest dump anyway\n")
                )
                if fail_on_timeout:
                    raise SystemExit(124)
                return last_xml
            time.sleep(0.15)

    if wait_stable_ms:
        prev = _one_dump()
        while True:
            time.sleep(wait_stable_ms / 1000.0)
            cur = _one_dump()
            if cur == prev:
                return cur
            prev = cur
            if time.monotonic() >= deadline:
                sys.stderr.write(
                    f"ui_snapshot: --wait-stable-ms {wait_stable_ms} did not settle within "
                    f"{timeout_ms}ms"
                    + ("\n" if fail_on_timeout else "; returning latest dump anyway\n")
                )
                if fail_on_timeout:
                    raise SystemExit(124)
                return cur

    return _one_dump()


# --- uid-map sidecar -----------------------------------------------------
#
# Sidecar lives next to the XML cache at $TMPDIR/android-skill-<serial>.meta.
# Format: header key=value lines, then a `---` separator, then one JSON object
# per uid. The sidecar is the authoritative uid -> bounds map for ui_act.py
# (the XML cache alone is unsafe because pruning order in ui_act differs from
# the filtered/queried order ui_snapshot prints).
#
# The sidecar carries a window-signature hash so ui_act can fail-closed when
# the on-device window has changed since the snapshot. Invalidation is the
# caller's responsibility (ui_act invalidates after every mutating action).

CACHE_VERSION = "1"


def meta_path(serial: str | None) -> Path:
    return Path(os.environ.get("TMPDIR", "/tmp")) / f"android-skill-{serial or 'default'}.meta"


SIG_UNAVAILABLE = "UNAVAILABLE"


def compute_window_sig(serial: str | None) -> tuple[str, int]:
    """Return (hash16 | "UNAVAILABLE", rotation). Cheap window-state hash for
    cache validity.

    Inputs hashed: mCurrentFocus, mFocusedApp, mRotation, mIsImeShowing from
    `dumpsys window`, plus mCurClient and mCurFocusedWindow from
    `dumpsys input_method`. Catches activity, window, dialog, IME, and
    orientation changes. Does NOT catch intra-screen content changes
    (scroll, lazy-list expand).

    Fails closed: when no signal can be collected, returns the sentinel
    "UNAVAILABLE" so callers (ui_act) can refuse to use a stale uid sidecar
    rather than silently accepting an empty match.
    """
    parts: list[str] = []
    rot = 0
    win_ok = False
    ime_ok = False
    cmd = [adb_bin()]
    if serial:
        cmd += ["-s", serial]
    win_cmd = cmd + [
        "shell",
        "dumpsys window | grep -E 'mCurrentFocus=|mFocusedApp=|^[[:space:]]*mRotation=|mIsImeShowing=' | head -12",
    ]
    try:
        out = subprocess.run(win_cmd, capture_output=True, timeout=3)
        win_text = out.stdout.decode("utf-8", errors="replace")
        if win_text.strip():
            parts.append(win_text)
            win_ok = True
        m = re.search(r"^\s*mRotation=(\d+)", win_text, flags=re.M)
        if m:
            try:
                rot = int(m.group(1))
            except ValueError:
                pass
    except Exception:
        pass
    ime_cmd = cmd + [
        "shell",
        "dumpsys input_method | grep -E 'mCurClient|mCurFocusedWindow' | head -4",
    ]
    try:
        out = subprocess.run(ime_cmd, capture_output=True, timeout=2)
        ime_text = out.stdout.decode("utf-8", errors="replace")
        if ime_text.strip():
            parts.append(ime_text)
            ime_ok = True
    except Exception:
        pass
    if not (win_ok or ime_ok):
        return SIG_UNAVAILABLE, rot
    digest = hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()[:16]
    return digest, rot


def write_meta_sidecar(
    serial: str | None,
    nodes: list[Node],
    *,
    foreground: str = "",
    sig_pre: str | None = None,
) -> bool:
    """Write the uid-map sidecar for ui_act.py to consult.

    `nodes` must be exactly the list whose uids were printed (post-filter,
    post-cap). Re-deriving the list from XML in ui_act is unsafe because
    different filter args produce different orderings.

    Race protection: callers pass `sig_pre` (the window signature sampled
    BEFORE the XML dump). We sample `sig_post` after the dump; if they
    differ, the on-screen window changed during the dump and the captured
    nodes belong to a different state than the signature would imply. In
    that case we invalidate the sidecar instead of writing a stale one.
    Caller can re-snapshot.

    Fails closed when the signature is unavailable: invalidates sidecar.

    Returns True if sidecar was persisted, False if invalidated. Callers
    should warn the user when False so stdout uids aren't mistaken as
    actionable — `ui_act tap uN` will fail with "no uid sidecar".
    """
    sig_post, rot = compute_window_sig(serial)
    if sig_post == SIG_UNAVAILABLE or (sig_pre is not None and sig_pre != sig_post):
        invalidate_meta_sidecar(serial)
        return False
    path = meta_path(serial)
    path.parent.mkdir(parents=True, exist_ok=True)
    header = [
        f"cache_version={CACHE_VERSION}",
        f"created_ms={int(time.time() * 1000)}",
        f"window_sig_hash={sig_post}",
        f"rotation={rot}",
        f"foreground={foreground}",
        "---",
    ]
    body: list[str] = []
    for n in nodes:
        if not n.uid:
            continue
        cx = cy = 0
        if n.bounds:
            x1, y1, x2, y2 = n.bounds
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        rec = {
            "uid": n.uid,
            "cx": cx,
            "cy": cy,
            "cls": n.cls,
            "rid": n.rid,
            "text": n.text,
            "desc": n.desc,
            "clickable": n.clickable,
            "focused": n.focused,
        }
        body.append(json.dumps(rec, ensure_ascii=False))
    path.write_text("\n".join(header + body) + "\n", encoding="utf-8")
    return True


def invalidate_meta_sidecar(serial: str | None) -> None:
    try:
        meta_path(serial).unlink()
    except FileNotFoundError:
        return
    except Exception:
        return


def load_meta_sidecar(serial: str | None) -> tuple[dict[str, str], list[dict]] | None:
    """Return (header, [uid records]) or None if the sidecar is missing or
    malformed. Does NOT validate the window signature; callers do that."""
    path = meta_path(serial)
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception:
        return None
    sep = "\n---\n"
    if sep not in raw:
        return None
    head_text, body_text = raw.split(sep, 1)
    header: dict[str, str] = {}
    for line in head_text.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            header[k.strip()] = v.strip()
    records: list[dict] = []
    for line in body_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return header, records


def resolve_serial(cli_serial: str | None) -> str | None:
    if cli_serial:
        return cli_serial
    if os.environ.get("ANDROID_SERIAL"):
        return os.environ["ANDROID_SERIAL"]
    session = Path(os.environ.get("TMPDIR", "/tmp")) / "android-skill-session" / "serial"
    if session.is_file():
        s = session.read_text().strip()
        if s:
            return s
    return None  # Let adb pick if exactly one device is attached.


def main() -> int:
    args = parse_args()
    if args.expand:
        print("ui_snapshot: --expand reserved for v2", file=sys.stderr)
        return 64

    serial = resolve_serial(args.serial)

    if args.post_wait_ms:
        time.sleep(args.post_wait_ms / 1000.0)

    # Sample the window signature BEFORE the XML dump so write_meta_sidecar
    # can detect a window-change race during the dump and refuse to write
    # a stale uid map. (See HIGH 2 race finding.)
    sig_pre, _ = compute_window_sig(serial) if not args.no_cache else (SIG_UNAVAILABLE, 0)

    xml_bytes = acquire_xml(
        serial,
        wait_stable_ms=args.wait_stable_ms,
        wait_for=args.wait_for or None,
        timeout_ms=args.timeout_ms,
        compressed=not args.no_compressed,
        fail_on_timeout=args.fail_on_timeout,
        backend=args.backend,
    )

    if not args.no_cache:
        cache = Path(args.cache_dir) / f"android-skill-{serial or 'default'}.xml"
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(xml_bytes)

    root = build_tree(xml_bytes)
    screen = get_screen_size(serial)
    nodes_pre_query = prune(root, only_clickable=args.only_clickable, screen_size=screen)
    pre_query_count = len(nodes_pre_query)

    if args.query:
        nodes = [n for n in nodes_pre_query if selector_match(n, args.query)]
    else:
        nodes = nodes_pre_query

    # Assign uids in document order.
    for i, n in enumerate(nodes, 1):
        n.uid = f"u{i}"

    include_bounds = args.include_bounds == "true"
    lines = [format_node(n, include_bounds=include_bounds) for n in nodes]

    dropped = 0
    if args.max_lines and len(lines) > args.max_lines:
        dropped = len(lines) - args.max_lines
        lines = lines[: args.max_lines]
        nodes = nodes[: args.max_lines]

    sidecar_ok = True
    if not args.no_cache:
        sidecar_ok = write_meta_sidecar(
            serial,
            nodes,
            foreground=get_foreground_activity(serial),
            sig_pre=sig_pre,
        )
    else:
        invalidate_meta_sidecar(serial)
        sidecar_ok = False

    sys.stdout.write("\n".join(lines))
    if lines:
        sys.stdout.write("\n")
    if dropped:
        sys.stdout.write(f"-- {dropped} more nodes; raise --max-lines or use --query to narrow --\n")
    if not sidecar_ok and lines and not args.no_cache:
        sys.stderr.write(
            "ui_snapshot: WARNING window signature changed during dump — "
            "sidecar NOT persisted. Printed uids are display-only; "
            "`ui_act tap uN` will fail. Use selectors (text=, desc=, id=) "
            "or re-run snapshot when UI is stable.\n"
        )

    # Diagnostics on stderr when the result is empty — distinguishes
    # "0 matches" from "broken script" for the model. Recovery hint
    # is emitted INLINE at the moment of failure so the LLM steers
    # itself instead of falling back to a screencap+Read. Two paths:
    # filter-too-tight (pruned > 0) vs tree-empty (pruned == 0).
    if not lines:
        fg = get_foreground_activity(serial)
        reasons = []
        if args.query:
            reasons.append(f"--query: {args.query}")
        if args.only_clickable:
            reasons.append("--only-clickable")
        filt = " ".join(reasons) or "(no filters)"
        sys.stderr.write(
            f"ui_snapshot: 0 nodes after filters [{filt}]. "
            f"Pre-query kept {pre_query_count} pruned nodes. "
            f"Foreground: {fg}\n"
        )
        if pre_query_count > 0:
            sys.stderr.write(
                "hint: filter too tight — drop --only-clickable "
                "and/or bump --max-lines (try 200). Do NOT retry "
                "identical filters with sleep between; the tree "
                "won't gain nodes.\n"
            )
        else:
            sys.stderr.write(
                "hint: tree empty (no nodes pre-filter). Window may "
                "be a Compose Canvas, ExoPlayer surface, an inflating "
                "activity, or the screensaver. Try (in order): "
                "(1) `describe` op on the selector you EXPECT for the "
                "screen you THINK you're on — confirms identity without "
                "another dump; (2) check the `Foreground:` line above — "
                "if it's a different activity, wake / dismiss / launch; "
                "(3) `window_sig` op for hash-only state. Reading a "
                "screencap is the LAST resort, not the first.\n"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
