#!/usr/bin/env node
/**
 * E2E tests for lint-engine.js against real repos.
 *
 * Each test runs the hook with an isolated CLAUDE_PLUGIN_DATA (temp dir) so
 * real repo state is never touched. Tests are read-only on the repos themselves.
 *
 * Usage: node plugins/mastersoft/tests/lint-engine.e2e.js [--verbose]
 * Requires repos to exist under REPOS_BASE (default: sibling of claude-plugins).
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const HOOK = path.resolve(__dirname, '../hooks/lint-engine.js');
const REPOS_BASE = path.resolve(__dirname, '../../../../');
const VERBOSE = process.argv.includes('--verbose');

// ─── helpers ──────────────────────────────────────────────────────────────────

function repo(name) { return path.join(REPOS_BASE, name); }

function runHook(cwd, { sessionId = 'test-' + Math.random().toString(36).slice(2), stateDir, env = {} } = {}) {
  const input = JSON.stringify({ session_id: sessionId, cwd });
  const result = cp.spawnSync(process.execPath, [HOOK], {
    input,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) throw result.error;
  const raw = (result.stdout || '').trim();
  let parsed = {};
  try { if (raw) parsed = JSON.parse(raw); } catch {}
  const ctx = parsed.hookSpecificOutput?.additionalContext || '';
  const signals = [...ctx.matchAll(/id=([a-z-]+) severity=([a-z]+)/g)]
    .map(m => ({ id: m[1], severity: m[2] }));
  const stderr = result.stderr || '';
  if (VERBOSE) {
    console.log(`  [hook] exit=${result.status} signals=[${signals.map(s => s.id).join(',')}]`);
    if (stderr) console.log(`  [stderr] ${stderr.slice(0, 200)}`);
  }
  return { signals, ctx, systemMessage: parsed.systemMessage || '', stderr };
}

/** Run two prompts on the same session (prompt #1 + #2) from a temp state dir. */
function session(cwd, opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  const sessionId = 'e2e-' + Math.random().toString(36).slice(2);
  try {
    const p1 = runHook(cwd, { sessionId, stateDir, env: opts.env });
    const p2 = runHook(cwd, { sessionId, stateDir, env: opts.env });
    return { p1, p2, stateDir };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Session with category ack pre-written into the repo's .claude dir (in-memory
 *  simulation: we write a temp ack file by pointing at a temp overlay, not the
 *  real .claude dir — achieved by running a throwaway git repo that shadows the
 *  ack check via MASTERSOFT_LINTS_ACK_HOURS=0 to expire any live ack, then
 *  constructing one in a copied .claude dir).
 *
 *  Simpler approach: write the ack into a temp copy of the .claude dir that
 *  lint-engine would find at repoRoot. BUT lint-engine resolves repoRoot from
 *  cwd via git, so we can't easily redirect .claude. Instead we simulate "ack
 *  just expired" with MASTERSOFT_LINTS_ACK_HOURS=0, which makes lint-engine
 *  treat any existing ack as expired regardless of its age.
 */
function sessionNoAck(cwd, opts = {}) {
  return session(cwd, { ...opts, env: { ...(opts.env || {}), MASTERSOFT_LINTS_ACK_HOURS: '0' } });
}

// ─── test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // Skip if required repo is missing
  try { fn(); passed++; console.log(`  ✓  ${name}`); }
  catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  ✗  ${name}\n     ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertHasSignal(signals, id, msg) {
  assert(signals.some(s => s.id === id), msg || `expected signal '${id}' but got [${signals.map(s => s.id).join(', ')}]`);
}
function assertNoSignal(signals, id, msg) {
  assert(!signals.some(s => s.id === id), msg || `unexpected signal '${id}' in [${signals.map(s => s.id).join(', ')}]`);
}
function requireRepo(name) {
  if (!fs.existsSync(repo(name))) throw Object.assign(new Error(`SKIP: repo '${name}' not found at ${repo(name)}`), { skip: true });
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log('\nlint-engine e2e — real repos\n');

// ── 1. First-prompt fix ───────────────────────────────────────────────────────
// Regression: db07fc1 broke brief-deprecated on prompt #1 by placing it inside
// emitSignals (promptIndex > 1). Fixed in 7c818e9.
console.log('1. First-prompt fix (brief-deprecated fires on prompt #1)');

test('legion: brief-deprecated appears on prompt #1 (no ack)', () => {
  requireRepo('legion');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('legion'), { sessionId: 'e2e-fp-1', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assertHasSignal(p1.signals, 'brief-deprecated',
      'brief-deprecated must fire on prompt #1 regardless of promptIndex');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('mastersoft-agent: brief-deprecated appears on prompt #1 (no ack)', () => {
  requireRepo('mastersoft-agent');
  if (!fs.existsSync(path.join(repo('mastersoft-agent'), 'BRIEF.md'))) {
    throw new Error('SKIP: mastersoft-agent has no BRIEF.md');
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('mastersoft-agent'), { sessionId: 'e2e-fp-2', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assertHasSignal(p1.signals, 'brief-deprecated');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 2. Category masking: migration category decoupled from rules-defer ────────
// brief-deprecated (category: migration) must survive a `defer rules` ack.
console.log('\n2. Category decoupling (brief survives defer-rules)');

test('legion: brief-deprecated fires when rules-ack is active', () => {
  requireRepo('legion');
  // Write a rules-ack into a temp state — but lint-engine reads the ack from
  // repoRoot/.claude/.mastersoft-lints-ack directly (not from CLAUDE_PLUGIN_DATA).
  // We simulate an active rules-ack by directly writing the file, running the
  // test, then restoring. We use a fresh temp copy of the .claude dir: since we
  // can't redirect repoRoot, we instead test via MASTERSOFT_LINTS_ACK_HOURS=0
  // (expires any real ack) and separately verify category isolation by running
  // against officegenius which also has a rules-ack on disk.
  //
  // Primary: use officegenius (real rules ack on disk, BRIEF.md present)
  requireRepo('officegenius');
  const ackPath = path.join(repo('officegenius'), '.claude', '.mastersoft-lints-ack');
  if (!fs.existsSync(ackPath)) throw new Error('SKIP: officegenius has no live ack');
  const ackContent = fs.readFileSync(ackPath, 'utf8').trim();
  assert(ackContent === 'rules' || ackContent === '', `expected rules ack, got '${ackContent}'`);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    // Prompt #1: fresh session, real ack active
    const p1 = runHook(repo('officegenius'), { sessionId: 'e2e-cat-1', stateDir });
    assertHasSignal(p1.signals, 'brief-deprecated',
      'brief-deprecated (migration category) must not be silenced by a rules-category ack');
    // Rules-category signal should be absent (ack muting it)
    assertNoSignal(p1.signals, 'refresh-overdue',
      'refresh-overdue (rules category) should be silenced by active rules ack');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('legion: brief-deprecated (p1) and security-audit-due (p2) both fire independently', () => {
  requireRepo('legion');
  // brief-deprecated is a bootstrap signal (fires p1); security-audit-due is
  // emitSignals-gated (fires p2+). Verify both appear in their respective prompts
  // and are not masked by each other's category or by the rules ack.
  const { p1, p2 } = sessionNoAck(repo('legion'));
  assertHasSignal(p1.signals, 'brief-deprecated',
    'brief-deprecated (migration category) must fire on prompt #1');
  assertNoSignal(p1.signals, 'security-audit-due',
    'security-audit-due is emitSignals-gated, must NOT appear on prompt #1');
  assertHasSignal(p2.signals, 'security-audit-due',
    'audit-category signal must fire on prompt #2 independently of migration/rules ack');
  assertHasSignal(p2.signals, 'brief-deprecated',
    'brief-deprecated must still fire on prompt #2 (persists until BRIEF.md removed)');
});

// ── 3. Severity-ordered budget ─────────────────────────────────────────────────
// high-severity signals must survive the budget cap even when emitted last.
console.log('\n3. Severity-ordered budget (high-severity survives cap)');

test('presente: security-audit-due (high) survives alongside rule-file-oversize', () => {
  requireRepo('presente');
  const { p2 } = sessionNoAck(repo('presente'));
  // presente emits: security-audit-due (high) + rule-file-oversize (warn) + refresh-overdue + verify-due
  assertHasSignal(p2.signals, 'security-audit-due',
    'high-severity signal must survive the budget cap');
  // Verify it appears first (severity ordering)
  const highIdx = p2.signals.findIndex(s => s.id === 'security-audit-due');
  const firstSeverities = p2.signals.slice(0, highIdx).map(s => s.severity);
  assert(firstSeverities.every(sv => sv === 'high'),
    `security-audit-due should be first or only preceded by other high signals, got order: ${p2.signals.map(s => `${s.severity}:${s.id}`).join(', ')}`);
});

test('motu: security-audit-due (high) appears before no-rules-file (info)', () => {
  requireRepo('motu');
  const { p2 } = sessionNoAck(repo('motu'));
  const highIdx = p2.signals.findIndex(s => s.id === 'security-audit-due');
  const infoIdx = p2.signals.findIndex(s => s.severity === 'info');
  if (highIdx === -1) throw new Error('SKIP: security-audit-due did not fire for motu');
  if (infoIdx === -1) return; // only high signals, trivially ordered
  assert(highIdx < infoIdx,
    `high-severity should precede info; got order: ${p2.signals.map(s => `${s.severity}:${s.id}`).join(', ')}`);
});

test('legion: no high signal dropped when budget is tight', () => {
  requireRepo('legion');
  const { p2 } = sessionNoAck(repo('legion'));
  // legion emits brief-deprecated (migration/info) + security-audit-due (high) + verify-due (info)
  // With severity ordering, high must appear even if info candidates exceed budget
  assertHasSignal(p2.signals, 'security-audit-due');
});

// ── 4. Bootstrap signals fire on prompt #1 ────────────────────────────────────
// Both no-rules-file and brief-deprecated are bootstrap signals (exempt from
// the promptIndex > 1 gate). Verify neither requires a warm session.
console.log('\n4. Bootstrap signals fire on prompt #1');

test('motu: no-rules-file fires on prompt #1 (no ack)', () => {
  requireRepo('motu');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('motu'), { sessionId: 'e2e-boot-1', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assertHasSignal(p1.signals, 'no-rules-file',
      'no-rules-file must fire on prompt #1 (bootstrap signal)');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('presente: emitSignals-gated signals absent on prompt #1', () => {
  requireRepo('presente');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('presente'), { sessionId: 'e2e-boot-2', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    // No bootstrap signals for presente (has CLAUDE.md, no BRIEF.md), so p1 should be empty
    assert(p1.signals.length === 0,
      `presente has no bootstrap signals — p1 should emit nothing, got [${p1.signals.map(s=>s.id).join(',')}]`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 5. systemMessage routing ──────────────────────────────────────────────────
// When signals fire, systemMessage routes to the right skill.
console.log('\n5. systemMessage routing');

test('motu (no CLAUDE.md): systemMessage routes to init-rules', () => {
  requireRepo('motu');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('motu'), { sessionId: 'e2e-sm-1', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assert(p1.systemMessage.includes('init-rules'),
      `expected init-rules in systemMessage, got: "${p1.systemMessage}"`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('legion (has CLAUDE.md): systemMessage routes to ack-lints/refresh-rules', () => {
  requireRepo('legion');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('legion'), { sessionId: 'e2e-sm-2', stateDir,
      env: { MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assert(p1.systemMessage.includes('ack-lints'),
      `expected ack-lints in systemMessage, got: "${p1.systemMessage}"`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 6. MASTERSOFT_QUIET ───────────────────────────────────────────────────────
test('MASTERSOFT_QUIET=1 suppresses everything', () => {
  requireRepo('legion');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const p1 = runHook(repo('legion'), { sessionId: 'e2e-quiet-1', stateDir,
      env: { MASTERSOFT_QUIET: '1', MASTERSOFT_LINTS_ACK_HOURS: '0' } });
    assert(p1.signals.length === 0 && !p1.systemMessage,
      `QUIET=1 should suppress all output, got ${p1.signals.length} signals`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ─── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
