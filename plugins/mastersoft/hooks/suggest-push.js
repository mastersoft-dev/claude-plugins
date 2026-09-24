'use strict';

// Org rule: every `git push` requires explicit user confirmation. No branch
// filter, no "protected" guessing — pushing is consequential, so we ask.
// `glab mr create --fill` / `--push` pushes the branch itself, so it gets the
// same confirmation whenever the branch actually has commits to push.

const { execFileSync } = require('child_process');
const { readStdinJson } = require('./lib');

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function tokenize(cmd) {
  if (!cmd) return [];
  const raw = shellWords(cmd);
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const t = raw[i];
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) { i++; continue; }
    if (t === 'command' || t === 'exec' || t === 'env' || t === 'sudo') { i++; continue; }
    out.push(t);
    i++;
  }
  return out;
}

function isGitPush(cmd) {
  const toks = tokenize(cmd);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'git') continue;
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t === '-c' || t === '-C') { j++; continue; }
      if (t.startsWith('--git-dir') || t.startsWith('--work-tree') || t.startsWith('--namespace')) continue;
      if (t.startsWith('-')) continue;
      if (t === 'push') return true;
      break;
    }
  }
  return false;
}

const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const GLAB_PUSH_FLAGS = new Set(['--fill', '-f', '--push', '--push=true']);

function shellWords(cmd) {
  const words = [];
  let cur = null;
  let quote = null;
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
    if (two === '&&' || two === '||') { if (cur !== null) words.push(cur); cur = null; words.push(two); i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { if (cur !== null) words.push(cur); cur = null; words.push(c); continue; }
    if (/\s/.test(c)) { if (cur !== null) words.push(cur); cur = null; continue; }
    cur = (cur === null ? '' : cur) + c;
  }
  if (cur !== null) words.push(cur);
  return words;
}

function glabMrCreateArgLists(cmd) {
  const words = shellWords(cmd || '');
  const lists = [];
  for (let i = 0; i + 2 < words.length; i++) {
    if (words[i] !== 'glab' || words[i + 1] !== 'mr' || words[i + 2] !== 'create') continue;
    const args = [];
    for (let j = i + 3; j < words.length && !SHELL_SEPARATORS.has(words[j]); j++) args.push(words[j]);
    lists.push(args);
  }
  return lists;
}

function argsPush(args) {
  const optionArgs = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--description' || args[k] === '-d' || args[k] === '--title' || args[k] === '-t') { k++; continue; }
    optionArgs.push(args[k]);
  }
  if (optionArgs.includes('--push=false')) return false;
  return optionArgs.some((t) => GLAB_PUSH_FLAGS.has(t));
}

function isGlabPushingMrCreate(cmd) {
  return glabMrCreateArgLists(cmd).some(argsPush);
}

function isCompound(cmd) {
  return shellWords(cmd || '').some((w) => SHELL_SEPARATORS.has(w));
}

function hasCommitsToPush(repoRoot) {
  if (git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot) === null) return true;
  const ahead = git(['rev-list', '--count', '@{u}..HEAD'], repoRoot);
  return ahead === null || Number(ahead) > 0;
}

function main() {
  if (process.env.MASTERSOFT_SKIP_PUSH_CHECK === '1') process.exit(0);

  const input = readStdinJson();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = input.tool_input && input.tool_input.command;
  const gitPush = isGitPush(cmd);
  if (!gitPush && !isGlabPushingMrCreate(cmd)) process.exit(0);

  const cwd = input.cwd || '.';
  const repoRoot = process.env.CLAUDE_PROJECT_DIR
    || git(['rev-parse', '--show-toplevel'], cwd)
    || cwd;

  if (!gitPush && !isCompound(cmd) && !hasCommitsToPush(repoRoot)) process.exit(0);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '(unknown)';
  const action = gitPush ? '`git push`' : 'the push done by `glab mr create`';

  const lines = [`Confirm ${action} on branch \`${branch}\`?`];
  lines.push('Mastersoft org rule: pushes always require explicit confirmation. Override with env MASTERSOFT_SKIP_PUSH_CHECK=1 for unattended scripts.');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: lines.join(' '),
    },
    systemMessage: `[Mastersoft] Push confirmation required on \`${branch}\`.`,
    terminalSequence: String.fromCharCode(7),
  }) + '\n');
  process.exit(0);
}

main();
