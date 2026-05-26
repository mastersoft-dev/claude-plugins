'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinJson, loadState, saveState } = require('./lib');

const STATE_FILE = path.join(os.tmpdir(), '.claude-claudemd-hook-state.json');
const MAX_SESSIONS = 50;

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);

  const cwd = input.cwd || '.';
  const sessionId = input.session_id || '';
  const claudeHome = path.resolve(path.join(os.homedir(), '.claude'));
  const resolved = path.resolve(cwd);

  if (resolved === claudeHome || resolved.startsWith(claudeHome + path.sep)) {
    process.exit(0);
  }

  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    // Show the notice once per session+directory, not on every prompt.
    const key = sessionId ? `${sessionId}:${resolved}` : '';
    if (key) {
      const state = loadState(STATE_FILE);
      if (state[key]) process.exit(0);
      state[key] = true;
      saveState(STATE_FILE, state, MAX_SESSIONS);
    }
    process.stdout.write('[NOTICE] No CLAUDE.md found in this directory. Consider running /init to set up project context.\n');
  }

  process.exit(0);
}

main();
