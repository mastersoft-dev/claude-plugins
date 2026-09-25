#!/usr/bin/env node
/**
 * E2E tests for statusline-wrapper.js — command resolution.
 *
 * The wrapper runs its spawn logic on load (it is not import-friendly), so each
 * test invokes it as a subprocess with an isolated temp HOME. The user/override
 * command is a harmless `echo MARKER`; the wrapper spawns it with stdout
 * inherited, so the marker reaches the captured stdout. No external repos.
 *
 * Usage: node plugins/mastersoft/tests/statusline-wrapper.e2e.js
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const WRAPPER = path.resolve(__dirname, '../hooks/statusline-wrapper.js');
const INSTALLER = path.resolve(__dirname, '../scripts/install-statusline.sh');
const HAS_JQ = cp.spawnSync('sh', ['-c', 'command -v jq']).status === 0;

// ─── helpers ──────────────────────────────────────────────────────────────────

const tmpHomes = [];

function mkHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wrapper-'));
  tmpHomes.push(home);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, '.claude', name), content);
  }
  return home;
}

function mkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wrapper-'));
  tmpHomes.push(dir);
  return dir;
}

function fakeStatusline(pluginsRoot, version, marker) {
  const hooks = path.join(pluginsRoot, 'cache', 'mastersoft', 'mastersoft', version, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'statusline.js'), `console.log(${JSON.stringify(marker)});\n`);
}

function runWrapper(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) if (!(k in extraEnv)) delete env[k];
  const result = cp.spawnSync(process.execPath, [WRAPPER], {
    input: '',
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return (result.stdout || '').trim();
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn, { skip } = {}) {
  if (skip) { skipped++; console.log(`  -  ${name} (skipped: ${skip})`); return; }
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

const echo = (marker) => `echo ${marker}`;

// ─── tests ──────────────────────────────────────────────────────────────────

console.log('\nstatusline-wrapper e2e — command resolution\n');

console.log('1. statusline.local.json shape tolerance');

// The regression that bit the team: a colleague mirrors the settings.json block
// ({statusLine:{command}}) instead of the documented top-level {command}. Both
// must be honored — otherwise the wrapper silently falls back to the default.
test('nested {statusLine:{command}} shape is honored', () => {
  const home = mkHome({ 'statusline.local.json': JSON.stringify({ statusLine: { command: echo('NESTED') } }) });
  assertEq(runWrapper(home), 'NESTED');
});

test('top-level {command} shape is honored', () => {
  const home = mkHome({ 'statusline.local.json': JSON.stringify({ command: echo('TOPLEVEL') }) });
  assertEq(runWrapper(home), 'TOPLEVEL');
});

test('{type:"command",command} block is honored', () => {
  const home = mkHome({ 'statusline.local.json': JSON.stringify({ type: 'command', command: echo('TYPED') }) });
  assertEq(runWrapper(home), 'TYPED');
});

console.log('\n2. settings.json fallback');

test('settings.json statusLine.command is used when no override file', () => {
  const home = mkHome({ 'settings.json': JSON.stringify({ statusLine: { command: echo('SETTINGS') } }) });
  assertEq(runWrapper(home), 'SETTINGS');
});

test('override file wins over settings.json', () => {
  const home = mkHome({
    'statusline.local.json': JSON.stringify({ command: echo('OVERRIDE') }),
    'settings.json': JSON.stringify({ statusLine: { command: echo('SETTINGS') } }),
  });
  assertEq(runWrapper(home), 'OVERRIDE');
});

console.log('\n3. self-reference + malformed input');

// settings.json pointing back at the wrapper must be rejected (else infinite
// recursion). With no fallback statusline in the temp HOME, output is empty.
test('self-referencing settings command is rejected (no loop)', () => {
  const home = mkHome({ 'settings.json': JSON.stringify({ statusLine: { command: 'node ~/.claude/mastersoft-statusline-wrapper.js' } }) });
  assertEq(runWrapper(home), '');
});

test('literal mastersoft-statusline command is rejected', () => {
  const home = mkHome({ 'statusline.local.json': JSON.stringify({ command: 'mastersoft-statusline' }) });
  assertEq(runWrapper(home), '');
});

test('malformed override JSON degrades to settings.json', () => {
  const home = mkHome({ 'settings.json': JSON.stringify({ statusLine: { command: echo('SETTINGS') } }) });
  fs.writeFileSync(path.join(home, '.claude', 'statusline.local.json'), '{ "command": "echo X",, }');
  assertEq(runWrapper(home), 'SETTINGS');
});

test('whitespace-only command is rejected', () => {
  const home = mkHome({
    'statusline.local.json': JSON.stringify({ command: '   ' }),
    'settings.json': JSON.stringify({ statusLine: { command: echo('SETTINGS') } }),
  });
  assertEq(runWrapper(home), 'SETTINGS');
});

console.log('\n4. config dir + plugin cache');

test('CLAUDE_CONFIG_DIR settings.json is read instead of ~/.claude', () => {
  const home = mkHome({ 'settings.json': JSON.stringify({ statusLine: { command: echo('HOME') } }) });
  const config = mkDir();
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ statusLine: { command: echo('CONFIG') } }));
  assertEq(runWrapper(home, { CLAUDE_CONFIG_DIR: config }), 'CONFIG');
});

test('fallback statusline is found under CLAUDE_CONFIG_DIR/plugins', () => {
  const home = mkHome();
  const config = mkDir();
  fakeStatusline(path.join(config, 'plugins'), '3.6.0', 'CONFIG_CACHE');
  assertEq(runWrapper(home, { CLAUDE_CONFIG_DIR: config }), 'CONFIG_CACHE');
});

test('CLAUDE_CODE_PLUGIN_CACHE_DIR wins, and the highest version is picked', () => {
  const home = mkHome();
  fakeStatusline(path.join(home, '.claude', 'plugins'), '9.0.0', 'DEFAULT_CACHE');
  const cache = mkDir();
  fakeStatusline(cache, '3.9.0', 'OLD');
  fakeStatusline(cache, '3.10.0', 'NEW');
  assertEq(runWrapper(home, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache }), 'NEW');
});

console.log('\n5. install-statusline.sh --apply');

function runInstaller(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (!('CLAUDE_CONFIG_DIR' in extraEnv)) delete env.CLAUDE_CONFIG_DIR;
  const result = cp.spawnSync('sh', [INSTALLER, '--apply'], { env, encoding: 'utf8', timeout: 5000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`installer exit ${result.status}: ${result.stderr}`);
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const wiredCommand = (file) => readJsonFile(file)?.statusLine?.command ?? null;

const noJq = HAS_JQ ? undefined : 'jq not installed';

test('patches ~/.claude/settings.json by default', () => {
  const home = mkHome();
  runInstaller(home);
  assertEq(wiredCommand(path.join(home, '.claude', 'settings.json')), 'node ~/.claude/mastersoft-statusline-wrapper.js');
  assertEq(fs.existsSync(path.join(home, '.claude', 'mastersoft-statusline-wrapper.js')), true, 'wrapper copied');
}, { skip: noJq });

test('patches CLAUDE_CONFIG_DIR/settings.json and keeps the wrapper in ~/.claude', () => {
  const home = mkHome();
  const config = mkDir();
  runInstaller(home, { CLAUDE_CONFIG_DIR: config });
  assertEq(wiredCommand(path.join(config, 'settings.json')), 'node ~/.claude/mastersoft-statusline-wrapper.js');
  assertEq(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, '~/.claude/settings.json untouched');
  assertEq(fs.existsSync(path.join(home, '.claude', 'mastersoft-statusline-wrapper.js')), true, 'wrapper in ~/.claude');
}, { skip: noJq });

// ─── summary ──────────────────────────────────────────────────────────────────

tmpHomes.forEach(h => { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} });

console.log(`\n${passed + failed + skipped} tests — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
