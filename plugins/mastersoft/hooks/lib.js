'use strict';

const fs = require('fs');

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { return null; }
}

function readStdinJsonAsync() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    process.stdin.on('error', () => resolve(null));
  });
}

function loadState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

function saveState(filePath, state, maxSessions) {
  const keys = Object.keys(state);
  if (keys.length > maxSessions) {
    const trimmed = {};
    for (const k of keys.slice(-maxSessions)) trimmed[k] = state[k];
    state = trimmed;
  }
  const tmp = filePath + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { readStdinJson, readStdinJsonAsync, loadState, saveState };
