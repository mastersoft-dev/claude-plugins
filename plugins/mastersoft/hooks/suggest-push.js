'use strict';

// Org rule: every `git push` requires explicit user confirmation. No branch
// filter, no "protected" guessing — pushing is consequential, so we ask.

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
  const raw = cmd.split(/\s+/).filter(Boolean);
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
      return t === 'push';
    }
  }
  return false;
}

function main() {
  if (process.env.MASTERSOFT_SKIP_PUSH_CHECK === '1') process.exit(0);

  const input = readStdinJson();
  if (!input) process.exit(0);
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = input.tool_input && input.tool_input.command;
  if (!isGitPush(cmd)) process.exit(0);

  const cwd = input.cwd || '.';
  const repoRoot = process.env.CLAUDE_PROJECT_DIR
    || git(['rev-parse', '--show-toplevel'], cwd)
    || cwd;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || '(unknown)';

  const lines = [`Confirm \`git push\` on branch \`${branch}\`?`];
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
