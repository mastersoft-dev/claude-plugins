#!/usr/bin/env python3
"""harvest-to-maestro.py — convert recorded skill flows into Maestro YAML.

Pipeline:
  1. The LLM explores the UI via daemon ops, recording successful flows
     with `ui_run_flow.py --record FILE` (or `--record-append FILE` to
     stack one JSON per line into a single timeline).
  2. Once a flow works reliably, run this harvester to lower it to a
     Maestro YAML file. Maestro then runs the same path device-side
     with no per-tap host RTT.

Mapping:
  tap (selector text="X") → `- tapOn: "X"`
  tap (selector desc="X") → `- tapOn: { id: "X" }`
  tap (selector id=...)   → `- tapOn: { id: "..." }`
  tap_point x y           → `- tapOn: { point: "X, Y" }`
  tap_macro [[x,y],...]   → series of `- tapOn: { point: "X, Y" }`
  resolve_then_tap_sequence → expanded as one tapOn per selector
  swipe                   → `- swipe: { start: ..., end: ... }`
  long_press x y          → `- longPressOn: { point: "X, Y" }`
  type "..."              → `- inputText: "..."`
  key KEYCODE_ENTER       → `- pressKey: Enter`
  sleep ms                → `- waitForAnimationToEnd: { timeout: ms }`
                            (Maestro waits for animation, plus the
                             requested ms as a hint)
  snapshot / screencap /
  window_sig / health /
  describe                → emitted as a comment line; not directly
                            actionable in Maestro.

Usage:
  harvest-to-maestro.py [--app APP_ID] FILE [FILE ...]
  harvest-to-maestro.py --append APPEND-FILE [--app APP_ID]

Output: Maestro YAML on stdout. Pipe to a `.yaml` file under your
Maestro flows directory.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


KEYCODE_TO_MAESTRO = {
    "KEYCODE_ENTER": "Enter",
    "KEYCODE_BACK": "Back",
    "KEYCODE_HOME": "Home",
    "KEYCODE_TAB": "Tab",
    "KEYCODE_DEL": "Backspace",
    "KEYCODE_VOLUME_UP": "VolumeUp",
    "KEYCODE_VOLUME_DOWN": "VolumeDown",
}


def _emit_yaml_line(out: list[str], line: str) -> None:
    out.append(line)


_YAML_SPECIAL = {
    "true", "false", "null", "yes", "no", "on", "off",
    "True", "False", "Null", "TRUE", "FALSE", "NULL", "~",
}


def _yaml_str(v: str) -> str:
    """Quote a YAML scalar safely. Maestro's parser is strict.

    Force-quote when the bare form would be misparsed as an int,
    float, bool, null, or YAML list/map indicator. Better to over-
    quote than to silently change semantics (`tapOn: "1"` vs `1`).
    """
    if not v:
        return '""'
    # Special tokens — quote.
    if v.strip() in _YAML_SPECIAL:
        return f'"{v}"'
    # Pure number — quote.
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][+-]?\d+)?", v):
        return f'"{v}"'
    # Hex / octal / binary — quote.
    if re.fullmatch(r"0[xX][0-9A-Fa-f]+|0o[0-7]+|0b[01]+", v):
        return f'"{v}"'
    # Bare identifier safe set — only when first char is also a letter.
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_./-]*", v):
        return v
    escaped = v.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _selector_to_maestro(selector: str) -> dict | str:
    """Parse a daemon selector string into a Maestro-friendly value.

    Returns a string when Maestro's bare `tapOn: <text>` form fits,
    or a dict when we need explicit `id`/`text`/etc. keys.
    """
    s = selector.strip()
    # text="X" or text~"X"
    m = re.fullmatch(r'text="([^"]*)"', s)
    if m:
        return m.group(1)
    m = re.fullmatch(r'text~"([^"]*)"', s)
    if m:
        return {"text": m.group(1)}
    m = re.fullmatch(r'desc="([^"]*)"', s)
    if m:
        return {"id": m.group(1)}  # Maestro's `id` matches contentDescription too
    m = re.fullmatch(r'desc~"([^"]*)"', s)
    if m:
        return {"id": m.group(1)}
    m = re.fullmatch(r'id=(\S+)', s)
    if m:
        return {"id": m.group(1)}
    # Comma-joined AND clauses or other unsupported grammar.
    return {"text": s}


def _yaml_dict_inline(d: dict) -> str:
    """Render a small dict as inline YAML: `{key: val, key: val}`."""
    parts = []
    for k, v in d.items():
        if isinstance(v, str):
            parts.append(f"{k}: {_yaml_str(v)}")
        elif isinstance(v, bool):
            parts.append(f"{k}: {'true' if v else 'false'}")
        else:
            parts.append(f"{k}: {v}")
    return "{ " + ", ".join(parts) + " }"


def _convert_op(out: list[str], op: str | None, args: dict) -> None:
    if op == "tap":
        target = args.get("target", "")
        sel = _selector_to_maestro(target)
        if isinstance(sel, str):
            out.append(f"- tapOn: {_yaml_str(sel)}")
        else:
            out.append(f"- tapOn: {_yaml_dict_inline(sel)}")

    elif op == "tap_point":
        out.append(f'- tapOn: {{ point: "{args.get("x")}, {args.get("y")}" }}')

    elif op == "tap_macro":
        for x, y in args.get("taps") or []:
            out.append(f'- tapOn: {{ point: "{x}, {y}" }}')

    elif op == "resolve_then_tap_sequence":
        for sel in args.get("selectors") or []:
            parsed = _selector_to_maestro(sel)
            if isinstance(parsed, str):
                out.append(f"- tapOn: {_yaml_str(parsed)}")
            else:
                out.append(f"- tapOn: {_yaml_dict_inline(parsed)}")

    elif op == "swipe":
        out.append(
            f'- swipe:'
        )
        out.append(f'    start: "{args.get("x1")}, {args.get("y1")}"')
        out.append(f'    end: "{args.get("x2")}, {args.get("y2")}"')
        dur = args.get("duration_ms")
        if dur:
            out.append(f"    duration: {dur}")

    elif op == "long_press":
        out.append(
            f'- longPressOn: {{ point: "{args.get("x")}, {args.get("y")}" }}'
        )

    elif op == "type":
        text = args.get("text", "")
        out.append(f"- inputText: {_yaml_str(text)}")

    elif op == "key":
        code = args.get("code", "")
        maestro = KEYCODE_TO_MAESTRO.get(code, code)
        out.append(f"- pressKey: {maestro}")

    elif op == "sleep":
        ms = args.get("ms", 0)
        # Maestro doesn't have a raw sleep; waitForAnimationToEnd with
        # a timeout hint is the closest. The harvested flow assumes
        # animations are the reason for the sleep — which matches the
        # skill's documented usage. Include the requested ms as a
        # comment for reviewers.
        out.append(f"# skill sleep {ms}ms (animation gap)")
        out.append(f"- waitForAnimationToEnd: {{ timeout: {max(ms, 200)} }}")

    elif op in ("snapshot", "screencap", "window_sig", "health", "describe"):
        # Read-only ops — no side effect to replay. Emit as comment so
        # reviewers see the original flow shape.
        summary = json.dumps(args, ensure_ascii=False) if args else ""
        out.append(f"# skill {op} {summary}".rstrip())

    else:
        out.append(f"# skill UNKNOWN op {op!r} args={json.dumps(args, ensure_ascii=False)}")


def _flows_from_files(paths: list[str], append_mode: bool) -> list[dict]:
    """Load flows from the given file(s). In append_mode, each line is
    a separate flow (recorded via `--record-append`). Otherwise each
    file is one whole flow."""
    flows: list[dict] = []
    for p in paths:
        text = Path(p).read_text(encoding="utf-8")
        if append_mode:
            for i, line in enumerate(text.splitlines(), 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    flows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    sys.stderr.write(f"harvest: {p}:{i}: bad JSON: {e}\n")
        else:
            try:
                flows.append(json.loads(text))
            except json.JSONDecodeError as e:
                sys.stderr.write(f"harvest: {p}: bad JSON: {e}\n")
    return flows


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("files", nargs="+", help="recorded flow JSON file(s)")
    p.add_argument("--append", action="store_true",
                   help="treat input as JSON-per-line (--record-append output)")
    p.add_argument("--app", default="com.example.app",
                   help="appId for the Maestro flow header (default placeholder)")
    args = p.parse_args()

    flows = _flows_from_files(args.files, args.append)
    if not flows:
        sys.stderr.write("harvest: no flows loaded\n")
        return 64

    out: list[str] = [
        "# Generated by harvest-to-maestro.py",
        "# Source flow(s):",
    ]
    for f in args.files:
        out.append(f"#   - {f}")
    out.append(f"appId: {args.app}")
    out.append("---")

    for flow_idx, flow in enumerate(flows):
        ops = flow.get("ops") or []
        if len(flows) > 1:
            out.append(f"# === flow {flow_idx + 1} of {len(flows)} ===")
        for op_idx, sub in enumerate(ops):
            sub_op = sub.get("op")
            sub_args = sub.get("args") or {}
            _convert_op(out, sub_op, sub_args)

    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
