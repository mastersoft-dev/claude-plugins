'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STDIN_TIMEOUT_MS = 2000;

// Single source of truth for the plugin's state dir. Resolved identically in
// EVERY execution context — the lint-engine / inject / reset hooks AND the
// Bash-tool-spawned `scripts/state.js record-*`. It must therefore depend only
// on os.homedir() (present and identical everywhere), never on a
// Claude-Code-injected var: CLAUDE_PLUGIN_DATA is set in hook processes but NOT
// in the skill's Bash subprocess, so using it as the primary source split the
// recorder's writes (tmp fallback) from the hook's reads (durable dir) and the
// cadence timestamps never reached the reader. The home-anchored default is
// also durable across reboots / tmp purges, unlike the old os.tmpdir() path.
// MASTERSOFT_STATE_DIR is honored only as an explicit test/CI override (tests
// set it on every spawned process, so both sides still resolve the same dir).
function resolveStateDir() {
  return process.env.MASTERSOFT_STATE_DIR
    || path.join(os.homedir(), '.claude', 'mastersoft', 'state');
}

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// Resolve the per-repo state KEY (state.__repos[<repoRoot>]) identically in
// EVERY execution context — the lint-engine hook AND the Bash-tool-spawned
// scripts/state.js record-*. Like resolveStateDir, it must NOT depend on a
// Claude-Code-injected var: CLAUDE_PROJECT_DIR is present in the hook process
// but absent in the skill's Bash subprocess, so preferring it (as the old code
// did) split the __repos key between writer and reader exactly the way
// CLAUDE_PLUGIN_DATA split the state dir — the recorded timestamp lands under a
// different key than the hook reads and the signal re-fires forever. Key off
// `git rev-parse --show-toplevel` from the same cwd both sides pass (subdir,
// worktree and submodule all collapse to the real repo root), then realpath so
// /var vs /private/var and other symlink forms match across sessions.
function resolveRepoRoot(cwd) {
  let p = gitToplevel(cwd) || cwd;
  try { p = fs.realpathSync(p); } catch {}
  return p;
}

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { return null; }
}

function readStdinJsonAsync(timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    // Never hang the harness: if stdin is opened but never closed, bail out.
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(null); }
    });
    process.stdin.on('error', () => finish(null));
  });
}

function loadState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

function saveState(filePath, state, maxSessions) {
  // `__repos` is not a session — it holds per-repo timestamps (last_audit_at,
  // last_refresh_at, …) + the lint scan cache, inserted once and never moved in
  // key order. Excluding it from the LRU trim keeps it from aging out once the
  // shared state file accumulates > maxSessions session keys (which would silently
  // reset every cadence timestamp the hygiene layer depends on).
  const sessionKeys = Object.keys(state).filter((k) => k !== '__repos');
  if (sessionKeys.length > maxSessions) {
    const trimmed = {};
    if (state.__repos !== undefined) trimmed.__repos = state.__repos;
    for (const k of sessionKeys.slice(-maxSessions)) trimmed[k] = state[k];
    state = trimmed;
  }
  const tmp = filePath + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { readStdinJson, readStdinJsonAsync, loadState, saveState, resolveStateDir, resolveRepoRoot };
