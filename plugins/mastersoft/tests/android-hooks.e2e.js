#!/usr/bin/env node
/**
 * E2E tests for the android-testing skill hooks (no-raw-input.sh,
 * no-raw-screencap.sh).
 *
 * Each test runs a hook as a subprocess, feeding it a PreToolUse Bash payload.
 * "deny" means the hook emitted permissionDecision=deny; "pass" means it stayed
 * silent. The hooks stay registered for the rest of the session once the skill
 * loads, so commands without adb must pass untouched.
 *
 * Usage: node plugins/mastersoft/tests/android-hooks.e2e.js
 */
'use strict';

const path = require('path');
const cp   = require('child_process');

const HOOKS_DIR = path.resolve(__dirname, '../skills/android-testing/hooks');
const INPUT_HOOK = path.join(HOOKS_DIR, 'no-raw-input.sh');
const SCREENCAP_HOOK = path.join(HOOKS_DIR, 'no-raw-screencap.sh');
const HOOK_TIMEOUT_MS = 5000;

function runHook(hook, command, env = {}) {
  const base = { ...process.env };
  delete base.ANDROID_SKILL_ALLOW_RAW_SCREENCAP;
  const result = cp.spawnSync(hook, [], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command } }),
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  const out = (result.stdout || '').trim();
  if (!out) return { decision: 'pass', reason: '' };
  const parsed = JSON.parse(out).hookSpecificOutput;
  return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason };
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

console.log('\nandroid-testing hooks — raw input and screencap guards\n');

test('raw input tap is denied and points at the --ops batch', () => {
  const r = runHook(INPUT_HOOK, 'adb -s emulator-5554 shell input tap 100 200');
  assertEq(r.decision, 'deny');
  assertEq(r.reason.includes("--ops '<json>'"), true, 'reason names --ops');
  assertEq(r.reason.includes('--stdin'), false, 'reason drops --stdin');
});

test('raw input keyevent passes', () => {
  assertEq(runHook(INPUT_HOOK, 'adb shell input keyevent KEYCODE_BACK').decision, 'pass');
});

test('a command without adb passes both hooks', () => {
  assertEq(runHook(INPUT_HOOK, 'git status --short').decision, 'pass');
  assertEq(runHook(SCREENCAP_HOOK, 'ls /tmp/*.png').decision, 'pass');
});

test('raw screencap is denied', () => {
  assertEq(runHook(SCREENCAP_HOOK, 'adb -s emulator-5554 exec-out screencap -p > /tmp/x.png').decision, 'deny');
});

test('pulling a frame is denied', () => {
  assertEq(runHook(SCREENCAP_HOOK, 'adb pull /sdcard/cur.png /tmp/cur.png').decision, 'deny');
});

test('the screencap denial asks the user for a settings env override', () => {
  const { reason } = runHook(SCREENCAP_HOOK, 'adb shell screencap -p /sdcard/x.png');
  assertEq(reason.includes('.claude/settings.local.json'), true, 'reason names settings.local.json');
  assertEq(reason.includes('after the user agrees'), true, 'reason defers to the user');
  assertEq(/\bexport\b/.test(reason), false, 'reason drops export');
});

test('ANDROID_SKILL_ALLOW_RAW_SCREENCAP=1 in the hook environment allows screencap', () => {
  const r = runHook(SCREENCAP_HOOK, 'adb exec-out screencap -p > /tmp/x.png', { ANDROID_SKILL_ALLOW_RAW_SCREENCAP: '1' });
  assertEq(r.decision, 'pass');
});

test('ANDROID_SKILL_ALLOW_RAW_SCREENCAP=0 keeps the denial', () => {
  const r = runHook(SCREENCAP_HOOK, 'adb exec-out screencap -p > /tmp/x.png', { ANDROID_SKILL_ALLOW_RAW_SCREENCAP: '0' });
  assertEq(r.decision, 'deny');
});

// ─── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
