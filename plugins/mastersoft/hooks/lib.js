'use strict';

const fs = require('fs');

const STDIN_TIMEOUT_MS = 2000;

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

module.exports = { readStdinJson, readStdinJsonAsync, loadState, saveState };
