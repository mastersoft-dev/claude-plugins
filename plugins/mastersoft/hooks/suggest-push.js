'use strict';

// Org rule: pushes to protected branches require explicit user confirmation;
// feature-branch pushes go straight through so unattended runs never stall.
// Covers `git push` (any refspec form, chained commands, `git -C <dir>`) and
// the push `glab mr create --fill` / `--push` performs on its source branch.
// Protected set: `push_protected_branches` in ORG_RULES.md (env
// MASTERSOFT_PUSH_PROTECTED_BRANCHES), comma-separated; `name/*` matches a
// prefix, `*` matches every branch.

const path = require('path');
const { execFileSync } = require('child_process');
const { readStdinJson } = require('./lib');
const { cfg } = require('./lib-org-rules');

const DEFAULT_PROTECTED_BRANCHES = 'main,master,develop,dev,staging,production,release/*';
const PROTECTED_PATTERNS = parsePatterns(
  cfg('MASTERSOFT_PUSH_PROTECTED_BRANCHES', 'push_protected_branches', DEFAULT_PROTECTED_BRANCHES, String),
);

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const COMMAND_PREFIXES = new Set(['command', 'exec', 'env', 'sudo']);
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c']);
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_ALL_FLAGS = new Set(['--all', '--mirror', '--branches']);
const GLAB_PUSH_FLAGS = new Set(['--fill', '-f', '--push', '--push=true']);
const GLAB_OPTS_WITH_VALUE = new Set([
  '--title', '-t', '--description', '-d', '--target-branch', '-b', '--source-branch', '-s',
  '--label', '-l', '--assignee', '-a', '--reviewer', '--milestone', '-m', '--template', '--repo', '-R',
]);
const ALL_BRANCHES = Symbol('all-branches');

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
  const flush = () => { if (cur !== null) words.push(cur); cur = null; };
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
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { flush(); words.push(two); i++; continue; }
    if (SEPARATORS.has(c)) { flush(); words.push(c); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur = (cur === null ? '' : cur) + c;
  }
  flush();
  return words;
}

function segments(cmd) {
  const out = [];
  let seg = [];
  for (const w of shellWords(cmd || '')) {
    if (SEPARATORS.has(w)) { if (seg.length) out.push(seg); seg = []; continue; }
    if (seg.length === 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || COMMAND_PREFIXES.has(w))) continue;
    seg.push(w);
  }
  if (seg.length) out.push(seg);
  return out;
}

function refspecTarget(spec) {
  const s = spec.replace(/^\+/, '');
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  if (!dst || dst.startsWith('refs/tags/')) return null;
  return dst.replace(/^refs\/heads\//, '');
}

function parseGitPush(seg) {
  if (seg[0] !== 'git') return null;
  let dir = null;
  let i = 1;
  for (; i < seg.length; i++) {
    const t = seg[i];
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(t)) { if (t === '-C') dir = seg[i + 1]; i++; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  if (seg[i] !== 'push') return null;
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
  const refspecs = positional.slice(1);
  if (all) return { dir, targets: ALL_BRANCHES };
  if (refspecs.length === 0) return { dir, targets: tagsOnly ? [] : ['@default'] };
  return { dir, targets: refspecs.map(refspecTarget).filter(Boolean) };
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
  return { dir: null, targets: [source || 'HEAD'] };
}

function changesBranchOrDir(seg) {
  if (seg[0] === 'cd' || seg[0] === 'pushd') return true;
  return seg[0] === 'git' && seg.some((t) => t === 'checkout' || t === 'switch');
}

function resolveBranch(name, dir) {
  if (name === 'HEAD') return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (name !== '@default') return name;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir);
  if (upstream && upstream.includes('/')) return upstream.slice(upstream.indexOf('/') + 1);
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

function pushDecision(cmd, cwd, patterns) {
  let unstable = false;
  for (const seg of segments(cmd)) {
    if (changesBranchOrDir(seg)) { unstable = true; continue; }
    const push = parseGitPush(seg) || parseGlabPush(seg);
    if (!push) continue;
    if (unstable) return { ask: true, branch: '(changed earlier in this command)' };
    if (push.targets === ALL_BRANCHES) return { ask: true, branch: '(all branches)' };
    const dir = push.dir ? path.resolve(cwd, push.dir) : cwd;
    for (const t of push.targets) {
      const branch = resolveBranch(t, dir);
      if (branch === null) return { ask: true, branch: '(unknown)' };
      if (isProtected(branch, patterns)) return { ask: true, branch };
    }
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
