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
const MANAGED_SETTINGS_DIRS = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};
const MANAGED_CONTROL_KEYS = ['managedSourcesBehavior', 'wslInheritsWindowsSettings'];

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

/** managed-settings.json merged with managed-settings.d/*.json in alphabetical order, or null. */
function managedFileSettings() {
  const dir = process.env.MASTERSOFT_MANAGED_SETTINGS_DIR || MANAGED_SETTINGS_DIRS[process.platform];
  if (!dir) return null;
  const dropInDir = path.join(dir, 'managed-settings.d');
  let dropIns = [];
  try { dropIns = fs.readdirSync(dropInDir).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch {}
  const parts = [path.join(dir, 'managed-settings.json'), ...dropIns.map(f => path.join(dropInDir, f))]
    .map(readJsonFile).filter(Boolean);
  return parts.length ? Object.assign({}, ...parts) : null;
}

/**
 * The managed policy: the cached server-managed settings in
 * <config>/remote-settings.json, then the managed settings files. By default
 * only the highest source that sets a policy key applies; with
 * managedSourcesBehavior "merge" the higher source wins key by key. MDM plist
 * and registry policies are not read. MASTERSOFT_MANAGED_SETTINGS_DIR replaces
 * the system directory for tests only.
 */
function managedSettings() {
  const hasPolicy = s => s && Object.keys(s).some(k => !MANAGED_CONTROL_KEYS.includes(k));
  const sources = [readJsonFile(path.join(claudeConfigDir(), 'remote-settings.json')), managedFileSettings()]
    .filter(hasPolicy);
  if (!sources.length) return null;
  if (sources.some(s => s.managedSourcesBehavior === 'merge')) return Object.assign({}, ...sources.slice().reverse());
  return sources[0];
}

/**
 * Where Claude Code keeps .claude/settings.local.json for a session started in
 * cwd: the main checkout's root inside a git repository, so subdirectories and
 * worktrees share it. It stays in cwd outside git, on Windows, when that root
 * is the home directory, or when the root, its .git or its .claude isn't owned
 * by the user.
 */
function localSettingsRoot(cwd) {
  if (process.platform === 'win32' || !gitToplevel(cwd)) return cwd;
  const root = mainRepoRoot(cwd);
  if (root === realpathOr(os.homedir())) return cwd;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const foreign = p => { try { return uid !== null && fs.statSync(p).uid !== uid; } catch { return false; } };
  return [root, path.join(root, '.git'), path.join(root, '.claude')].some(foreign) ? cwd : root;
}

/**
 * Settings layers for a session started in cwd, highest precedence first:
 * managed, local (the root file, then one an older version left in cwd),
 * project (cwd's own .claude/settings.json, with no parent-directory fallback)
 * and user. --settings files are invisible to the plugin.
 */
function settingsLayers(cwd) {
  const dir = realpathOr(cwd);
  const localRoot = localSettingsRoot(dir);
  const localDirs = localRoot === dir ? [dir] : [localRoot, dir];
  return [
    { scope: 'managed', settings: managedSettings() },
    ...localDirs.map(d => ({ scope: 'local', settings: readJsonFile(path.join(d, '.claude', 'settings.local.json')) })),
    { scope: 'project', settings: readJsonFile(path.join(dir, '.claude', 'settings.json')) },
    { scope: 'user', settings: readJsonFile(path.join(claudeConfigDir(), 'settings.json')) },
  ].filter(layer => layer.settings);
}

/** The first value pick() returns across cwd's settings layers, optionally limited to some scopes. */
function settingValue(cwd, pick, scopes = null) {
  for (const { scope, settings } of settingsLayers(cwd)) {
    if (scopes && !scopes.includes(scope)) continue;
    const value = pick(settings);
    if (value !== undefined) return value;
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
  const forcedOn = env === '0' || env === 'false';
  if (!forcedOn && settingValue(cwd, s => s.autoMemoryEnabled) === false) return null;
  const custom = settingValue(cwd, s => s.autoMemoryDirectory);
  if (typeof custom === 'string' && custom.startsWith('~/')) return path.join(os.homedir(), custom.slice(2));
  if (typeof custom === 'string' && path.isAbsolute(custom)) return custom;
  const data = projectDataDir(mainRepoRoot(cwd));
  return data ? path.join(data, 'memory') : null;
}

const AGENTS_MD_PLUGIN = 'agents-md@builtin';
const AGENTS_MD_MODES = ['claude-md-or-agents-md', 'claude-md-and-agents-md', 'claude-md', 'managed-only'];
const DEFAULT_AGENTS_MD_MODE = 'claude-md-or-agents-md';

/**
 * The "Project instructions" setting for AGENTS.md for a session started in
 * cwd, and whether the built-in agents-md plugin is disabled.
 * instructionFiles counts only in managed and user settings; enabledPlugins in
 * any layer. A disabled plugin behaves like 'claude-md'.
 */
function agentsMdSetting(cwd) {
  const pluginDisabled = settingValue(cwd, s => (s.enabledPlugins || {})[AGENTS_MD_PLUGIN]) === false;
  const configured = settingValue(cwd,
    s => (((s.pluginConfigs || {})[AGENTS_MD_PLUGIN] || {}).options || {}).instructionFiles,
    ['managed', 'user']);
  const mode = pluginDisabled ? 'claude-md'
    : AGENTS_MD_MODES.includes(configured) ? configured : DEFAULT_AGENTS_MD_MODE;
  return { mode, pluginDisabled };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Rule files a directory contributes; at the home directory the .claude/ entries are the user-global files. */
function ruleFilesIn(dir) {
  const atHome = realpathOr(dir) === realpathOr(os.homedir());
  const pick = list => list
    .filter(f => !(atHome && f.startsWith('.claude' + path.sep)))
    .map(f => path.join(dir, f));
  return { claude: pick(CLAUDE_RULE_FILES), agents: pick(AGENTS_RULE_FILES) };
}

/**
 * Project instruction files for repoRoot and which of them Claude Code loads.
 * CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md always load, also from the
 * directories above. AGENTS.md and .claude/AGENTS.md load when none of those
 * exists here or above (the default), always with 'claude-md-and-agents-md',
 * never with 'claude-md'. 'managed-only' loads no project file at launch.
 * Returns absolute paths: { mode, pluginDisabled, present, inherited (rule
 * files above repoRoot), shadowedBy, claudeFiles, agentsFiles, files (loaded
 * entry points in repoRoot), candidates }.
 */
function projectRuleFiles(repoRoot, setting = agentsMdSetting(repoRoot)) {
  const { mode, pluginDisabled } = setting;
  const own = ruleFilesIn(repoRoot);
  const claudeFiles = own.claude.filter(isFile);
  const agentsFiles = own.agents.filter(isFile);
  const above = { claude: [], agents: [] };
  for (let dir = path.dirname(repoRoot); ; dir = path.dirname(dir)) {
    const found = ruleFilesIn(dir);
    above.claude.push(...found.claude.filter(isFile));
    above.agents.push(...found.agents.filter(isFile));
    if (path.dirname(dir) === dir) break;
  }
  const shadowedBy = claudeFiles[0] || above.claude[0] || null;
  const agentsLoad = mode === 'claude-md-and-agents-md'
    || (mode === DEFAULT_AGENTS_MD_MODE && !shadowedBy);
  const loaded = agentsLoad ? [...claudeFiles, ...agentsFiles] : claudeFiles;
  return {
    mode,
    pluginDisabled,
    present: claudeFiles.length + agentsFiles.length > 0,
    inherited: [...above.claude, ...above.agents],
    shadowedBy,
    claudeFiles,
    agentsFiles,
    files: mode === 'managed-only' ? [] : loaded,
    candidates: [...own.claude, ...own.agents],
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
  readStdinJson, readStdinJsonAsync, loadState, saveState, resolveStateDir, runGit, gitToplevel, resolveRepoRoot, realpathOr,
  projectRuleFiles, agentsMdSetting, mainRepoRoot, claudeConfigDir, pluginsRoot, projectSlug, projectDataDir,
  autoMemoryDir,
};
