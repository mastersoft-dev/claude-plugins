'use strict';

// Reset session-scoped flags so the once-per-session lint notices re-emit on
// the next UserPromptSubmit. Fires after /compact (additionalContext doesn't
// survive compaction per context-window.md) and after /clear (in-memory
// history wiped while session_id continues). Org-rule prose re-injection at
// these boundaries is handled by inject-session.js, not here.

const path = require('path');
const { readStdinJson, loadState, saveState, resolveStateDir } = require('./lib');

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, 'lint-engine-state.json');
const MAX_SESSIONS = 50;

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);
  const sessionId = input.session_id || '';
  if (!sessionId) process.exit(0);

  const state = loadState(STATE_FILE);
  const ss = state[sessionId];
  if (!ss) process.exit(0);

  delete ss.orgRulesUnknownKeysWarned;
  delete ss.midSessionEditNoticed;
  delete ss.lintsNoticeShown; // re-surface the once-per-session lint notice after reset
// Reset the mid-session-edit baseline. Without this, a user who edited
  // CLAUDE.md then ran /clear or /compact (precisely to make edits apply)
  // would have the next prompt re-fire the "edited mid-session" lint
  // because the file mtime still exceeds the original sessionStartMs.
  delete ss.sessionStartMs;
  ss.count = 0;

  state[sessionId] = ss;
  saveState(STATE_FILE, state, MAX_SESSIONS);
  process.exit(0);
}

main();
