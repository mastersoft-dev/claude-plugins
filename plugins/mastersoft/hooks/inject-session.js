'use strict';

// SessionStart hook (startup/clear/resume/compact). Injects the operating
// posture (tier 1) + Mastersoft org rules (tier 2) into the main-thread context
// at every session boundary. Lands in the cached conversation prefix, so it
// costs input tokens once per boundary, not per prompt. After compaction the
// original injection is pruned, so re-emitting here is the documented recovery
// path. Tier 3 (per-prompt) and tier-2 mid-session re-assertion live in
// inject-turn.js.

const { readStdinJson } = require('./lib');
const { loadOrgTiers, orgMode, quietMutesOrg, cap } = require('./lib-org-rules');

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);
  if (quietMutesOrg() || orgMode() === 'off') process.exit(0);

  const t = loadOrgTiers();
  const blocks = [t.tier1, t.tier2].filter(Boolean);
  if (!blocks.length) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: cap(blocks.join('\n\n')),
    },
  }));
}

main();
