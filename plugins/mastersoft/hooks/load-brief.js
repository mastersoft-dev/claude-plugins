'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readStdinJson, loadState, saveState } = require('./lib');

const STATE_FILE = path.join(os.tmpdir(), '.claude-brief-hook-state.json');
const MAX_SESSIONS = 50;
const REFRESH_INTERVAL = 15;
const MAX_BRIEF_CHARS = 8000;

function readFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);

  const sessionId = input.session_id || '';
  const cwd = input.cwd || '.';

  const brief = readFile(path.join(cwd, 'BRIEF.md'));
  if (!brief) process.exit(0);

  const contentHash = crypto.createHash('md5').update(brief).digest('hex').slice(0, 16);

  const state = loadState(STATE_FILE);
  const sessionState = state[sessionId] || { hash: null, count: 0 };

  const count = (sessionState.count || 0) + 1;
  const lastHash = sessionState.hash;
  const contentChanged = lastHash !== contentHash;
  const shouldRefresh = count === 1 || count % REFRESH_INTERVAL === 0;

  if (sessionId) {
    // delete-then-set moves this session to most-recent so the MAX_SESSIONS
    // trim evicts genuinely stale sessions, not re-active ones.
    delete state[sessionId];
    state[sessionId] = { hash: contentHash, count };
    saveState(STATE_FILE, state, MAX_SESSIONS);
  }

  if (!contentChanged && !shouldRefresh) process.exit(0);

  const briefBody = brief.length > MAX_BRIEF_CHARS
    ? `${brief.slice(0, MAX_BRIEF_CHARS)}\n\n…[BRIEF.md truncated at ${MAX_BRIEF_CHARS} chars]`
    : brief;

  const refreshNum = Math.floor(count / REFRESH_INTERVAL) + 1;
  const context = `# Project Brief (refresh #${refreshNum})\n\nLoaded from \`BRIEF.md\`:\n\n${briefBody}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }) + '\n');

  process.exit(0);
}

main();
