---
name: help
description: Reference card for the Mastersoft plugin — skills, lint signal catalog, suppress mechanisms, env vars, update path. Use proactively when the user asks "what does mastersoft do", "list mastersoft skills", "what signals does it emit", "how do I silence the lints", "/mastersoft:help", or otherwise needs orientation to the plugin surface.
allowed-tools: Bash(cat:*)
model: sonnet
---

# Mastersoft help

The user invoked `/mastersoft:help`. The full reference card is inlined
below. Output **only** the card content to the user — verbatim, no
prefix, no suffix, no summary, no commentary, no "Here is the card:".

Card:

!`cat "${CLAUDE_SKILL_DIR}/references/card.md"`
