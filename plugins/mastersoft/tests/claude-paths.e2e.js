#!/usr/bin/env node
/**
 * E2E tests for Claude Code path resolution — project slugs, config and cache
 * dirs, auto-memory location — and for recall.js, which reads transcripts
 * through them.
 *
 * Every test builds its own temp HOME / CLAUDE_CONFIG_DIR and throwaway git
 * repos, so nothing under the real ~/.claude is read. recall.js and state.js
 * run as subprocesses; the lib helpers run in-process with a scoped env.
 *
 * Usage: node plugins/mastersoft/tests/claude-paths.e2e.js
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const LIB    = path.resolve(__dirname, '../hooks/lib.js');
const RECALL = path.resolve(__dirname, '../scripts/recall.js');
const STATE  = path.resolve(__dirname, '../scripts/state.js');
const lib = require(LIB);

const ENV_KEYS = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'MASTERSOFT_MANAGED_SETTINGS_DIR',
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

const NO_MANAGED = mkTmp('ms-managed-');

function isolatedEnv(vars) {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  return { ...env, MASTERSOFT_MANAGED_SETTINGS_DIR: NO_MANAGED, ...vars };
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { MASTERSOFT_MANAGED_SETTINGS_DIR: NO_MANAGED }, vars);
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

let seq = 0;
function sessionId() {
  seq++;
  return `${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function transcript(projectsRoot, dirName, { cwd, title, prompt, ts, id = sessionId() }) {
  const lines = [
    { type: 'user', cwd, timestamp: ts, sessionId: id, message: { role: 'user', content: prompt } },
    { type: 'assistant', cwd, timestamp: ts, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: `ok: ${prompt}` }] } },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  write(path.join(projectsRoot, dirName, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return id;
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

console.log('\nclaude-paths e2e — slugs, config dirs, auto memory, recall\n');

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
    fs.mkdirSync(path.join(config, 'projects', slug.slice(0, 200) + '-4d5e6f'), { recursive: true });
    assertEq(lib.projectDataDir(long), null, 'two dirs share the prefix');
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
  withEnv({ HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: 'CON' }, () => {
    assertEq(lib.projectDataDir('/x/y'), path.join(config, 'projects', '-x-y'), 'Windows device name ignored');
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
  assertIncludes(off.stderr, 'auto memory is off');
});

console.log('\n3. settings layers');

test('project settings.json counts only in the session dir; local settings come from the repo root', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const config = mkTmp();
  write(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(repo), null, 'root session reads the root settings.json');
    assertEq(lib.autoMemoryDir(sub), path.join(config, 'projects', lib.projectSlug(repo), 'memory'), 'subdir session ignores it');
  });
  write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/root-local' }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(sub), '/root-local', 'subdir session reads the root settings.local.json');
  });
});

test('a linked worktree reads the main checkout local settings first, then its own', () => {
  const base = mkTmp();
  const repo = mkRepo(path.join(base, 'repo'));
  const wt = path.join(base, 'repo-wt');
  git(repo, 'worktree', 'add', '-q', wt);
  const config = mkTmp();
  write(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/wt-local' }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => assertEq(lib.autoMemoryDir(wt), '/wt-local', 'file an older version left in the worktree'));
  write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/main-local' }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => assertEq(lib.autoMemoryDir(wt), '/main-local', 'main checkout file wins'));
  write(path.join(wt, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
  withEnv({ CLAUDE_CONFIG_DIR: config }, () => {
    assertEq(lib.autoMemoryDir(wt), null, 'worktree settings.json applies to the worktree');
    assertEq(lib.autoMemoryDir(repo), '/main-local', 'and not to the main checkout');
  });
});

test('managed settings win: remote first, files merged with drop-ins, merge on request', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const config = mkTmp();
  const managed = mkTmp();
  write(path.join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '/user' }));
  write(path.join(managed, 'managed-settings.json'), JSON.stringify({ autoMemoryDirectory: '/file' }));
  write(path.join(managed, 'managed-settings.d', '20-memory.json'), JSON.stringify({ autoMemoryDirectory: '/drop-in' }));
  const env = { CLAUDE_CONFIG_DIR: config, MASTERSOFT_MANAGED_SETTINGS_DIR: managed };
  withEnv(env, () => assertEq(lib.autoMemoryDir(repo), '/drop-in', 'drop-ins merge after managed-settings.json'));
  write(path.join(config, 'remote-settings.json'), JSON.stringify({ autoMemoryDirectory: '/remote' }));
  withEnv(env, () => assertEq(lib.autoMemoryDir(repo), '/remote', 'server-managed ranks first'));
  write(path.join(config, 'remote-settings.json'), JSON.stringify({ cleanupPeriodDays: 10 }));
  withEnv(env, () => assertEq(lib.autoMemoryDir(repo), '/user', 'first-wins skips the lower managed source'));
  write(path.join(config, 'remote-settings.json'), JSON.stringify({ cleanupPeriodDays: 10, managedSourcesBehavior: 'merge' }));
  withEnv(env, () => assertEq(lib.autoMemoryDir(repo), '/drop-in', 'merge fills the key from the files'));
});

test('agents-md mode: instructionFiles from managed and user only, enabledPlugins from any layer', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  const config = mkTmp();
  const managed = mkTmp();
  const mode = (value) => JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: value } } } });
  const env = { CLAUDE_CONFIG_DIR: config, MASTERSOFT_MANAGED_SETTINGS_DIR: managed };
  write(path.join(repo, '.claude', 'settings.json'), mode('claude-md'));
  withEnv(env, () => assertEq(lib.agentsMdSetting(repo).mode, 'claude-md-or-agents-md', 'ignored in project settings'));
  write(path.join(config, 'settings.json'), mode('claude-md-and-agents-md'));
  withEnv(env, () => assertEq(lib.agentsMdSetting(repo).mode, 'claude-md-and-agents-md', 'user settings'));
  write(path.join(managed, 'managed-settings.json'), mode('managed-only'));
  withEnv(env, () => assertEq(lib.agentsMdSetting(repo).mode, 'managed-only', 'managed wins'));
  write(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'agents-md@builtin': false } }));
  withEnv(env, () => {
    const setting = lib.agentsMdSetting(repo);
    assertEq(setting.pluginDisabled, true, 'disabled in local settings');
    assertEq(setting.mode, 'claude-md', 'disabled plugin behaves like claude-md');
  });
});

test('state.js rule-files and agents-md-mode follow the mode', () => {
  const repo = mkRepo(path.join(mkTmp(), 'repo'));
  write(path.join(repo, 'AGENTS.md'), '# rules\n');
  const config = mkTmp();
  const files = run(STATE, ['rule-files'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } });
  assertEq(files.stdout.trim(), path.join(repo, 'AGENTS.md'), 'default mode loads AGENTS.md');
  write(path.join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md' } } } }));
  assertEq(run(STATE, ['rule-files'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } }).stdout, '', 'claude-md mode loads nothing here');
  assertEq(run(STATE, ['agents-md-mode'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } }).stdout.trim(), 'claude-md');
});

test('state.js claude-project-slug resolves long paths to the hashed dir', () => {
  const long = path.join(mkTmp(), 'd'.repeat(90), 'e'.repeat(90), 'repo');
  const repo = mkRepo(long);
  const config = mkTmp();
  const slug = lib.projectSlug(repo);
  const hashed = slug.slice(0, 200) + '-9f8e7d';
  fs.mkdirSync(path.join(config, 'projects', hashed), { recursive: true });
  const ok = run(STATE, ['claude-project-slug'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } });
  assertEq(ok.stdout.trim(), hashed);
  fs.mkdirSync(path.join(config, 'projects', slug.slice(0, 200) + '-000000'), { recursive: true });
  assertEq(run(STATE, ['claude-project-slug'], { cwd: repo, env: { CLAUDE_CONFIG_DIR: config } }).code, 1, 'ambiguous prefix fails');
});

console.log('\n4. recall — which transcripts count as the current project');

function recallFixture() {
  const base = mkTmp();
  const repo = mkRepo(path.join(base, 'app'));
  fs.mkdirSync(path.join(repo, 'web', 'src'), { recursive: true });
  const wt = path.join(base, 'app-wt');
  git(repo, 'worktree', 'add', '-q', wt);
  fs.mkdirSync(path.join(wt, 'web'), { recursive: true });
  const nested = mkRepo(path.join(repo, 'vendor', 'lib'));
  const sibling = path.join(base, 'app-old');
  fs.mkdirSync(sibling);
  const config = mkTmp();
  const projects = path.join(config, 'projects');
  const ids = {
    root: transcript(projects, lib.projectSlug(repo), { cwd: repo, title: 'ROOT_SESSION', prompt: 'root work', ts: '2026-09-20T10:00:00Z' }),
    sub: transcript(projects, lib.projectSlug(path.join(repo, 'web')), { cwd: path.join(repo, 'web'), title: 'SUBDIR_SESSION', prompt: 'web work', ts: '2026-09-21T10:00:00Z' }),
    wt: transcript(projects, lib.projectSlug(wt), { cwd: wt, title: 'WORKTREE_SESSION', prompt: 'wt work', ts: '2026-09-22T10:00:00Z' }),
    wtSub: transcript(projects, lib.projectSlug(path.join(wt, 'web')), { cwd: path.join(wt, 'web'), title: 'WORKTREE_SUBDIR_SESSION', prompt: 'wt web work', ts: '2026-09-22T12:00:00Z' }),
    nested: transcript(projects, lib.projectSlug(nested), { cwd: nested, title: 'NESTED_REPO_SESSION', prompt: 'nested work', ts: '2026-09-23T10:00:00Z' }),
    sibling: transcript(projects, lib.projectSlug(sibling), { cwd: sibling, title: 'SIBLING_SESSION', prompt: 'old work', ts: '2026-09-24T10:00:00Z' }),
  };
  return { base, repo, wt, config, projects, ids };
}

test('list from a subdir merges toplevel, subdirs and worktrees, newest first', () => {
  const f = recallFixture();
  const r = run(RECALL, ['list'], { cwd: path.join(f.repo, 'web', 'src'), env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, '4 session(s)');
  const order = ['WORKTREE_SUBDIR_SESSION', 'WORKTREE_SESSION', 'SUBDIR_SESSION', 'ROOT_SESSION'].map((t) => r.stdout.indexOf(`. ${t}\n`));
  if (order.some((i) => i < 0) || order.some((i, k) => k && order[k - 1] > i)) throw new Error(`order ${order}:\n${r.stdout}`);
  assertExcludes(r.stdout, 'SIBLING_SESSION', 'sibling checkout with a shared slug prefix');
  assertExcludes(r.stdout, 'NESTED_REPO_SESSION', 'nested git repo');
});

test('search covers the same dirs', () => {
  const f = recallFixture();
  const r = run(RECALL, ['search', 'work'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  for (const t of ['ROOT_SESSION', 'SUBDIR_SESSION', 'WORKTREE_SESSION', 'WORKTREE_SUBDIR_SESSION']) assertIncludes(r.stdout, t);
  assertExcludes(r.stdout, 'SIBLING_SESSION');
});

test('show finds a session filed under a worktree dir', () => {
  const f = recallFixture();
  const r = run(RECALL, ['show', f.ids.wt.slice(0, 8)], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, 'wt work');
});

test('show falls back to other projects when the current one has no transcripts', () => {
  const f = recallFixture();
  const empty = mkRepo(path.join(f.base, 'fresh'));
  const r = run(RECALL, ['show', f.ids.sibling], { cwd: empty, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, 'old work');
});

test('outside git only the cwd dir is read', () => {
  const f = recallFixture();
  const plain = path.join(f.base, 'notes');
  fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
  transcript(f.projects, lib.projectSlug(plain), { cwd: plain, title: 'PLAIN_SESSION', prompt: 'notes', ts: '2026-09-20T10:00:00Z' });
  transcript(f.projects, lib.projectSlug(path.join(plain, 'sub')), { cwd: path.join(plain, 'sub'), title: 'PLAIN_SUB_SESSION', prompt: 'sub notes', ts: '2026-09-21T10:00:00Z' });
  const r = run(RECALL, ['list'], { cwd: plain, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, 'PLAIN_SESSION');
  assertExcludes(r.stdout, 'PLAIN_SUB_SESSION');
});

test('--project matches a repo path with spaces through the slug', () => {
  const f = recallFixture();
  const spaced = path.join(f.base, 'my repo');
  fs.mkdirSync(spaced);
  transcript(f.projects, lib.projectSlug(spaced), { cwd: spaced, title: 'SPACED_SESSION', prompt: 'spaced', ts: '2026-09-20T10:00:00Z' });
  const r = run(RECALL, ['list', '--project', 'my repo'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, 'SPACED_SESSION');
});

test('--project expands to the named repo subdirs and worktrees', () => {
  const f = recallFixture();
  const elsewhere = mkRepo(path.join(f.base, 'elsewhere'));
  const r = run(RECALL, ['list', '--project', lib.projectSlug(f.repo)], { cwd: elsewhere, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0, `exit (stderr: ${r.stderr})`);
  assertIncludes(r.stdout, '4 session(s)');
  assertExcludes(r.stdout, 'SIBLING_SESSION');
});

test('a subdirectory still counts when its first transcript has no cwd', () => {
  const f = recallFixture();
  const docs = path.join(f.repo, 'docs');
  fs.mkdirSync(docs);
  const dirName = lib.projectSlug(docs);
  const bare = sessionId();
  write(path.join(f.projects, dirName, `${bare}.jsonl`), JSON.stringify({ type: 'summary', summary: 'no cwd yet' }) + '\n');
  transcript(f.projects, dirName, { cwd: docs, title: 'DOCS_SESSION', prompt: 'docs work', ts: '2026-09-23T12:00:00Z' });
  const r = run(RECALL, ['list'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertIncludes(r.stdout, 'DOCS_SESSION');
});

console.log('\n5. recall — transcript files and format drift');

test('orphaned and superseded transcripts are not sessions', () => {
  const f = recallFixture();
  const dir = path.join(f.projects, lib.projectSlug(f.repo));
  fs.copyFileSync(path.join(dir, `${f.ids.root}.jsonl`), path.join(dir, `${f.ids.root}.orphaned-1758800000-ab12.jsonl`));
  fs.copyFileSync(path.join(dir, `${f.ids.root}.jsonl`), path.join(dir, `${f.ids.root}.jsonl.superseded-1758800000`));
  const r = run(RECALL, ['list'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertIncludes(r.stdout, '4 session(s)');
  assertExcludes(r.stdout, 'orphaned');
  const p = run(RECALL, ['projects'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertIncludes(p.stdout, `${lib.projectSlug(f.repo)}\n   1 session(s)`);
});

function unreadable(projects, dirName, cwd, mtimeSec) {
  const file = path.join(projects, dirName, `${sessionId()}.jsonl`);
  write(file, JSON.stringify({ type: 'turn', cwd, timestamp: '2026-09-25T10:00:00Z', body: 'renamed record type' }) + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

test('newest transcripts without user or assistant records warn on stderr', () => {
  const f = recallFixture();
  const now = Date.now() / 1000;
  for (let i = 1; i <= 3; i++) unreadable(f.projects, lib.projectSlug(f.repo), f.repo, now + i);
  const r = run(RECALL, ['list'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0);
  assertIncludes(r.stderr, 'transcript format may have changed');
});

test('one session closed before its first prompt does not warn', () => {
  const f = recallFixture();
  unreadable(f.projects, lib.projectSlug(f.repo), f.repo, Date.now() / 1000 + 10);
  const r = run(RECALL, ['list'], { cwd: f.repo, env: { CLAUDE_CONFIG_DIR: f.config } });
  assertEq(r.code, 0);
  assertEq(r.stderr, '');
});

// ─── summary ──────────────────────────────────────────────────────────────────

tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
