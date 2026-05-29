#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const SELF_MARKER = 'mastersoft-statusline-wrapper';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function extractCommand(cfg) {
  const cmd = cfg?.statusLine?.command ?? cfg?.command;
  return typeof cmd === 'string' && cmd.trim() ? cmd : null;
}

function isForeignCommand(cmd) {
  return Boolean(cmd) && !cmd.includes(SELF_MARKER) && cmd !== 'mastersoft-statusline';
}

function readUserOverrideCommand() {
  const overrideCmd = extractCommand(readJson(path.join(HOME, '.claude/statusline.local.json')));
  if (isForeignCommand(overrideCmd)) return overrideCmd;
  const userCmd = extractCommand(readJson(path.join(HOME, '.claude/settings.json')));
  if (isForeignCommand(userCmd)) return userCmd;
  return null;
}

function findMastersoftStatusline() {
  const dir = path.join(HOME, '.claude/plugins/cache/mastersoft/mastersoft');
  try {
    const entries = fs.readdirSync(dir)
      .map(v => ({ v, p: path.join(dir, v, 'hooks/statusline.js') }))
      .filter(x => {
        try { return fs.statSync(x.p).isFile(); } catch { return false; }
      })
      .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
    return entries.at(-1)?.p ?? null;
  } catch {
    return null;
  }
}

function spawnUserShell(cmd) {
  if (IS_WIN) {
    const gitBash = [
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files (x86)/Git/bin/bash.exe',
    ].find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (gitBash) {
      return spawn(gitBash, ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'] });
    }
    return spawn('powershell.exe', ['-NoProfile', '-Command', cmd], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
  return spawn('sh', ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'] });
}

const userCmd = readUserOverrideCommand();
let child;
if (userCmd) {
  child = spawnUserShell(userCmd);
} else {
  const fallback = findMastersoftStatusline();
  if (!fallback) process.exit(0);
  child = spawn(process.execPath, [fallback], { stdio: ['pipe', 'inherit', 'inherit'] });
}

process.stdin.pipe(child.stdin);
child.on('exit', code => process.exit(code ?? 0));
child.on('error', () => process.exit(0));
