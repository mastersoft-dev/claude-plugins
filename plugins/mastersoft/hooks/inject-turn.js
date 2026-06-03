'use strict';

// UserPromptSubmit hook. Two jobs:
//   - Tier 3 ("be brief"): re-asserted every prompt. Keep it ~1 line; each
//     emission stays in the cached prefix, so length accumulates over a session.
//   - Tier 2 (org rules): re-asserted mid-session when context-window usage has
//     grown by >= MASTERSOFT_ORG_RECURRING_DISTANCE_PCT points since the last
//     assertion — fights drift in the gap between SessionStart boundaries. The
//     usage % is the live statusline metric (statusline.js persists it); if no
//     Mastersoft statusline is active the metric is absent and the gate is
//     dormant. A drop in usage (compaction / clear shrinks context) re-seeds the
//     baseline without injecting, since SessionStart already re-asserted there.

const path = require('path');
const { readStdinJson, loadState, saveState, resolveStateDir } = require('./lib');
const {
  loadOrgTiers, orgMode, quietMutesOrg, quietMutesTier3, cap,
  distancePct, readContextUsagePercent,
} = require('./lib-org-rules');

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, 'org-rules-state.json');
const MAX_SESSIONS = 50;

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);
  if (orgMode() === 'off' || quietMutesOrg()) process.exit(0);

  const tiers = loadOrgTiers();
  const parts = [];

  // Tier 2 — distance-gated mid-session re-assertion.
  const pct = distancePct();
  const sessionId = input.session_id || '';
  if (pct > 0 && sessionId && tiers.tier2) {
    const used = readContextUsagePercent();
    if (used !== null) {
      const state = loadState(STATE_FILE);
      const ss = state[sessionId] || {};
      const last = ss.lastRecurringPct;
      if (typeof last !== 'number' || used < last) {
        ss.lastRecurringPct = used; // seed, or re-seed after a compaction/clear shrink
      } else if (used - last >= pct) {
        parts.push(tiers.tier2);
        ss.lastRecurringPct = used;
      }
      state[sessionId] = ss;
      saveState(STATE_FILE, state, MAX_SESSIONS);
    }
  }

  // Tier 3 — every prompt, unless muted or in tiers-1+2-only mode.
  if (orgMode() === 'all' && !quietMutesTier3() && tiers.tier3) {
    parts.push(tiers.tier3);
  }

  if (!parts.length) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: cap(parts.join('\n\n')),
    },
  }));
}

main();
