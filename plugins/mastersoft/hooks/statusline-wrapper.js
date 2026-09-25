#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CONFIG_DIR = (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(HOME, '.claude');
const PLUGINS_ROOT = (process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || '').trim() || path.join(CONFIG_DIR, 'plugins');
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
  const userCmd = extractCommand(readJson(path.join(CONFIG_DIR, 'settings.json')));
  if (isForeignCommand(userCmd)) return userCmd;
  return null;
}

// Newest mastersoft copy with a statusline.js, by the version in its
// plugin.json (the directory name for a cache entry without one). A plugin
// installed from the marketplace lives in cache/mastersoft/mastersoft/<version>;
// one synced from claude.ai lives in synced/<bucket>/mastersoft, or
// mastersoft~g<N>, and once it loads from there Claude Code marks every cache
// version `.orphaned_at`. Orphaned dirs are skipped, since they are deleted only
// 14 days later and can sort highest.
function mastersoftCopies() {
  const list = (dir, keep) => {
    try { return fs.readdirSync(dir).filter(keep).map(name => path.join(dir, name)); } catch { return []; }
  };
  const cache = list(path.join(PLUGINS_ROOT, 'cache', 'mastersoft', 'mastersoft'), () => true)
    .filter(dir => !fs.existsSync(path.join(dir, '.orphaned_at')));
  const synced = list(path.join(PLUGINS_ROOT, 'synced'), () => true)
    .flatMap(bucket => list(bucket, name => /^mastersoft(~g\d+)?$/.test(name)));
  return [...cache, ...synced];
}

function findMastersoftStatusline() {
  const found = mastersoftCopies()
    .map(dir => ({
      p: path.join(dir, 'hooks/statusline.js'),
      v: readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.version || path.basename(dir),
    }))
    .filter(x => {
      try { return fs.statSync(x.p).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  return found.at(-1)?.p ?? null;
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
