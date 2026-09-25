'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STDIN_TIMEOUT_MS = 2000;
const CLAUDE_RULE_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];
const AGENTS_RULE_FILES = ['AGENTS.md', path.join('.claude', 'AGENTS.md')];
const PROJECT_SLUG_MAX = 200;
const PROJECT_DIR_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const GIT_TIMEOUT_MS = 3000;

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

/** git's trimmed stdout in cwd, or null when git fails or runs past GIT_TIMEOUT_MS. */
function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function gitToplevel(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Resolve the per-repo state KEY (state.__repos[<repoRoot>]) identically in
// EVERY execution context — the lint-engine hook AND the Bash-tool-spawned
// scripts/state.js record-*. Like resolveStateDir, it must NOT depend on a
// Claude-Code-injected var: CLAUDE_PROJECT_DIR is present in the hook process
// but absent in the skill's Bash subprocess, so preferring it (as the old code
// did) split the __repos key between writer and reader exactly the way
// CLAUDE_PLUGIN_DATA split the state dir — the recorded timestamp lands under a
// different key than the hook reads and the signal re-fires forever. Key off
// `git rev-parse --show-toplevel` from the same cwd both sides pass (a subdir
// collapses to the toplevel; a linked worktree keeps its own toplevel), then
// realpath so /var vs /private/var and other symlink forms match across sessions.
function resolveRepoRoot(cwd) {
  let p = gitToplevel(cwd) || cwd;
  try { p = fs.realpathSync(p); } catch {}
  return p;
}

/** The main working tree for cwd, shared by all its linked worktrees; the toplevel otherwise. */
function mainRepoRoot(cwd) {
  const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (common && path.basename(common) === '.git') return realpathOr(path.dirname(common));
  return resolveRepoRoot(cwd);
}

/** Claude Code's config directory: CLAUDE_CONFIG_DIR, else ~/.claude. */
function claudeConfigDir() {
  return (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
}

/** Claude Code's plugins root: CLAUDE_CODE_PLUGIN_CACHE_DIR, else <config>/plugins. */
function pluginsRoot() {
  return (process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || '').trim() || path.join(claudeConfigDir(), 'plugins');
}

/** The <project> name Claude Code derives from a directory: every non-alphanumeric character becomes '-'. */
function projectSlug(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * <config>/projects/<project> for a directory, where Claude Code keeps its
 * transcripts and auto memory. CLAUDE_CODE_PROJECT_DIR_NAME replaces the
 * derived name when CLAUDE_CONFIG_DIR is also set. A derived name over 200
 * characters is truncated with an undocumented hash, so it resolves to the one
 * existing directory that shares its first 200 characters; null when none or
 * several do, because the hash can't tell them apart.
 */
function projectDataDir(dir) {
  const root = path.join(claudeConfigDir(), 'projects');
  const pinned = (process.env.CLAUDE_CODE_PROJECT_DIR_NAME || '').trim();
  if (pinned && (process.env.CLAUDE_CONFIG_DIR || '').trim()
    && PROJECT_DIR_NAME_RE.test(pinned) && !WINDOWS_DEVICE_NAME_RE.test(pinned)) {
    return path.join(root, pinned);
  }
  const slug = projectSlug(dir);
  if (slug.length <= PROJECT_SLUG_MAX) return path.join(root, slug);
  const prefix = slug.slice(0, PROJECT_SLUG_MAX);
  try {
    const hits = fs.readdirSync(root).filter(name => name.startsWith(prefix));
    return hits.length === 1 ? path.join(root, hits[0]) : null;
  } catch { return null; }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** First value of a settings key across local, project and user settings, in Claude Code's precedence order. */
function settingValue(repoRoot, key) {
  const files = [
    path.join(repoRoot, '.claude', 'settings.local.json'),
    path.join(repoRoot, '.claude', 'settings.json'),
    path.join(claudeConfigDir(), 'settings.json'),
  ];
  for (const file of files) {
    const settings = readJsonFile(file);
    if (settings && settings[key] !== undefined) return settings[key];
  }
  return undefined;
}

/**
 * The auto-memory directory Claude Code uses for cwd, or null when auto
 * memory is off (CLAUDE_CODE_DISABLE_AUTO_MEMORY, autoMemoryEnabled: false).
 * autoMemoryDirectory wins; otherwise <project>/memory of the main working
 * tree, which every linked worktree and subdirectory shares.
 */
function autoMemoryDir(cwd) {
  const env = (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || '').trim().toLowerCase();
  if (env === '1' || env === 'true') return null;
  const root = mainRepoRoot(cwd);
  const forcedOn = env === '0' || env === 'false';
  if (!forcedOn && settingValue(root, 'autoMemoryEnabled') === false) return null;
  const custom = settingValue(root, 'autoMemoryDirectory');
  if (typeof custom === 'string' && custom.startsWith('~/')) return path.join(os.homedir(), custom.slice(2));
  if (typeof custom === 'string' && path.isAbsolute(custom)) return custom;
  const data = projectDataDir(root);
  return data ? path.join(data, 'memory') : null;
}

const AGENTS_MD_PLUGIN = 'agents-md@builtin';
const AGENTS_MD_MODES = ['claude-md-or-agents-md', 'claude-md-and-agents-md', 'claude-md', 'managed-only'];
const DEFAULT_AGENTS_MD_MODE = 'claude-md-or-agents-md';

/**
 * The user's "Project instructions" setting for AGENTS.md, read from
 * <config>/settings.json (Claude Code ignores it in project settings).
 * A disabled built-in agents-md plugin behaves like 'claude-md'.
 */
function agentsMdMode() {
  const settings = readJsonFile(path.join(claudeConfigDir(), 'settings.json')) || {};
  if (settings.enabledPlugins && settings.enabledPlugins[AGENTS_MD_PLUGIN] === false) return 'claude-md';
  const configs = settings.pluginConfigs && settings.pluginConfigs[AGENTS_MD_PLUGIN];
  const mode = configs && configs.options && configs.options.instructionFiles;
  return AGENTS_MD_MODES.includes(mode) ? mode : DEFAULT_AGENTS_MD_MODE;
}

/**
 * Project instruction files at repoRoot and which of them Claude Code loads.
 * CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md always load. AGENTS.md and
 * .claude/AGENTS.md load when no CLAUDE.md file exists (the default), always
 * with 'claude-md-and-agents-md', never with 'claude-md' / 'managed-only'.
 * At the home directory the .claude/ entries are the user-global files, so
 * they are not project rules. Returns absolute paths: { mode, present,
 * claudeFiles, agentsFiles, files (loaded entry points), candidates }.
 */
function projectRuleFiles(repoRoot, mode = agentsMdMode()) {
  const atHome = path.resolve(repoRoot) === path.resolve(os.homedir());
  const local = list => list.filter(f => !(atHome && f.startsWith('.claude' + path.sep)));
  const abs = list => local(list).map(f => path.join(repoRoot, f));
  const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const claudeFiles = abs(CLAUDE_RULE_FILES).filter(isFile);
  const agentsFiles = abs(AGENTS_RULE_FILES).filter(isFile);
  const agentsLoad = mode === 'claude-md-and-agents-md'
    || (mode === DEFAULT_AGENTS_MD_MODE && !claudeFiles.length);
  return {
    mode,
    present: claudeFiles.length + agentsFiles.length > 0,
    claudeFiles,
    agentsFiles,
    files: agentsLoad ? [...claudeFiles, ...agentsFiles] : claudeFiles,
    candidates: abs([...CLAUDE_RULE_FILES, ...AGENTS_RULE_FILES]),
  };
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

module.exports = {
  readStdinJson, readStdinJsonAsync, loadState, saveState, resolveStateDir, runGit, gitToplevel, resolveRepoRoot, projectRuleFiles,
  mainRepoRoot, claudeConfigDir, pluginsRoot, projectSlug, projectDataDir, autoMemoryDir,
};
