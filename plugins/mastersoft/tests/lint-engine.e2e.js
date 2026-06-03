#!/usr/bin/env node
/**
 * E2E tests for lint-engine.js against real repos.
 *
 * Each test runs the hook with an isolated MASTERSOFT_STATE_DIR (temp dir) so
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
const STATE_JS = path.resolve(__dirname, '../scripts/state.js');
const REPOS_BASE = path.resolve(__dirname, '../../../../');
const VERBOSE = process.argv.includes('--verbose');

// ─── helpers ──────────────────────────────────────────────────────────────────

function repo(name) { return path.join(REPOS_BASE, name); }

function runHook(cwd, { sessionId = 'test-' + Math.random().toString(36).slice(2), stateDir, env = {} } = {}) {
  const input = JSON.stringify({ session_id: sessionId, cwd });
  const result = cp.spawnSync(process.execPath, [HOOK], {
    input,
    env: { ...process.env, MASTERSOFT_STATE_DIR: stateDir, ...env },
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

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓  ${name}`); }
  catch (e) {
    // requireRepo / explicit SKIP throws carry { skip: true } — a missing
    // fixture repo is not a failure, just an environment without that repo.
    if (e.skip) { skipped++; console.log(`  ⊘  ${name}\n     ${e.message}`); return; }
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

const DAY_MS = 86400000;

/** Build a throwaway git repo under a temp HOME and run a 2-prompt session
 *  against it — fully self-contained, no dependency on sibling repos.
 *    repoFiles   files to write + commit into the repo (default: a CLAUDE.md).
 *    ack         contents for `.claude/.mastersoft-lints-ack`, kept ACTIVE; when
 *                null, any ack is neutralized via MASTERSOFT_LINTS_ACK_HOURS=0.
 *    memFiles    files to seed into the per-repo auto-memory dir under HOME.
 *    dirAgeDays / lastPromotionAgeDays   optional auto-memory staleness seeds.
 *  The temp HOME also isolates auto-memory, so the real machine's memory never
 *  leaks promotion signals into a test. Returns { p1, p2 } and self-cleans. */
function tmpSession({ repoFiles = { 'CLAUDE.md': '# rules\n' }, ack = null, memFiles = null, dirAgeDays = null, lastPromotionAgeDays = null, thirdPrompt = false, env = {} } = {}) {
  const home     = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-home-'));
  const repoRaw  = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-repo-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-e2e-'));
  try {
    const realRepo = fs.realpathSync(repoRaw);
    const g = args => cp.execFileSync('git', args, { cwd: realRepo, stdio: 'ignore' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t.test']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    for (const [name, content] of Object.entries(repoFiles)) {
      const fp = path.join(realRepo, name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);
    if (ack !== null) {
      fs.mkdirSync(path.join(realRepo, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(realRepo, '.claude', '.mastersoft-lints-ack'), ack);
    }

    if (memFiles) {
      const slug = realRepo.replace(/[/._\\]/g, '-');
      const memDir = path.join(home, '.claude', 'projects', slug, 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      for (const [name, content] of Object.entries(memFiles)) fs.writeFileSync(path.join(memDir, name), content);
      if (dirAgeDays !== null) { const t = (Date.now() - dirAgeDays * DAY_MS) / 1000; fs.utimesSync(memDir, t, t); }
    }
    if (lastPromotionAgeDays !== null) {
      const ts = Date.now() - lastPromotionAgeDays * DAY_MS;
      fs.writeFileSync(path.join(stateDir, 'lint-engine-state.json'),
        JSON.stringify({ __repos: { [realRepo]: { last_promotion_check_at: ts } } }));
    }

    const sessionId = 'e2e-tmp-' + Math.random().toString(36).slice(2);
    const runEnv = { HOME: home, ...env };
    if (ack === null) runEnv.MASTERSOFT_LINTS_ACK_HOURS = '0';
    const p1 = runHook(realRepo, { sessionId, stateDir, env: runEnv });
    const p2 = runHook(realRepo, { sessionId, stateDir, env: runEnv });
    const p3 = thirdPrompt ? runHook(realRepo, { sessionId, stateDir, env: runEnv }) : null;
    return { p1, p2, p3 };
  } finally {
    fs.rmSync(home,     { recursive: true, force: true });
    fs.rmSync(repoRaw,  { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log('\nlint-engine e2e — real repos\n');

// ── 1. First-prompt fix ───────────────────────────────────────────────────────
// Regression: db07fc1 broke brief-deprecated on prompt #1 by placing it inside
// emitSignals (promptIndex > 1). Fixed in 7c818e9.
console.log('1. First-prompt fix (brief-deprecated fires on prompt #1)');

test('brief-deprecated fires on prompt #1 when BRIEF.md is present', () => {
  const { p1 } = tmpSession({ repoFiles: { 'CLAUDE.md': '# rules\n', 'BRIEF.md': '# brief\n' } });
  assertHasSignal(p1.signals, 'brief-deprecated',
    'brief-deprecated must fire on prompt #1 regardless of promptIndex (bootstrap signal)');
});

// ── 2. Category masking: migration category decoupled from rules-defer ────────
// brief-deprecated (category: migration) must survive a `defer rules` ack.
console.log('\n2. Category decoupling (brief survives defer-rules)');

test('brief-deprecated (migration) survives a rules-ack that silences refresh-overdue', () => {
  // An active `rules` ack must mute rules-category signals (refresh-overdue) but
  // NOT the migration-category brief-deprecated.
  const { p2 } = tmpSession({
    repoFiles: { 'CLAUDE.md': '# rules\n', 'BRIEF.md': '# brief\n' },
    ack: 'rules',
  });
  assertHasSignal(p2.signals, 'brief-deprecated',
    'brief-deprecated (migration category) must not be silenced by a rules-category ack');
  assertNoSignal(p2.signals, 'refresh-overdue',
    'refresh-overdue (rules category) should be silenced by the active rules ack');
});

test('brief-deprecated (p1) and security-audit-due (p2) fire independently', () => {
  // brief-deprecated is a bootstrap signal (fires p1); security-audit-due is
  // emitSignals-gated (fires p2+). The npm lockfile + no prior audit triggers it.
  const { p1, p2 } = tmpSession({
    repoFiles: { 'CLAUDE.md': '# rules\n', 'BRIEF.md': '# brief\n', 'package-lock.json': '{}\n' },
  });
  assertHasSignal(p1.signals, 'brief-deprecated',
    'brief-deprecated (migration category) must fire on prompt #1');
  assertNoSignal(p1.signals, 'security-audit-due',
    'security-audit-due is emitSignals-gated, must NOT appear on prompt #1');
  assertHasSignal(p2.signals, 'security-audit-due',
    'audit-category signal must fire on prompt #2 independently of migration');
  assertHasSignal(p2.signals, 'brief-deprecated',
    'brief-deprecated must still fire on prompt #2 (persists while BRIEF.md exists)');
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
  if (highIdx === -1) throw Object.assign(new Error('SKIP: security-audit-due did not fire for motu'), { skip: true });
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

test('systemMessage routes to ack-lints/refresh-rules when CLAUDE.md present and a signal fires', () => {
  // CLAUDE.md present, no ack → refresh-overdue fires on p2 (emitSignals-gated),
  // so the notice routes to refresh-rules/ack-lints rather than init-rules.
  const { p2 } = tmpSession({ repoFiles: { 'CLAUDE.md': '# rules\n' } });
  assert(p2.systemMessage.includes('ack-lints'),
    `expected ack-lints in systemMessage, got: "${p2.systemMessage}"`);
});

test('systemMessage enumerates active signals with their per-signal fix command', () => {
  // requirements.txt → security-audit-due (high) + refresh-overdue/verify-due.
  const { p2 } = tmpSession({ repoFiles: { 'CLAUDE.md': '# rules\n', 'requirements.txt': 'flask==1.0\n' } });
  assert(p2.systemMessage.includes('security-audit-due'),
    `expected signal id enumerated in systemMessage, got: "${p2.systemMessage}"`);
  assert(p2.systemMessage.includes('/mastersoft:audit-deps'),
    `expected per-signal fix command in systemMessage, got: "${p2.systemMessage}"`);
});

test('high signal re-surfaces systemMessage on a later prompt; info-only does not', () => {
  // High present (security-audit-due via lockfile) → re-surfaces on p3.
  const hi = tmpSession({ repoFiles: { 'CLAUDE.md': '# rules\n', 'requirements.txt': 'flask==1.0\n' }, thirdPrompt: true });
  assert(hi.p2.systemMessage, 'expected systemMessage on first emit (p2)');
  assert(hi.p3.systemMessage, 'expected high signal to re-surface systemMessage on p3');

  // Info/warn only (no lockfile) → once-per-session: shown on p2, silent on p3.
  const lo = tmpSession({ repoFiles: { 'CLAUDE.md': '# rules\n' }, thirdPrompt: true });
  assert(lo.p2.systemMessage, 'expected systemMessage on first emit (p2)');
  assert(!lo.p3.systemMessage, 'expected once-per-session suppression on p3 for non-high signals');
});

// ── 6. MASTERSOFT_QUIET ───────────────────────────────────────────────────────
test('MASTERSOFT_QUIET=1 suppresses everything', () => {
  const { p2 } = tmpSession({
    repoFiles: { 'CLAUDE.md': '# rules\n', 'BRIEF.md': '# brief\n' }, // would otherwise emit signals
    env: { MASTERSOFT_QUIET: '1' },
  });
  assert(p2.signals.length === 0 && !p2.systemMessage,
    `QUIET=1 should suppress all output, got ${p2.signals.length} signals`);
});

// ── 7. Auto-memory matcher + promotion signals (self-contained) ───────────────
// These build a throwaway git repo + a temp HOME with a seeded auto-memory dir,
// so they don't depend on any sibling repo or on real per-machine memory.
console.log('\n7. Auto-memory matcher + memory-review-due (self-contained)');

const FM = (type, { metadata = false, extra = '' } = {}) =>
  metadata ? `---\nname: x\nmetadata:\n${extra}  type: ${type}\n---\nbody\n`
           : `---\nname: x\ntype: ${type}\n---\nbody\n`;

test('matcher counts user_/slug/nested entries and excludes reference (both cues)', () => {
  // 6 candidates + 2 references + index. Old prefix-only matcher saw 2.
  const { p2 } = tmpSession({ memFiles: {
    'feedback_a.md': FM('feedback'),
    'project_b.md':  FM('project'),
    'user_c.md':     FM('user'),                                 // missed by old matcher
    'slug-d.md':     FM('project', { metadata: true }),          // missed by old matcher
    'collision-e.md':FM('project', { metadata: true, extra: '  node_type: reference\n' }), // guards `^\s*type:` anchor
    'hyphen-h.md':   FM('reference-custom', { metadata: true }), // counted: type is NOT exactly `reference`
    'reference_f.md':FM('reference'),                            // excluded: prefix
    'slug-ref-g.md': FM('reference', { metadata: true }),        // excluded: frontmatter
    'MEMORY.md':     '# index\n',                                // excluded: index
  } });
  assertHasSignal(p2.signals, 'patterns-to-promote');
  const m = p2.ctx.match(/(\d+) auto-memory pattern\(s\) in this repo not yet codified/);
  assert(m && Number(m[1]) === 6, `expected 6 counted candidates, got ${m ? m[1] : 'none'}`);
  assertNoSignal(p2.signals, 'memory-review-due',
    'memory-review-due must stay silent while patterns-to-promote fires (mutual exclusion)');
});

test('memory-review-due fires for stale never-triaged dir (below volume threshold)', () => {
  const { p2 } = tmpSession({
    memFiles: { 'feedback_a.md': FM('feedback'), 'project_b.md': FM('project') }, // 2 < threshold 3
    dirAgeDays: 40,
  });
  assertHasSignal(p2.signals, 'memory-review-due',
    'stale memory (dir 40d old, untriaged) must trigger memory-review-due');
  assertNoSignal(p2.signals, 'patterns-to-promote',
    'below-threshold count must not trigger the volume signal');
});

test('memory-review-due stays silent for a fresh never-triaged dir', () => {
  const { p2 } = tmpSession({
    memFiles: { 'feedback_a.md': FM('feedback'), 'project_b.md': FM('project') },
    dirAgeDays: 1,
  });
  assertNoSignal(p2.signals, 'memory-review-due',
    'a freshly-written memory dir is not stale — no nudge yet');
  assertNoSignal(p2.signals, 'patterns-to-promote');
});

test('memory-review-due fires via the last-triage clock (triaged long ago)', () => {
  const { p2 } = tmpSession({
    memFiles: { 'feedback_a.md': FM('feedback'), 'project_b.md': FM('project') },
    dirAgeDays: 0,                  // dir is fresh; only the triage timestamp is stale
    lastPromotionAgeDays: 40,
  });
  assertHasSignal(p2.signals, 'memory-review-due',
    'triaged 40d ago with patterns still present must trigger the staleness nudge');
});

test('memory-review-due fires when at-threshold but nothing-new since a stale triage', () => {
  // count ≥ threshold, but dir older than the triage → memTouchedSinceCheck=false
  // → patterns-to-promote stays silent → the staleness clock takes over.
  const { p2 } = tmpSession({
    memFiles: { 'feedback_a.md': FM('feedback'), 'project_b.md': FM('project'), 'user_c.md': FM('user') },
    dirAgeDays: 50,
    lastPromotionAgeDays: 40,
  });
  assertNoSignal(p2.signals, 'patterns-to-promote',
    'nothing written since the last triage — volume signal must stay quiet');
  assertHasSignal(p2.signals, 'memory-review-due',
    'stale triage (40d) with patterns still present must trigger the staleness nudge');
});

// ── State location parity (recorder ↔ hook share ONE dir) ─────────────────────
// Regression for the split-brain bug: the lint-engine hook (which gets
// CLAUDE_PLUGIN_DATA from Claude Code) and `scripts/state.js record-*` (run via
// the Bash tool, which does NOT) resolved STATE_DIR to two different places, so
// recorded cadence timestamps never reached the hook and signals re-fired
// forever. The old harness force-set CLAUDE_PLUGIN_DATA on both sides and never
// reproduced the asymmetry. These tests exercise the real recorder process and
// prove resolution no longer depends on CLAUDE_PLUGIN_DATA.
console.log('\nN. State location parity (recorder ↔ hook share one dir)');

test('record-audit (separate process) silences the hook signal regardless of CLAUDE_PLUGIN_DATA', () => {
  const home    = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-home-'));
  const repoRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-repo-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-state-'));
  // A decoy dir: under the OLD code the hook would have followed this and the
  // recorder would not — the exact asymmetry that split the state.
  const decoyPluginData = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-decoy-'));
  try {
    const realRepo = fs.realpathSync(repoRaw);
    const g = args => cp.execFileSync('git', args, { cwd: realRepo, stdio: 'ignore' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t.test']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(realRepo, 'CLAUDE.md'), '# rules\n');
    fs.writeFileSync(path.join(realRepo, 'package-lock.json'), '{}\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);

    const sessionId = 'e2e-parity-' + Math.random().toString(36).slice(2);
    // Both processes get the SAME MASTERSOFT_STATE_DIR and a DECOY (and differing)
    // CLAUDE_PLUGIN_DATA, proving the latter is ignored.
    const hookEnv = { HOME: home, MASTERSOFT_LINTS_ACK_HOURS: '0', CLAUDE_PLUGIN_DATA: decoyPluginData };

    // Prompt #1 warms the session (security-audit-due is emitSignals-gated to #2+).
    runHook(realRepo, { sessionId, stateDir, env: hookEnv });

    // The recorder runs as its own process — exactly how the skills invoke it.
    const rec = cp.spawnSync(process.execPath, [STATE_JS, 'record-audit'], {
      cwd: realRepo,
      env: { ...process.env, HOME: home, MASTERSOFT_STATE_DIR: stateDir, CLAUDE_PLUGIN_DATA: decoyPluginData },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (rec.error) throw rec.error;

    const p2 = runHook(realRepo, { sessionId, stateDir, env: hookEnv });
    assertNoSignal(p2.signals, 'security-audit-due',
      'record-audit in a separate process must silence the hook — both must resolve the SAME state dir');
    assert(!fs.existsSync(path.join(decoyPluginData, 'lint-engine-state.json')),
      'neither hook nor recorder may write to CLAUDE_PLUGIN_DATA — it must be ignored entirely');
    assert(fs.existsSync(path.join(stateDir, 'lint-engine-state.json')),
      'state must land in the shared MASTERSOFT_STATE_DIR');
  } finally {
    [home, repoRaw, stateDir, decoyPluginData].forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test('repoRoot keys off git toplevel, not CLAUDE_PROJECT_DIR (hook ↔ recorder key parity)', () => {
  // The second asymmetry: CLAUDE_PROJECT_DIR is injected into the hook process
  // by Claude Code but absent in the Bash-tool subprocess that runs the
  // recorder — the SAME injection gap that split CLAUDE_PLUGIN_DATA. If the hook
  // keyed __repos on $CLAUDE_PROJECT_DIR while the recorder keyed on git
  // toplevel, the recorded timestamp would land under a different key and the
  // signal would re-fire forever. This reproduces that exact env gap.
  const home    = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-home-'));
  const repoRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-repo-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-state-'));
  // CLAUDE_PROJECT_DIR points somewhere OTHER than the repo root — under the old
  // code the hook would have keyed on this and never matched the recorder.
  const decoyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-projdir-'));
  try {
    const realRepo = fs.realpathSync(repoRaw);
    const g = args => cp.execFileSync('git', args, { cwd: realRepo, stdio: 'ignore' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t.test']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(realRepo, 'CLAUDE.md'), '# rules\n');
    fs.writeFileSync(path.join(realRepo, 'package-lock.json'), '{}\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'init']);

    const sessionId = 'e2e-keyparity-' + Math.random().toString(36).slice(2);
    // Hook gets CLAUDE_PROJECT_DIR set (to the decoy); recorder gets it removed.
    const hookEnv = { HOME: home, MASTERSOFT_LINTS_ACK_HOURS: '0', CLAUDE_PROJECT_DIR: decoyProjectDir };
    runHook(realRepo, { sessionId, stateDir, env: hookEnv });

    const recEnv = { ...process.env, HOME: home, MASTERSOFT_STATE_DIR: stateDir };
    delete recEnv.CLAUDE_PROJECT_DIR;
    const rec = cp.spawnSync(process.execPath, [STATE_JS, 'record-audit'], {
      cwd: realRepo, env: recEnv, encoding: 'utf8', timeout: 10000,
    });
    if (rec.error) throw rec.error;

    const p2 = runHook(realRepo, { sessionId, stateDir, env: hookEnv });
    assertNoSignal(p2.signals, 'security-audit-due',
      'hook (CLAUDE_PROJECT_DIR set elsewhere) and recorder (no CLAUDE_PROJECT_DIR) must resolve the SAME __repos key via git toplevel');
  } finally {
    [home, repoRaw, stateDir, decoyProjectDir].forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// ─── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed + skipped} tests — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
