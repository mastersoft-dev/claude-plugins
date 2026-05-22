#!/usr/bin/env python3
"""
diagnose_tree.py — analyze the current screen and recommend a lane.

Reads one fresh dump via ui_snapshot.run_adb_dump, computes a small set of
metrics, and emits a recommendation. Designed to be the first thing the model
calls in an exploratory flow before deciding HOW to drive the UI.

Output is structured (one `key=value` per line) so the model can grep without
parsing prose.

Bands (codex's bands, not raw count):
  identified_count >= 10                     → tree-rich (Lane A confident)
  4 <= identified_count <= 9                 → ambiguous (Lane A try, escalate on miss)
  identified_count < 4                       → thin (Lane B/C)

Lane recommendation also factors in:
  - presence of WebView nodes (Lane B/C with chrome-devtools handoff)
  - presence of clickable-but-unidentified nodes (Compose un-tagged signal)
  - ratio of clickable nodes to identified nodes
  - foreground activity pkg name (system-ui hints)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))
import ui_snapshot  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Diagnose the current screen and recommend a lane.")
    p.add_argument("--serial", help="adb device serial")
    p.add_argument("--no-compressed", action="store_true",
                   help="disable uiautomator dump --compressed")
    args = p.parse_args()

    serial = ui_snapshot.resolve_serial(args.serial)
    xml, sz = ui_snapshot.run_adb_dump(serial, compressed=not args.no_compressed)
    ui_snapshot.set_screen_size(serial, sz)
    root = ui_snapshot.build_tree(xml)
    screen = ui_snapshot.get_screen_size(serial)

    # Walk all nodes (no pruning) for raw counts; pruner-kept set for the
    # decision band.
    total_nodes = 0
    clickable_total = 0
    has_webview = False
    classes_seen: set[str] = set()

    def walk(n: ui_snapshot.Node) -> None:
        nonlocal total_nodes, clickable_total, has_webview
        if n.cls and n.cls != "<root>":
            total_nodes += 1
            classes_seen.add(ui_snapshot.short_class(n.cls))
            if n.clickable:
                clickable_total += 1
            cls_lower = n.cls.lower()
            if "webview" in cls_lower:
                has_webview = True
        for c in n.children:
            walk(c)
    walk(root)

    pruned = ui_snapshot.prune(root, only_clickable=False, screen_size=screen)
    identified = sum(1 for n in pruned if n.has_any_id())
    pruned_clickable = sum(1 for n in pruned if n.clickable)
    pruned_clickable_unidentified = sum(
        1 for n in pruned if n.clickable and not n.has_any_id()
    )

    if identified >= 10:
        tree_band = "rich"
    elif identified >= 4:
        tree_band = "ambiguous"
    else:
        tree_band = "thin"

    # Lane decision
    reasons: list[str] = []
    if has_webview:
        reasons.append("WebView present — selectors blind on web content")
    if tree_band == "thin":
        reasons.append(f"only {identified} identified nodes (<4)")
    if tree_band == "rich":
        reasons.append(f"{identified} identified nodes (>=10)")
    if pruned_clickable_unidentified > pruned_clickable / 2 and pruned_clickable >= 4:
        reasons.append("many clickable nodes lack identifiers (Compose without testTagsAsResourceId?)")

    # Default lane decision tree
    if has_webview and identified < 4:
        lane = "B"  # WebView with no native chrome
    elif tree_band == "rich":
        lane = "A"
    elif tree_band == "ambiguous":
        lane = "A"  # try, escalate on miss
    else:
        lane = "B"  # thin tree, single-screen action

    foreground = ui_snapshot.get_foreground_activity(serial)

    out = [
        f"identified_count={identified}",
        f"total_nodes={total_nodes}",
        f"clickable_total={clickable_total}",
        f"clickable_unidentified={pruned_clickable_unidentified}",
        f"has_webview={'true' if has_webview else 'false'}",
        f"tree_band={tree_band}",
        f"foreground={foreground}",
        f"recommended_lane={lane}",
    ]
    if reasons:
        out.append("reasons=" + " | ".join(reasons))
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
