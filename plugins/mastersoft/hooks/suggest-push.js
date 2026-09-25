'use strict';

// Org rule: pushes to protected branches require explicit user confirmation;
// feature-branch pushes go straight through so unattended runs never stall.
// Covers `git push` (any refspec form, chained commands, `git -C <dir>`) and
// the push `glab mr create --fill` / `--push` performs on its source branch,
// from the Bash and the PowerShell tool alike: on Windows without Git Bash,
// PowerShell is the only shell tool. When the destination can't be read
// reliably (cd / checkout / switch earlier in the same command, shell
// expansions, wildcards, nested shells, git not answering) it asks.
// Protected set: `push_protected_branches` in ORG_RULES.md (env
// MASTERSOFT_PUSH_PROTECTED_BRANCHES, or the plugin option of the same name),
// comma-separated; `name/*` matches a prefix, `*` matches every branch.
// The docs promise only a hook's `deny` and static `ask` rules in
// bypassPermissions mode; this hook's `ask` still stopped the push there on
// Claude Code 2.1.282, as a denial in a headless run.

const path = require('path');
const { readStdinJson, runGit: git } = require('./lib');
const { cfg } = require('./lib-org-rules');

const DEFAULT_PROTECTED_BRANCHES = 'main,master,develop,dev,staging,production,release/*';
const PROTECTED_PATTERNS = parsePatterns(
  cfg('MASTERSOFT_PUSH_PROTECTED_BRANCHES', 'push_protected_branches', DEFAULT_PROTECTED_BRANCHES, String),
);

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')']);
const COMMAND_PREFIXES = new Set(['command', 'exec', 'env', 'sudo', 'nohup', 'time', 'xargs']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);
const CONTEXT_CHANGERS = new Set(['cd', 'pushd', 'popd', 'chdir', 'sl', 'set-location', 'push-location', 'pop-location']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const GIT_REPO_SELECTORS = ['--git-dir', '--work-tree', '--namespace'];
const UNRESOLVED_SHELL = /[$`*?]/;
const SHELL_EVALUATORS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'eval', 'timeout', 'watch', 'ssh',
  'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression',
]);
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
const PUSH_ALL_FLAGS = new Set(['--all', '--mirror', '--branches']);
const GLAB_PUSH_FLAGS = new Set(['--fill', '-f', '--push', '--push=true']);
const GLAB_OPTS_WITH_VALUE = new Set([
  '--title', '-t', '--description', '-d', '--target-branch', '-b', '--source-branch', '-s',
  '--label', '-l', '--assignee', '-a', '--reviewer', '--milestone', '-m', '--template', '--repo', '-R',
]);
const ALL_BRANCHES = Symbol('all-branches');
const UNKNOWN = Symbol('unknown');

function parsePatterns(raw) {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function isProtected(branch, patterns) {
  return patterns.some((p) => {
    if (p === '*') return true;
    if (p.endsWith('/*')) return branch.startsWith(p.slice(0, -1));
    return branch === p;
  });
}

function shellWords(cmd, { powershell = false } = {}) {
  const words = [];
  let cur = null;
  let quote = null;
  let dropNext = false;
  const flush = () => {
    if (cur !== null) { if (dropNext) dropNext = false; else words.push(cur); }
    cur = null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && !powershell && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur = cur === null ? '' : cur; continue; }
    if (c === '\\' && !powershell && i + 1 < cmd.length) { cur = (cur === null ? '' : cur) + cmd[++i]; continue; }
    if (c === '>' || c === '<' || (c === '&' && cmd[i + 1] === '>')) {
      if (cur !== null && /^\d+$/.test(cur)) cur = null;
      flush();
      while (i + 1 < cmd.length && (cmd[i + 1] === '>' || cmd[i + 1] === '<')) i++;
      if (c === '&') i++;
      if (cmd[i + 1] === '&') { i++; while (i + 1 < cmd.length && /[\d-]/.test(cmd[i + 1])) i++; continue; }
      dropNext = true;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { flush(); words.push(two); i++; continue; }
    if (SEPARATORS.has(c)) { flush(); words.push(c); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur = (cur === null ? '' : cur) + c;
  }
  flush();
  return words;
}

function commandStart(seg) {
  let i = 0;
  while (i < seg.length) {
    const w = seg[i];
    if (SHELL_KEYWORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (COMMAND_PREFIXES.has(w)) {
      i++;
      while (i < seg.length && (seg[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]))) i++;
      continue;
    }
    break;
  }
  const rest = seg.slice(i);
  if (rest.length && path.basename(rest[0]) === 'git') rest[0] = 'git';
  return rest;
}

function segments(cmd, opts) {
  const out = [];
  let seg = [];
  for (const w of shellWords(cmd || '', opts)) {
    if (SEPARATORS.has(w)) { if (seg.length) out.push(commandStart(seg)); seg = []; continue; }
    seg.push(w);
  }
  if (seg.length) out.push(commandStart(seg));
  return out;
}

function commandName(seg) {
  return path.basename(seg[0] || '').toLowerCase().replace(/\.exe$/, '');
}

function looksLikeNestedGitPush(seg) {
  return SHELL_EVALUATORS.has(commandName(seg))
    && seg.some((w) => /(^|[\s/({])git(\s|$)/.test(w)) && seg.some((w) => /(^|\s)push(\s|$)/.test(w));
}

function refspecTarget(spec) {
  const s = spec.replace(/^\+/, '');
  if (s === ':' || s.includes('*')) return ALL_BRANCHES;
  if (UNRESOLVED_SHELL.test(s)) return UNKNOWN;
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  if (!dst || dst.startsWith('refs/tags/')) return null;
  return dst.replace(/^refs\/heads\//, '');
}

function gitInvocation(seg) {
  if (seg[0] !== 'git') return null;
  let dir = null;
  let opaque = false;
  let i = 1;
  for (; i < seg.length; i++) {
    const t = seg[i];
    if (t === '-C') { dir = seg[i + 1]; i++; continue; }
    if (t === '-c') { opaque = true; i++; continue; }
    if (GIT_REPO_SELECTORS.some((o) => t === o || t.startsWith(`${o}=`))) {
      opaque = true;
      if (!t.includes('=')) i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    break;
  }
  return { sub: seg[i], at: i, dir, opaque };
}

function parseGitPush(seg) {
  const inv = gitInvocation(seg);
  if (!inv || inv.sub !== 'push') return null;
  const { dir, opaque } = inv;
  const i = inv.at;
  if (opaque || (dir && UNRESOLVED_SHELL.test(dir))) return { dir, targets: UNKNOWN };
  const positional = [];
  let repo = null;
  let all = false;
  let tagsOnly = false;
  for (let j = i + 1; j < seg.length; j++) {
    const t = seg[j];
    if (t === '--repo') { repo = seg[j + 1] || null; j++; continue; }
    if (t.startsWith('--repo=')) { repo = t.slice('--repo='.length); continue; }
    if (PUSH_OPTS_WITH_VALUE.has(t)) { j++; continue; }
    if (PUSH_ALL_FLAGS.has(t)) { all = true; continue; }
    if (t === '--tags') { tagsOnly = true; continue; }
    if (t.startsWith('-')) continue;
    positional.push(t);
  }
  const remote = positional[0] || repo || null;
  const refspecs = positional.slice(1);
  if (all) return { dir, targets: ALL_BRANCHES };
  if (remote && UNRESOLVED_SHELL.test(remote)) return { dir, targets: UNKNOWN };
  if (refspecs.length === 0) return { dir, remote, targets: tagsOnly ? [] : ['@default'] };
  const targets = refspecs.map(refspecTarget).filter((t) => t !== null);
  if (targets.includes(ALL_BRANCHES)) return { dir, targets: ALL_BRANCHES };
  if (targets.includes(UNKNOWN)) return { dir, targets: UNKNOWN };
  return { dir, remote, targets };
}

function parseGlabPush(seg) {
  if (seg[0] !== 'glab' || seg[1] !== 'mr' || seg[2] !== 'create') return null;
  let pushes = false;
  let disabled = false;
  let source = null;
  for (let j = 3; j < seg.length; j++) {
    const t = seg[j];
    if (t === '--source-branch' || t === '-s') { source = seg[j + 1] || null; j++; continue; }
    if (t.startsWith('--source-branch=')) { source = t.slice('--source-branch='.length); continue; }
    if (GLAB_OPTS_WITH_VALUE.has(t)) { j++; continue; }
    if (t === '--push=false') disabled = true;
    else if (GLAB_PUSH_FLAGS.has(t)) pushes = true;
  }
  if (!pushes || disabled) return null;
  if (source && UNRESOLVED_SHELL.test(source)) return { dir: null, targets: UNKNOWN };
  return { dir: null, targets: [source || 'HEAD'] };
}

function changesContext(seg) {
  if (CONTEXT_CHANGERS.has(commandName(seg))) return true;
  const inv = gitInvocation(seg);
  return Boolean(inv && (inv.sub === 'checkout' || inv.sub === 'switch'));
}

function currentBranch(dir) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

function defaultPushTargets(dir, remoteArg) {
  const branch = currentBranch(dir);
  if (branch === null) return UNKNOWN;
  const remote = remoteArg
    || git(['config', '--get', `branch.${branch}.pushRemote`], dir)
    || git(['config', '--get', 'remote.pushDefault'], dir)
    || git(['config', '--get', `branch.${branch}.remote`], dir)
    || 'origin';
  const configured = git(['config', '--get-all', `remote.${remote}.push`], dir);
  if (configured) {
    const targets = configured.split('\n').map(refspecTarget).filter((t) => t !== null);
    if (targets.includes(ALL_BRANCHES)) return ALL_BRANCHES;
    if (targets.includes(UNKNOWN)) return UNKNOWN;
    return targets.map((t) => (t === 'HEAD' ? branch : t));
  }
  const mode = git(['config', '--get', 'push.default'], dir);
  if (mode === 'matching') return ALL_BRANCHES;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`], dir);
  const upstreamBranch = upstream && upstream.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : null;
  return upstreamBranch && upstreamBranch !== branch ? [branch, upstreamBranch] : [branch];
}

function resolveTargets(push, cwd) {
  if (push.targets === ALL_BRANCHES || push.targets === UNKNOWN) return push.targets;
  const dir = push.dir ? path.resolve(cwd, push.dir) : cwd;
  const out = [];
  for (const t of push.targets) {
    if (t === '@default') {
      const d = defaultPushTargets(dir, push.remote);
      if (d === ALL_BRANCHES || d === UNKNOWN) return d;
      out.push(...d);
    } else if (t === 'HEAD') {
      const b = currentBranch(dir);
      if (b === null) return UNKNOWN;
      out.push(b);
    } else {
      out.push(t);
    }
  }
  return out;
}

function pushDecision(cmd, cwd, patterns, opts) {
  let contextChanged = false;
  for (const seg of segments(cmd, opts)) {
    if (changesContext(seg)) { contextChanged = true; continue; }
    const push = parseGitPush(seg) || parseGlabPush(seg);
    if (!push) {
      if (looksLikeNestedGitPush(seg)) return { ask: true, branch: '(push inside a nested shell)' };
      continue;
    }
    if (contextChanged) return { ask: true, branch: '(directory or branch changes earlier in this command)' };
    const targets = resolveTargets(push, cwd);
    if (targets === ALL_BRANCHES) return { ask: true, branch: '(multiple branches)' };
    if (targets === UNKNOWN) return { ask: true, branch: '(unknown)' };
    const hit = targets.find((b) => isProtected(b, patterns));
    if (hit) return { ask: true, branch: hit };
  }
  return { ask: false };
}

function main() {
  if (process.env.MASTERSOFT_SKIP_PUSH_CHECK === '1') process.exit(0);

  const input = readStdinJson();
  if (!input || !SHELL_TOOLS.has(input.tool_name)) process.exit(0);

  const cmd = input.tool_input && input.tool_input.command;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || '.';
  const decision = pushDecision(cmd, cwd, PROTECTED_PATTERNS, { powershell: input.tool_name === 'PowerShell' });
  if (!decision.ask) process.exit(0);

  const reason = [
    `Confirm push to protected branch \`${decision.branch}\`?`,
    'Mastersoft org rule: pushes to protected branches (push_protected_branches in ORG_RULES.md) need confirmation; MASTERSOFT_SKIP_PUSH_CHECK=1 skips it.',
  ].join(' ');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
    systemMessage: `[Mastersoft] Push to protected branch \`${decision.branch}\` needs confirmation.`,
    terminalSequence: String.fromCharCode(7),
  }) + '\n');
  process.exit(0);
}

main();
