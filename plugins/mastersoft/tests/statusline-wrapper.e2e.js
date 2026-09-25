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

function orphanVersion(pluginsRoot, version) {
  const dir = path.join(pluginsRoot, 'cache', 'mastersoft', 'mastersoft', version);
  fs.writeFileSync(path.join(dir, '.orphaned_at'), String(Date.now()));
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

test('an orphaned version dir is skipped even when it sorts highest', () => {
  const home = mkHome();
  const cache = path.join(home, '.claude', 'plugins');
  fakeStatusline(cache, '3.6.0', 'GOOD');
  fakeStatusline(cache, '3.7.0', 'ORPHANED');
  orphanVersion(cache, '3.7.0');
  assertEq(runWrapper(home), 'GOOD');
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

console.log('\n6. statusline.js — rate limit segment (F16)');

const STATUSLINE = path.resolve(__dirname, '../hooks/statusline.js');
const statuslineSrc = fs.readFileSync(STATUSLINE, 'utf8');

test('dead transcript-scan fallback is removed', () => {
  for (const needle of ['scanProjectEntries', 'computeBlockTimeLeft', 'getBlockTimeLeft', '.block-cache.json', 'Claude AI usage limit reached']) {
    if (statuslineSrc.includes(needle)) throw new Error(`statusline.js still references ${needle}`);
  }
});

function runStatusline(input) {
  const stateDir = mkDir();
  const env = { ...process.env, MASTERSOFT_STATE_DIR: stateDir, CLAUDE_STATUSLINE_SEGMENTS: 'rate_limit' };
  const result = cp.spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return (result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

test('renders nothing when rate_limits is absent', () => {
  assertEq(runStatusline({ session_id: 'rl-1' }), '');
});

test('renders the five_hour window when present', () => {
  const out = runStatusline({ session_id: 'rl-2', rate_limits: { five_hour: { used_percentage: 23, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
  if (!/23%/.test(out)) throw new Error(`expected 23% in [${out}]`);
});

test('renders seven_day and spend_limit alongside five_hour', () => {
  const out = runStatusline({
    session_id: 'rl-3',
    rate_limits: {
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 41 },
      spend_limit: { used_percentage: 62 },
    },
  });
  if (!/10%/.test(out)) throw new Error(`missing five_hour in [${out}]`);
  if (!/7d 41%/.test(out)) throw new Error(`missing seven_day in [${out}]`);
  if (!/\$ 62%/.test(out)) throw new Error(`missing spend_limit in [${out}]`);
});

console.log('\n7. lib-org-rules — context usage percent is per-session (F29)');

const LIB_ORG_RULES = path.resolve(__dirname, '../hooks/lib-org-rules.js');

function runNode(code) {
  const stateDir = mkDir();
  const env = { ...process.env, MASTERSOFT_STATE_DIR: stateDir };
  const result = cp.spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 5000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node -e failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

test('context usage percent is tracked separately per session_id', () => {
  const out = runNode(`
    const { writeContextUsagePercent, readContextUsagePercent } = require(${JSON.stringify(LIB_ORG_RULES)});
    writeContextUsagePercent('session-a', 80);
    writeContextUsagePercent('session-b', 20);
    console.log(JSON.stringify({
      a: readContextUsagePercent('session-a'),
      b: readContextUsagePercent('session-b'),
      missing: readContextUsagePercent('session-c'),
    }));
  `);
  assertEq(out, JSON.stringify({ a: 80, b: 20, missing: null }));
});

test('old sessions are trimmed once more than the cap accumulate', () => {
  const out = runNode(`
    const { writeContextUsagePercent, readContextUsagePercent } = require(${JSON.stringify(LIB_ORG_RULES)});
    for (let i = 0; i < 60; i++) writeContextUsagePercent('s' + i, i);
    console.log(JSON.stringify({
      first: readContextUsagePercent('s0'),
      last: readContextUsagePercent('s59'),
    }));
  `);
  assertEq(out, JSON.stringify({ first: null, last: 59 }));
});

console.log('\n8. statusline.js — getTerminalWidth ordering (F30)');

test('readJsonWidth (undocumented for the main statusline) is removed', () => {
  if (statuslineSrc.includes('readJsonWidth')) throw new Error('statusline.js still references readJsonWidth');
});

// getTerminalWidth() has no injectable clock/env seam and its tmux/tty
// subprocess heuristics aren't reliably mockable in a sandboxed test runner
// (a fake `tmux` on PATH doesn't always execute), so the ordering itself is
// asserted on the source: COLUMNS — the value Claude Code documents setting
// for the statusline script — must be read before the tmux pane-width
// correction, which in turn must come before the remaining tty heuristics.
test('COLUMNS is checked before the tmux and tty heuristics', () => {
  const idxCols = statuslineSrc.indexOf('CLAUDE_STATUSLINE_COLS');
  const idxColumns = statuslineSrc.indexOf('process.env.COLUMNS');
  const idxTmux = statuslineSrc.indexOf('process.env.TMUX');
  const idxStty = statuslineSrc.indexOf("execFileSync('stty', ['size']");
  if ([idxCols, idxColumns, idxTmux, idxStty].some((i) => i === -1)) {
    throw new Error('expected CLAUDE_STATUSLINE_COLS, COLUMNS, TMUX and stty checks in getTerminalWidth');
  }
  if (!(idxCols < idxColumns && idxColumns < idxTmux && idxTmux < idxStty)) {
    throw new Error(`expected order CLAUDE_STATUSLINE_COLS < COLUMNS < TMUX < stty, got indices ${idxCols}, ${idxColumns}, ${idxTmux}, ${idxStty}`);
  }
});

console.log('\n9. statusline.js — workspace.repo.name preferred over git remote (F30)');

function initGitRepo(remoteUrl) {
  const dir = mkDir();
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
  cp.execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  return dir;
}

function runStatuslineRepo(cwd, workspaceExtra) {
  const stateDir = mkDir();
  const env = { ...process.env, MASTERSOFT_STATE_DIR: stateDir, CLAUDE_STATUSLINE_SEGMENTS: 'repo' };
  const input = { session_id: 'repo-test', workspace: { current_dir: cwd, ...workspaceExtra } };
  const result = cp.spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return (result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

test('workspace.repo.name from the input wins over the git remote name', () => {
  const dir = initGitRepo('https://example.com/foo/real-repo.git');
  const out = runStatuslineRepo(dir, { repo: { name: 'override-name' } });
  if (!out.includes('override-name')) throw new Error(`expected override-name in [${out}]`);
  if (out.includes('real-repo')) throw new Error(`unexpectedly used the git remote name in [${out}]`);
});

test('falls back to the git remote name when workspace.repo is absent', () => {
  const dir = initGitRepo('https://example.com/foo/real-repo.git');
  const out = runStatuslineRepo(dir, undefined);
  if (!out.includes('real-repo')) throw new Error(`expected real-repo in [${out}]`);
});

console.log('\n10. statusline.js — cache segment (F56)');

function runStatuslineCache(promptCache) {
  const stateDir = mkDir();
  const env = { ...process.env, MASTERSOFT_STATE_DIR: stateDir, CLAUDE_STATUSLINE_SEGMENTS: 'cache' };
  const input = { session_id: 'cache-test' };
  if (promptCache !== undefined) input.prompt_cache = promptCache;
  const result = cp.spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return (result.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

test('renders nothing when prompt_cache is absent', () => {
  assertEq(runStatuslineCache(undefined), '');
});

test('renders hit ratio and warm state when prompt_cache is present', () => {
  const out = runStatuslineCache({ warm: true, hit_ratio: 0.91, last_miss_cause: null });
  if (!/91%/.test(out)) throw new Error(`expected 91% in [${out}]`);
  if (!/warm/.test(out)) throw new Error(`expected warm in [${out}]`);
});

test('appends the last miss cause when non-null', () => {
  const out = runStatuslineCache({
    warm: false,
    hit_ratio: 0.5,
    last_miss_cause: { causes: ['tools_changed'] },
  });
  if (!/cold/.test(out)) throw new Error(`expected cold in [${out}]`);
  if (!/tools_changed/.test(out)) throw new Error(`expected tools_changed in [${out}]`);
});

// ─── summary ──────────────────────────────────────────────────────────────────

tmpHomes.forEach(h => { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} });

console.log(`\n${passed + failed + skipped} tests — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
