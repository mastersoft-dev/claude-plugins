---
name: help
description: Reference card for the Mastersoft plugin — skills, lint signal catalog, suppress mechanisms, env vars, update path. Use proactively when the user asks "what does mastersoft do", "list mastersoft skills", "what signals does it emit", "how do I silence the lints", "/mastersoft:help", or otherwise needs orientation to the plugin surface.
allowed-tools: Read
model: sonnet
---

# Mastersoft help

The user invoked `/mastersoft:help`. Read `${CLAUDE_SKILL_DIR}/references/card.md`
with the Read tool, then output **only** its content to the user — verbatim,
no prefix, no suffix, no summary, no commentary, no "Here is the card:".

If the file can't be read, say "Reference card unavailable — open
plugins/mastersoft/skills/help/references/card.md" and stop.
