'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStdinJsonAsync } = require('./lib');

const GIT_TIMEOUT_MS = 300;
const DEFAULT_BRANCH_NAME = 'main';
const DEFAULT_MODEL_LABEL = 'Model';
const DEFAULT_USERNAME = 'user';
const CONTEXT_MAX_TOKENS = 200000;
const TREAT_EMPTY_CONTEXT_AS_NEW_CHAT = true;

const DEFAULT_SEGMENTS = ['model', 'folder', 'branch', 'context', 'cost'];

const ICON_SETS = {
  nerd: {
    user: '\u{f0004}',
    host: '\u{f048b}',
    folder: '\u{f024b}',
    repo: '\u{f02a4}',
    branch: '\u{f062c}',
    model: '\u{f09d1}',
    cost: '\u{f0114}',
    block: '\u{f0954}',
    tok_in: '\u{f0045}',
    tok_out: '\u{f005d}',
    lines_add: '\u{f0416}',
    lines_remove: '\u{f0375}',
    used: ['\u{f0130}', '\u{f0a9e}', '\u{f0a9f}', '\u{f0aa0}', '\u{f0aa1}', '\u{f0aa2}', '\u{f0aa3}', '\u{f0aa4}', '\u{f0aa5}'],
    battery: ['\u{f008e}', '\u{f007a}', '\u{f007b}', '\u{f007d}', '\u{f007d}', '\u{f007e}', '\u{f007f}', '\u{f0080}', '\u{f0081}', '\u{f0082}', '\u{f0079}'],
  },
  emoji: {
    user: '👤',
    host: '🖥 ',
    folder: '📁',
    repo: '📦',
    branch: '🌿',
    model: '🤖',
    cost: '💵',
    block: '⏳',
    tok_in: '⬇️ ',
    tok_out: '⬆️ ',
    lines_add: '➕',
    lines_remove: '➖',
    used: ['⚪', '🟢', '🟢', '🟡', '🟡', '🟠', '🟠', '🔴', '🔴'],
    battery: ['🪫', '🔋', '🔋', '🔋', '🔋', '🔋', '🔋', '🔋', '🔋', '🔋', '🔋'],
  },
  ascii: {
    user: '@',
    host: '⌁',
    folder: '▸',
    repo: '⬢',
    branch: '⑂',
    model: '⚡',
    cost: '$',
    block: '⧗',
    tok_in: '↓',
    tok_out: '↑',
    lines_add: '+',
    lines_remove: '-',
    used: ['·', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
    battery: ['▁', '▂', '▂', '▃', '▃', '▄', '▅', '▆', '▇', '█', '█'],
  },
  none: {
    user: '', host: '', folder: '', repo: '', branch: '', model: '',
    cost: '', block: '', tok_in: '', tok_out: '', lines_add: '', lines_remove: '',
    used: ['', '', '', '', '', '', '', '', ''],
    battery: ['', '', '', '', '', '', '', '', '', '', ''],
  },
};

function resolveIconSet() {
  const name = (process.env.CLAUDE_STATUSLINE_ICONS || 'emoji').toLowerCase();
  return ICON_SETS[name] || ICON_SETS.emoji;
}

const ICONS = resolveIconSet();

// ANSI 16-color slots — terminal theme controls actual RGB.
// Colors follow terminal theme automatically (switch theme → statusline updates).
const ANSI_RESET = '\x1b[0m';
const c = (n) => `\x1b[38;5;${n}m`;
const WHITE = c(15);
const COL_USER = c(4);         // blue
const COL_HOST = c(6);         // cyan
const COL_FOLDER = c(5);       // magenta
const COL_REPO = c(2);         // green
const COL_BRANCH = c(3);       // yellow
const COL_MODEL = c(13);       // bright magenta
const COL_ICON_COST = c(11);   // bright yellow
const COL_TIN = c(14);         // bright cyan
const COL_TOUT = c(10);        // bright green
const COL_ICON_BLOCK = c(12);  // bright blue
const COL_CONTEXT_GREEN = c(2);
const COL_CONTEXT_YELLOW = c(3);
const COL_CONTEXT_RED = c(1);

const gitCache = Object.create(null);

function extractContextFromModel(modelId) {
  if (!modelId) return CONTEXT_MAX_TOKENS;
  const m = modelId.toLowerCase().match(/\[(\d+)([mk])\]/);
  if (m) {
    const value = parseInt(m[1], 10);
    return m[2] === 'm' ? value * 1000000 : value * 1000;
  }
  return CONTEXT_MAX_TOKENS;
}

function runGitSync(args, cwd) {
  const key = args.join('\0') + '\0' + cwd;
  if (key in gitCache) return gitCache[key];
  let result = null;
  try {
    result = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { result = null; }
  gitCache[key] = result;
  return result;
}

function isGitRepo(cwd) {
  return runGitSync(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

function parseGitStatus(cwd) {
  const status = runGitSync(['status', '--porcelain=1', '-b'], cwd);
  if (status == null) return null;

  const stashList = runGitSync(['stash', 'list'], cwd);

  const result = {
    branch: DEFAULT_BRANCH_NAME,
    ahead: 0,
    behind: 0,
    staged: false,
    modified: false,
    untracked: false,
    conflicts: false,
    stashCount: stashList ? stashList.split('\n').length : 0,
  };

  if (!status) return result;
  const lines = status.split('\n');
  if (!lines.length) return result;

  if (lines[0].startsWith('##')) {
    const head = lines[0].slice(2).trim();
    if (head.includes('...')) {
      result.branch = head.split('...')[0].trim();
    } else {
      result.branch = head.split(/\s/)[0].trim();
    }
    const bracketIdx = head.indexOf('[');
    const bracketEnd = head.indexOf(']');
    if (bracketIdx !== -1 && bracketEnd !== -1) {
      const parts = head.slice(bracketIdx + 1, bracketEnd).split(', ');
      for (const part of parts) {
        if (part.startsWith('ahead ')) result.ahead = parseInt(part.slice(6), 10);
        else if (part.startsWith('behind ')) result.behind = parseInt(part.slice(7), 10);
      }
    }
  }

  const conflictMarkers = new Set(['DD', 'AA', 'UU', 'AU', 'UA', 'UD', 'DU']);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith('??')) {
      result.untracked = true;
    } else {
      const xy = line.slice(0, 2);
      if (conflictMarkers.has(xy)) result.conflicts = true;
      if (xy[0] !== ' ' && xy[0] !== '?') result.staged = true;
      if (xy[1] !== ' ' && xy[1] !== '?') result.modified = true;
    }
  }

  return result;
}

function getRepoName(cwd) {
  const remoteUrl = runGitSync(['remote', 'get-url', 'origin'], cwd);
  if (!remoteUrl) return '';
  let name = remoteUrl.replace(/\/+$/, '').split('/').pop();
  if (name.endsWith('.git')) name = name.slice(0, -4);
  return name;
}

function buildGitSymbols(g) {
  const parts = [];
  if (g.modified) parts.push('*');
  if (g.staged) parts.push('+');
  if (g.untracked) parts.push('?');
  if (g.conflicts) parts.push('!');
  if (g.ahead) parts.push(`↑${g.ahead}`);
  if (g.behind) parts.push(`↓${g.behind}`);
  if (g.stashCount) parts.push(`≡${g.stashCount}`);
  return parts.join('') || '✓';
}

function formatCompact(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

function getUsedIcon(percentage) {
  return ICONS.used[Math.min(8, Math.floor(percentage / 12))];
}

function getBatteryIcon(percentage) {
  return ICONS.battery[Math.min(10, Math.floor(percentage / 10))];
}

function calculateContextTokens(transcriptPath, modelId) {
  if (!transcriptPath) return null;
  try { if (!fs.existsSync(transcriptPath)) return null; } catch { return null; }

  const contextMaxTokens = extractContextFromModel(modelId);

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const message = entry.message || {};
      const usage = message.usage;
      if (!usage || !usage.input_tokens) continue;
      if (entry.isSidechain === true) continue;

      const inputTokens = usage.input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      const contextTokens = inputTokens + cacheRead + cacheCreation;

      const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextMaxTokens) * 100)));
      return {
        input_tokens: contextTokens,
        percentage,
        context_left_percentage: Math.max(0, 100 - percentage),
        max_tokens: contextMaxTokens,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function computeContextInfo(data) {
  const modelId = ((data.model || {}).id) || '';
  const contextWindow = data.context_window;
  let usedPercent, usedTokens, contextMaxTokens;

  if (contextWindow && 'used_percentage' in contextWindow && 'remaining_percentage' in contextWindow) {
    usedPercent = parseInt(contextWindow.used_percentage, 10) || 0;
    contextMaxTokens = contextWindow.context_window_size || extractContextFromModel(modelId);
    usedTokens = contextMaxTokens ? Math.round((usedPercent / 100) * contextMaxTokens) : 0;
  } else {
    contextMaxTokens = extractContextFromModel(modelId);
    usedTokens = 0;

    if (contextWindow && 'current_usage' in contextWindow) {
      const cu = contextWindow.current_usage || {};
      try {
        usedTokens = (parseInt(cu.input_tokens, 10) || 0)
          + (parseInt(cu.cache_read_input_tokens, 10) || 0)
          + (parseInt(cu.cache_creation_input_tokens, 10) || 0);
      } catch { usedTokens = 0; }
      if (contextWindow.context_window_size) contextMaxTokens = contextWindow.context_window_size;
    } else if (TREAT_EMPTY_CONTEXT_AS_NEW_CHAT) {
      const transcriptPath = data.transcript_path;
      if (transcriptPath) {
        const info = calculateContextTokens(transcriptPath, modelId);
        if (info) {
          usedTokens = info.input_tokens;
          contextMaxTokens = info.max_tokens;
        }
      }
    }

    if (!contextMaxTokens || contextMaxTokens <= 0) contextMaxTokens = CONTEXT_MAX_TOKENS;
    usedPercent = Math.min(100, Math.max(0, Math.round((usedTokens / contextMaxTokens) * 100)));
  }

  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remainingTokens = Math.max(0, contextMaxTokens - usedTokens);
  return { usedPercent, usedTokens, remainingPercent, remainingTokens, contextMaxTokens };
}

const BLOCK_DURATION_MS = 5 * 60 * 60 * 1000;
const PROJECTS_DIRS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.config', 'claude', 'projects'),
];
const BLOCK_CACHE_PATH = path.join(os.homedir(), '.claude', '.block-cache.json');
const BLOCK_CACHE_TTL_MS = 5000;

function floorToHour(ms) {
  return ms - (ms % (60 * 60 * 1000));
}

function scanProjectEntries(cutoff) {
  const timestamps = [];
  let latestResetTime = null;

  for (const projectsDir of PROJECTS_DIRS) {
    try { if (!fs.existsSync(projectsDir)) continue; } catch { continue; }

    for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsDir, dir.name);
      for (const file of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const filePath = path.join(dirPath, file.name);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) continue;
          const lines = fs.readFileSync(filePath, 'utf8').split('\n');
          for (const line of lines) {
            if (!line) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            const ts = entry.timestamp || (entry.snapshot && entry.snapshot.timestamp);
            if (ts) timestamps.push(new Date(ts).getTime());
            if (entry.isApiErrorMessage === true) {
              const content = ((entry.message || {}).content) || [];
              for (const chunk of content) {
                if (chunk.text && chunk.text.includes('Claude AI usage limit reached')) {
                  const m = chunk.text.match(/\|(\d+)/);
                  if (m) {
                    const rt = parseInt(m[1], 10) * 1000;
                    if (!latestResetTime || rt > latestResetTime) latestResetTime = rt;
                  }
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  return { timestamps, latestResetTime };
}

function computeBlockTimeLeft() {
  const now = Date.now();
  const cutoff = now - (BLOCK_DURATION_MS + 60 * 60 * 1000);
  const { timestamps, latestResetTime } = scanProjectEntries(cutoff);

  if (!timestamps.length) return null;
  timestamps.sort((a, b) => a - b);

  let blockStart = floorToHour(timestamps[0]);
  let lastEntryTime = timestamps[0];

  for (let i = 1; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const timeSinceBlockStart = ts - blockStart;
    const timeSinceLastEntry = ts - lastEntryTime;

    if (timeSinceBlockStart > BLOCK_DURATION_MS || timeSinceLastEntry > BLOCK_DURATION_MS) {
      blockStart = floorToHour(ts);
    }
    lastEntryTime = ts;
  }

  const endTime = blockStart + BLOCK_DURATION_MS;
  if (endTime <= now) return null;

  const effectiveEnd = (latestResetTime && latestResetTime > blockStart && latestResetTime <= endTime + 60 * 60 * 1000)
    ? latestResetTime
    : endTime;
  if (effectiveEnd <= now) return null;

  const remainingSec = Math.max(0, Math.floor((effectiveEnd - now) / 1000));
  const remH = Math.floor(remainingSec / 3600);
  const remM = Math.floor((remainingSec % 3600) / 60);
  return remH ? `${remH}h ${remM}m left` : `${remM}m left`;
}

function getBlockTimeLeft() {
  try {
    try {
      const raw = fs.readFileSync(BLOCK_CACHE_PATH, 'utf8');
      const cache = JSON.parse(raw);
      if (Date.now() - cache.ts < BLOCK_CACHE_TTL_MS) return cache.result;
    } catch { /* no cache or stale */ }

    const result = computeBlockTimeLeft();

    try {
      fs.writeFileSync(BLOCK_CACHE_PATH, JSON.stringify({ ts: Date.now(), result }));
    } catch { /* skip */ }

    return result;
  } catch {
    return null;
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function getTerminalWidth() {
  try {
    const ttyFd = fs.openSync('/dev/tty', 'r');
    try {
      const out = execFileSync('stty', ['size'], {
        encoding: 'utf8', timeout: 200,
        stdio: [ttyFd, 'pipe', 'pipe'],
      }).trim();
      const cols = parseInt(out.split(/\s+/)[1], 10);
      if (cols > 0) return cols;
    } finally { fs.closeSync(ttyFd); }
  } catch { /* /dev/tty unavailable */ }
  if (process.stderr.columns) return process.stderr.columns;
  if (process.env.COLUMNS) return parseInt(process.env.COLUMNS, 10) || 120;
  return 120;
}

function getHostname() {
  try {
    return execFileSync('hostname', ['-s'], { encoding: 'utf8', timeout: 500, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return os.hostname().split('.')[0];
  }
}

// Segment renderers — each returns a string or empty if nothing to show.
// Context `ctx` carries precomputed values shared across segments (git state, context info).

function iconPrefix(icon, color) {
  if (!icon) return '';
  return `${color}${icon}${WHITE} `;
}

function renderUser() {
  const user = process.env.USER || process.env.USERNAME || DEFAULT_USERNAME;
  return `${iconPrefix(ICONS.user, COL_USER)}${user}`;
}

function renderHost() {
  return `${iconPrefix(ICONS.host, COL_HOST)}${getHostname()}`;
}

function renderFolder(_data, ctx) {
  return `${iconPrefix(ICONS.folder, COL_FOLDER)}${ctx.folder}`;
}

function renderRepo(_data, ctx) {
  const git = ctx.git;
  if (!git || !git.repo) return '';
  return `${iconPrefix(ICONS.repo, COL_REPO)}${git.repo}`;
}

function renderBranch(_data, ctx) {
  const git = ctx.git;
  if (!git || !git.status) return '';
  const { branch } = git.status;
  const symbols = buildGitSymbols(git.status);
  return `${iconPrefix(ICONS.branch, COL_BRANCH)}${branch} ${COL_BRANCH}[${symbols}]${WHITE}`;
}

function renderModel(data) {
  const model = ((data.model || {}).display_name) || ((data.model || {}).id) || DEFAULT_MODEL_LABEL;
  return `${iconPrefix(ICONS.model, COL_MODEL)}${model}`;
}

function renderContext(_data, ctx) {
  const info = ctx.context;
  if (!info) return '';
  const { usedPercent, usedTokens } = info;
  const icon = getUsedIcon(usedPercent);
  const col = usedPercent <= 50 ? COL_CONTEXT_GREEN : usedPercent <= 80 ? COL_CONTEXT_YELLOW : COL_CONTEXT_RED;
  return `${iconPrefix(icon, col)}${formatCompact(usedTokens)} (${usedPercent}%)`;
}

function renderContextRemaining(_data, ctx) {
  const info = ctx.context;
  if (!info) return '';
  const { remainingPercent, remainingTokens } = info;
  const icon = getBatteryIcon(remainingPercent);
  const col = remainingPercent >= 50 ? COL_CONTEXT_GREEN : remainingPercent >= 20 ? COL_CONTEXT_YELLOW : COL_CONTEXT_RED;
  return `${iconPrefix(icon, col)}${formatCompact(remainingTokens)} (${remainingPercent}%)`;
}

function renderRateLimit(data) {
  const rl = data.rate_limits;
  if (rl && rl.five_hour) {
    const pct = Math.round(rl.five_hour.used_percentage || 0);
    const resetAt = rl.five_hour.resets_at;
    const col = pct <= 50 ? COL_CONTEXT_GREEN : pct <= 80 ? COL_CONTEXT_YELLOW : COL_CONTEXT_RED;
    let label = `${pct}%`;
    if (resetAt) {
      const remainingSec = Math.max(0, resetAt - Math.floor(Date.now() / 1000));
      if (remainingSec > 0) {
        const remH = Math.floor(remainingSec / 3600);
        const remM = Math.floor((remainingSec % 3600) / 60);
        label += ` (${remH ? `${remH}h ${remM}m` : `${remM}m`})`;
      }
    }
    return `${iconPrefix(ICONS.block, col)}${label}`;
  }

  const timeLeft = getBlockTimeLeft();
  if (!timeLeft) return '';
  return `${iconPrefix(ICONS.block, COL_ICON_BLOCK)}${timeLeft}`;
}

function renderCost(data) {
  const cost = data.cost || {};
  const costUsd = parseFloat(cost.total_cost_usd) || 0;
  return `${iconPrefix(ICONS.cost, COL_ICON_COST)}$${costUsd.toFixed(2)} chat`;
}

function renderTokensIn(data) {
  const cw = data.context_window || {};
  const total = cw.total_input_tokens || 0;
  return `${iconPrefix(ICONS.tok_in, COL_TIN)}${formatCompact(total)}`;
}

function renderTokensOut(data) {
  const cw = data.context_window || {};
  const total = cw.total_output_tokens || 0;
  return `${iconPrefix(ICONS.tok_out, COL_TOUT)}${formatCompact(total)}`;
}

function renderLines(data) {
  const cost = data.cost || {};
  const added = cost.total_lines_added || 0;
  const removed = cost.total_lines_removed || 0;
  if (!added && !removed) return '';
  return `${iconPrefix(ICONS.lines_add, COL_CONTEXT_GREEN)}${added} ${iconPrefix(ICONS.lines_remove, COL_CONTEXT_RED)}${removed}`;
}

const SEGMENT_REGISTRY = {
  user: renderUser,
  host: renderHost,
  folder: renderFolder,
  repo: renderRepo,
  branch: renderBranch,
  model: renderModel,
  context: renderContext,
  context_remaining: renderContextRemaining,
  rate_limit: renderRateLimit,
  cost: renderCost,
  tokens_in: renderTokensIn,
  tokens_out: renderTokensOut,
  lines: renderLines,
};

function parseSegmentList(envValue) {
  if (envValue == null) return DEFAULT_SEGMENTS.slice();
  const names = envValue.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    if (!(name in SEGMENT_REGISTRY)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function buildContext(data) {
  const cwd = ((data.workspace || {}).current_dir) || data.cwd || process.cwd();
  const folder = path.basename(cwd.replace(/\/+$/, '')) || cwd;

  let gitCached;
  let gitComputed = false;
  let contextCached;
  let contextComputed = false;

  return {
    cwd,
    folder,
    get git() {
      if (gitComputed) return gitCached;
      gitComputed = true;
      if (isGitRepo(cwd)) {
        gitCached = { repo: getRepoName(cwd), status: parseGitStatus(cwd) };
      } else {
        gitCached = null;
      }
      return gitCached;
    },
    get context() {
      if (contextComputed) return contextCached;
      contextComputed = true;
      try { contextCached = computeContextInfo(data); } catch { contextCached = null; }
      return contextCached;
    },
  };
}

async function main() {
  const data = await readStdinJsonAsync();

  if (!data) {
    process.stdout.write('Claude Code\n');
    process.exit(0);
  }

  if (process.env.CLAUDE_STATUSLINE_DEBUG) {
    try {
      const _debugWidth = getTerminalWidth();
      fs.writeFileSync(path.join(os.homedir(), '.claude', 'statusline_debug.json'), JSON.stringify({ _detectedWidth: _debugWidth, ...data }, null, 2));
    } catch { /* skip */ }
  }

  const ctx = buildContext(data);
  const segmentNames = parseSegmentList(process.env.CLAUDE_STATUSLINE_SEGMENTS);

  const elements = [];
  for (const name of segmentNames) {
    const fn = SEGMENT_REGISTRY[name];
    let out;
    try { out = fn(data, ctx); } catch { out = ''; }
    if (out) elements.push(out);
  }

  const SEP = '  ';
  const termWidth = getTerminalWidth();
  const sepLen = SEP.length;
  const lines = [];
  let currentLine = '';
  let currentWidth = 0;

  for (const el of elements) {
    const elWidth = stripAnsi(el).length;
    const needed = currentWidth === 0 ? elWidth : sepLen + elWidth;

    if (currentWidth > 0 && currentWidth + needed > termWidth) {
      lines.push(currentLine + ANSI_RESET);
      currentLine = el;
      currentWidth = elWidth;
    } else {
      currentLine += (currentWidth === 0 ? '' : SEP) + el;
      currentWidth += needed;
    }
  }
  if (currentLine) lines.push(currentLine + ANSI_RESET);

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

main();
