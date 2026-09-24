#!/usr/bin/env node
/**
 * E2E tests for suggest-push.js — protected-branch push confirmation.
 *
 * Each test runs the hook as a subprocess against a real temp git repo with a
 * local bare remote, feeding it a PreToolUse Bash payload. "ask" means the hook
 * emitted permissionDecision=ask; "pass" means it stayed silent. No network.
 *
 * Usage: node plugins/mastersoft/tests/suggest-push.e2e.js
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const HOOK = path.resolve(__dirname, '../hooks/suggest-push.js');
const HOOK_TIMEOUT_MS = 5000;

// ─── helpers ──────────────────────────────────────────────────────────────────

const tmpDirs = [];

function sh(args, cwd) {
  cp.execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-push-'));
  tmpDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  sh(['init', '-q', '--bare', remote], root);
  sh(['init', '-q', '-b', 'main', work], root);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], work);
  sh(['remote', 'add', 'origin', remote], work);
  sh(['push', '-q', '-u', 'origin', 'main'], work);
  return work;
}

function checkout(work, branch, upstream) {
  sh(['switch', '-q', '-c', branch], work);
  if (upstream) {
    sh(['push', '-q', 'origin', `HEAD:${upstream}`], work);
    sh(['branch', '-q', `--set-upstream-to=origin/${upstream}`], work);
  }
}

function runHook(cwd, command, env = {}) {
  const base = { ...process.env };
  delete base.MASTERSOFT_SKIP_PUSH_CHECK;
  delete base.MASTERSOFT_PUSH_PROTECTED_BRANCHES;
  delete base.CLAUDE_PROJECT_DIR;
  const result = cp.spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  const out = (result.stdout || '').trim();
  if (!out) return 'pass';
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
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

// ─── tests ────────────────────────────────────────────────────────────────────

console.log('\nsuggest-push — protected-branch confirmation\n');

const onMain = mkRepo();
const onFeature = mkRepo();
checkout(onFeature, 'feat/x');
const trackingMain = mkRepo();
checkout(trackingMain, 'local-work', 'main');

test('plain push on a protected branch asks', () => {
  assertEq(runHook(onMain, 'git push'), 'ask');
});

test('plain push on a feature branch passes', () => {
  assertEq(runHook(onFeature, 'git push -u origin HEAD'), 'pass');
});

test('explicit refspec to a protected branch asks from a feature branch', () => {
  assertEq(runHook(onFeature, 'git push origin HEAD:main'), 'ask');
});

test('push with no refspec follows the upstream branch name', () => {
  assertEq(runHook(trackingMain, 'git push'), 'ask');
});

test('chained commit and push on a protected branch asks', () => {
  assertEq(runHook(onMain, 'git add . && git commit -m "x" && git push'), 'ask');
});

test('chained commit and push on a feature branch passes', () => {
  assertEq(runHook(onFeature, 'git add . && git commit -m "x" && git push'), 'pass');
});

test('"git push" inside a quoted commit message is not a push', () => {
  assertEq(runHook(onMain, 'git commit -m "then git push it"'), 'pass');
});

test('git -C resolves the branch in the target directory', () => {
  assertEq(runHook(onFeature, `git -C "${onMain}" push`), 'ask');
});

test('switching to a protected branch earlier in the command asks', () => {
  assertEq(runHook(onFeature, 'git switch main && git push'), 'ask');
});

test('creating a feature branch then pushing passes', () => {
  assertEq(runHook(onMain, 'git checkout -b feat/new && git push -u origin HEAD'), 'pass');
});

test('an unresolvable branch switch asks', () => {
  assertEq(runHook(onFeature, 'git switch - && git push'), 'ask');
});

test('cd into another repo resolves the branch there', () => {
  assertEq(runHook(onMain, `cd "${onFeature}" && git push`), 'pass');
  assertEq(runHook(onFeature, `cd "${onMain}" && git push`), 'ask');
});

test('remote push refspec in git config is honored', () => {
  const repo = mkRepo();
  checkout(repo, 'feat/cfg');
  sh(['config', 'remote.origin.push', 'HEAD:main'], repo);
  assertEq(runHook(repo, 'git push'), 'ask');
});

test('push.default=matching counts as a multi-branch push', () => {
  const repo = mkRepo();
  checkout(repo, 'feat/match');
  sh(['config', 'push.default', 'matching'], repo);
  assertEq(runHook(repo, 'git push'), 'ask');
});

test('matching ":" and wildcard refspecs ask', () => {
  assertEq(runHook(onFeature, 'git push origin :'), 'ask');
  assertEq(runHook(onFeature, "git push origin 'refs/heads/*:refs/heads/*'"), 'ask');
});

test('redirections are not taken as push arguments', () => {
  assertEq(runHook(onMain, 'git push > /tmp/push.log'), 'ask');
  assertEq(runHook(onFeature, 'git push 2>&1 | tail -3'), 'pass');
});

test('pushes inside control flow or behind wrapper options are detected', () => {
  assertEq(runHook(onFeature, 'if true; then git push origin HEAD:main; fi'), 'ask');
  assertEq(runHook(onFeature, 'sudo -n git push origin HEAD:main'), 'ask');
});

test('repository-selection options ask', () => {
  assertEq(runHook(onFeature, `git --git-dir="${onMain}/.git" push`), 'ask');
});

test('destinations from shell variables ask', () => {
  assertEq(runHook(onFeature, 'branch=main; git push origin HEAD:"$branch"'), 'ask');
});

test('the word push in a non-push git command passes', () => {
  assertEq(runHook(onMain, 'git commit -m push'), 'pass');
});

test('--all asks', () => {
  assertEq(runHook(onFeature, 'git push --all origin'), 'ask');
});

test('tags-only push passes', () => {
  assertEq(runHook(onMain, 'git push --tags'), 'pass');
});

test('release/* prefix pattern is protected', () => {
  assertEq(runHook(onFeature, 'git push origin HEAD:release/1.2'), 'ask');
});

test('glab --fill from a feature branch passes', () => {
  assertEq(runHook(onFeature, 'glab mr create --fill --target-branch main --yes'), 'pass');
});

test('glab --fill from a protected branch asks', () => {
  assertEq(runHook(onMain, 'glab mr create --fill --yes'), 'ask');
});

test('glab quoted description text does not change the push decision', () => {
  assertEq(runHook(onMain, 'glab mr create --fill --description "use --push=false" --yes'), 'ask');
});

test('glab --push=false passes', () => {
  assertEq(runHook(onMain, 'glab mr create --fill --push=false --yes'), 'pass');
});

test('env override replaces the protected set', () => {
  assertEq(runHook(onFeature, 'git push', { MASTERSOFT_PUSH_PROTECTED_BRANCHES: 'feat/*' }), 'ask');
  assertEq(runHook(onMain, 'git push', { MASTERSOFT_PUSH_PROTECTED_BRANCHES: 'feat/*' }), 'pass');
});

test('"*" restores confirmation on every branch', () => {
  assertEq(runHook(onFeature, 'git push', { MASTERSOFT_PUSH_PROTECTED_BRANCHES: '*' }), 'ask');
});

test('MASTERSOFT_SKIP_PUSH_CHECK=1 disables the check', () => {
  assertEq(runHook(onMain, 'git push', { MASTERSOFT_SKIP_PUSH_CHECK: '1' }), 'pass');
});

// ─── summary ──────────────────────────────────────────────────────────────────

tmpDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
