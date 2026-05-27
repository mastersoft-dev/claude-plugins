#!/usr/bin/env node
'use strict';

// SubagentStart hook. Injects the ORG_RULES.md prose body into every subagent's
// context before its first prompt. Subagents load the CLAUDE.md memory hierarchy
// but NOT this plugin preamble (it isn't a CLAUDE.md), and there is no
// frontmatter field that injects arbitrary doc content — so the org rules reach
// agents only via this hook. Single source: the agents never restate org policy.
//
// Applies to ALL subagents, not a curated allow-list: org hygiene + brevity are
// org-wide, so they should hold for built-in agents (Explore, Plan, general-
// purpose) and any third-party agent doing work in a Mastersoft repo too — not
// just plugin-owned ones. An allow-list also silently rots on any agent rename.

const fs = require('fs');
const path = require('path');
const { readStdinJson } = require('./lib');
const { loadOrgTiers, orgMode, quietMutesOrg, cap } = require('./lib-org-rules');

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);

  // Honor the plugin-wide mute switch (parity with the other org hooks). Full
  // quiet suppresses injection; `=lints` only silences lint signals, so org
  // rules still inject under it.
  if (quietMutesOrg() || orgMode() === 'off') process.exit(0);

  // agent_type may arrive bare (`rule-auditor`) or namespaced
  // (`mastersoft:rule-auditor`) — keep the tail for the rule-auditor note below.
  const rawType = String(input.agent_type || '');
  const bareType = rawType.includes(':') ? rawType.slice(rawType.lastIndexOf(':') + 1) : rawType;

  // Subagents get tier 2 (code hygiene) + tier 3 (brevity), not tier 1. Tier 1
  // is main-agent operating posture — plan mode, the advisor tool, delegating
  // to the code-reviewer agent — none of which fit a scoped, single-shot
  // subagent (and it lacks those tools). Hygiene applies to any code it writes;
  // brevity keeps the output it returns from bloating the caller's context.
  const t = loadOrgTiers();
  let body = [t.tier2, t.tier3].filter(Boolean).join('\n\n');
  if (!body) process.exit(0);
  body = cap(body);

  // rule-auditor audits the repo's rule files, so it alone is told when there
  // are none to audit. Informational only — no fix directive: a scoped,
  // single-shot subagent can't sensibly run /mastersoft:init-rules; that's the
  // main agent's call (surfaced there via the lint-engine no-rules-file signal).
  let bootstrapNote = '';
  if (bareType === 'rule-auditor') {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || '.';
    let hasClaudeMd = false;
    try { hasClaudeMd = fs.statSync(path.join(projectDir, 'CLAUDE.md')).isFile(); } catch {}
    if (!hasClaudeMd) {
      bootstrapNote = '\n\n_Note: this repo has no CLAUDE.md — no project rules are loaded. There may be nothing to audit yet._';
    }
  }

  const additionalContext =
    '# Mastersoft org-wide rules (authoritative)\n' +
    'These apply to your work in this repo. Honor them; flag rule files that contradict or duplicate them.\n\n' +
    body + bootstrapNote;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext },
  }));
}

main();
