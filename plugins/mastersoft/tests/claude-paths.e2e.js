#!/usr/bin/env node
/**
 * E2E tests for Claude Code path resolution — project slugs, config and cache
 * dirs, auto-memory location.
 *
 * Every test builds its own temp HOME / CLAUDE_CONFIG_DIR and throwaway git
 * repos, so nothing under the real ~/.claude is read. state.js runs as a
 * subprocess; the lib helpers run in-process with a scoped env.
 *
 * Usage: node plugins/mastersoft/tests/claude-paths.e2e.js
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const LIB    = path.resolve(__dirname, '../hooks/lib.js');
const STATE  = path.resolve(__dirname, '../scripts/state.js');
const lib = require(LIB);

const ENV_KEYS = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
];

// ─── helpers ──────────────────────────────────────────────────────────────────

const tmpDirs = [];

function mkTmp(prefix = 'ms-paths-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(cwd, ...args) {
  return cp.execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function mkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function isolatedEnv(vars) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  return { ...env, ...vars };
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function run(script, args, { cwd, env }) {
  const r = cp.spawnSync(process.execPath, [script, ...args], {
    cwd, env: isolatedEnv(env), encoding: 'utf8', timeout: 15000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓  ${name}`); }
  catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  ✗  ${name}\n     ${e.message}`);
  }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'} — expected [${expected}], got [${actual}]`);
  }
}

function assertIncludes(haystack, needle, msg) {
  if (!haystack.includes(needle)) throw new Error(`${msg || 'missing'} — [${needle}] not in:\n${haystack}`);
}

function assertExcludes(haystack, needle, msg) {
  if (haystack.includes(needle)) throw new Error(`${msg || 'unexpected'} — [${needle}] found in:\n${haystack}`);
}

// ─── tests ──────────────────────────────────────────────────────────────────

console.log('\nclaude-paths e2e — slugs, config dirs, auto memory\n');

console.log('1. project slug + data dir');

test('every non-alphanumeric character becomes a dash', () => {
  assertEq(lib.projectSlug('/Users/a/my proj/x:y_z.w'), '-Users-a-my-proj-x-y-z-w');
});

test('slug over 200 chars resolves to the hashed dir on disk, or null', () => {
  const config = mkTmp();
  const long = '/' + 'a'.repeat(240);
  const slug = lib.projectSlug(long);
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.projectDataDir(long), null, 'no dir yet');
    const hashed = slug.slice(0, 200) + '-1a2b3c';
    fs.mkdirSync(path.join(config, 'projects', hashed), { recursive: true });
    assertEq(lib.projectDataDir(long), path.join(config, 'projects', hashed));
  });
});

test('CLAUDE_CODE_PROJECT_DIR_NAME applies only with CLAUDE_CONFIG_DIR and a valid name', () => {
  const config = mkTmp();
  const home = mkTmp();
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: 'tenant_1' }, () => {
    assertEq(lib.projectDataDir('/x/y'), path.join(config, 'projects', 'tenant_1'));
  });
  withEnv({ HOME: home, CLAUDE_CODE_PROJECT_DIR_NAME: 'tenant_1' }, () => {
    assertEq(lib.projectDataDir('/x/y'), path.join(home, '.claude', 'projects', '-x-y'), 'ignored without config dir');
  });
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '../escape' }, () => {
    assertEq(lib.projectDataDir('/x/y'), path.join(config, 'projects', '-x-y'), 'invalid name ignored');
  });
});

test('config dir and plugins root follow their env vars', () => {
  const home = mkTmp();
  withEnv({ HOME: home }, () => {
    assertEq(lib.claudeConfigDir(), path.join(home, '.claude'));
    assertEq(lib.pluginsRoot(), path.join(home, '.claude', 'plugins'));
  });
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_PLUGIN_CACHE_DIR: '/cache' }, () => {
    assertEq(lib.claudeConfigDir(), '/cfg');
    assertEq(lib.pluginsRoot(), '/cache');
  });
});

console.log('\n2. auto memory');

test('a linked worktree shares the main repo memory dir', () => {
  const base = mkTmp();
  const repo = mkRepo(path.join(base, 'repo'));
  const wt = path.join(base, 'repo-wt');
  git(repo, 'worktree', 'add', '-q', wt);
  const config = mkTmp();
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    const expected = path.join(config, 'projects', lib.projectSlug(repo), 'memory');
    assertEq(lib.autoMemoryDir(repo), expected, 'main checkout');
    assertEq(lib.autoMemoryDir(wt), expected, 'linked worktree');
  });
});

test('auto memory off via env or autoMemoryEnabled yields null', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const config = mkTmp();
  withEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, () => {
    assertEq(lib.autoMemoryDir(repo), null, 'env');
  });
  write(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(repo), null, 'project setting');
  });
  withEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, () => {
    assertEq(lib.autoMemoryDir(repo), path.join(config, 'projects', lib.projectSlug(repo), 'memory'), 'env 0 forces it on');
  });
});

test('autoMemoryDirectory: ~/ and absolute paths, local settings win', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const home = mkTmp();
  const config = mkTmp();
  write(path.join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/mem' }));
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(repo), path.join(home, 'mem'), 'user setting with ~/');
  });
  write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/abs/mem' }));
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(repo), '/abs/mem', 'local setting wins');
  });
});

test('state.js memory-path prints the dir, or nothing when auto memory is off', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const config = mkTmp();
  const on = run(STATE, ['memory-path'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } });
  assertEq(on.code, 0);
  assertEq(on.stdout.trim(), path.join(config, 'projects', lib.projectSlug(repo), 'memory'));
  const off = run(STATE, ['memory-path'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  assertEq(off.code, 0);
  assertEq(off.stdout.trim(), '');
  assertIncludes(off.stderr, 'Auto memory is off');
});

// ─── summary ──────────────────────────────────────────────────────────────────

tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
