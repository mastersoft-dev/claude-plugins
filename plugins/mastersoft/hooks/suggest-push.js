'use strict';

// Org rule: pushes to protected branches require explicit user confirmation;
// feature-branch pushes go straight through so unattended runs never stall.
// Covers `git push` (any refspec form, chained commands, `git -C <dir>`) and
// the push `glab mr create --fill` / `--push` performs on its source branch.
// Protected set: `push_protected_branches` in ORG_RULES.md (env
// MASTERSOFT_PUSH_PROTECTED_BRANCHES), comma-separated; `name/*` matches a
// prefix, `*` matches every branch.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readStdinJson } = require('./lib');
const { cfg } = require('./lib-org-rules');

const DEFAULT_PROTECTED_BRANCHES = 'main,master,develop,dev,staging,production,release/*';
const PROTECTED_PATTERNS = parsePatterns(
  cfg('MASTERSOFT_PUSH_PROTECTED_BRANCHES', 'push_protected_branches', DEFAULT_PROTECTED_BRANCHES, String),
);

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const COMMAND_PREFIXES = new Set(['command', 'exec', 'env', 'sudo', 'nohup', 'time', 'xargs']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);
const GIT_REPO_SELECTORS = ['--git-dir', '--work-tree', '--namespace'];
const UNRESOLVED_SHELL = /[$`*?]/;
const BRANCH_CREATE_FLAGS = new Set(['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan']);
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_ALL_FLAGS = new Set(['--all', '--mirror', '--branches']);
const GLAB_PUSH_FLAGS = new Set(['--fill', '-f', '--push', '--push=true']);
const GLAB_OPTS_WITH_VALUE = new Set([
  '--title', '-t', '--description', '-d', '--target-branch', '-b', '--source-branch', '-s',
  '--label', '-l', '--assignee', '-a', '--reviewer', '--milestone', '-m', '--template', '--repo', '-R',
]);
const ALL_BRANCHES = Symbol('all-branches');
const UNKNOWN = Symbol('unknown');

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

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

function shellWords(cmd) {
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
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur = cur === null ? '' : cur; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur = (cur === null ? '' : cur) + cmd[++i]; continue; }
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
  if (rest.length) rest[0] = rest[0].replace(/^[({]+/, '');
  if (rest.length && path.basename(rest[0]) === 'git') rest[0] = 'git';
  return rest;
}

function segments(cmd) {
  const out = [];
  let seg = [];
  for (const w of shellWords(cmd || '')) {
    if (SEPARATORS.has(w)) { if (seg.length) out.push(commandStart(seg)); seg = []; continue; }
    seg.push(w);
  }
  if (seg.length) out.push(commandStart(seg));
  return out;
}

function looksLikeGitPush(seg) {
  return seg.includes('push') && seg.some((w) => /(^|[/({])git$/.test(w));
}

function refspecTarget(spec) {
  const s = spec.replace(/^\+/, '');
  if (s === ':' || s.includes('*')) return ALL_BRANCHES;
  if (UNRESOLVED_SHELL.test(s)) return UNKNOWN;
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  if (!dst || dst.startsWith('refs/tags/')) return null;
  return dst.replace(/^refs\/heads\//, '');
}

function parseGitPush(seg) {
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
  if (seg[i] !== 'push') return null;
  if (opaque || (dir && UNRESOLVED_SHELL.test(dir))) return { dir, targets: UNKNOWN };
  const positional = [];
  let all = false;
  let tagsOnly = false;
  for (let j = i + 1; j < seg.length; j++) {
    const t = seg[j];
    if (PUSH_OPTS_WITH_VALUE.has(t)) { j++; continue; }
    if (PUSH_ALL_FLAGS.has(t)) { all = true; continue; }
    if (t === '--tags') { tagsOnly = true; continue; }
    if (t.startsWith('-')) continue;
    positional.push(t);
  }
  const remote = positional[0] || null;
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

function applyContextChange(seg, ctx) {
  if (seg[0] === 'cd' || seg[0] === 'pushd') {
    const arg = seg[1];
    if (!arg || arg.startsWith('-') || UNRESOLVED_SHELL.test(arg)) ctx.unstable = true;
    else ctx.cwd = path.resolve(ctx.cwd, arg.replace(/^~(?=$|\/)/, os.homedir()));
    ctx.branch = null;
    return true;
  }
  if (seg[0] !== 'git' || (seg[1] !== 'checkout' && seg[1] !== 'switch')) return false;
  const args = seg.slice(2);
  if (args.includes('--')) return true;
  const createAt = args.findIndex((a) => BRANCH_CREATE_FLAGS.has(a));
  const name = createAt >= 0 ? args[createAt + 1] : args.find((a) => !a.startsWith('-'));
  if (!name || name === '-' || UNRESOLVED_SHELL.test(name)) ctx.unstable = true;
  else ctx.branch = name;
  return true;
}

function currentBranch(dir, override) {
  return override || git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

function defaultPushTargets(dir, remoteArg, override) {
  const branch = currentBranch(dir, override);
  if (branch === null) return UNKNOWN;
  const remote = remoteArg || git(['config', '--get', `branch.${branch}.remote`], dir) || 'origin';
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

function resolveTargets(push, ctx) {
  if (push.targets === ALL_BRANCHES || push.targets === UNKNOWN) return push.targets;
  const dir = push.dir ? path.resolve(ctx.cwd, push.dir) : ctx.cwd;
  const override = push.dir ? null : ctx.branch;
  const out = [];
  for (const t of push.targets) {
    if (t === '@default') {
      const d = defaultPushTargets(dir, push.remote, override);
      if (d === ALL_BRANCHES || d === UNKNOWN) return d;
      out.push(...d);
    } else if (t === 'HEAD') {
      const b = currentBranch(dir, override);
      if (b === null) return UNKNOWN;
      out.push(b);
    } else {
      out.push(t);
    }
  }
  return out;
}

function pushDecision(cmd, cwd, patterns) {
  const ctx = { cwd, branch: null, unstable: false };
  for (const seg of segments(cmd)) {
    if (applyContextChange(seg, ctx)) continue;
    const push = parseGitPush(seg) || parseGlabPush(seg);
    if (!push) {
      if (seg[0] !== 'git' && looksLikeGitPush(seg)) return { ask: true, branch: '(unparsed push command)' };
      continue;
    }
    if (ctx.unstable) return { ask: true, branch: '(unresolved branch change earlier in this command)' };
    const targets = resolveTargets(push, ctx);
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
  if (!input || input.tool_name !== 'Bash') process.exit(0);

  const cmd = input.tool_input && input.tool_input.command;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || '.';
  const decision = pushDecision(cmd, cwd, PROTECTED_PATTERNS);
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
