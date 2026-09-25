#!/usr/bin/env node
/**
 * E2E tests for scripts/sentry-api.js — the REST call behind the root-cause
 * step of /mastersoft:sentry.
 *
 * Config resolution runs against temp directories standing in for the home
 * and the project; the request tests run the script as a subprocess against a
 * local HTTP server. No network.
 *
 * Usage: node plugins/mastersoft/tests/sentry-api.e2e.js
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');
const http = require('http');

const SCRIPT = path.resolve(__dirname, '../scripts/sentry-api.js');
const { parseIni, resolveConfig, summarize } = require(SCRIPT);

// ─── helpers ──────────────────────────────────────────────────────────────────

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sentry-'));
  tmpDirs.push(dir);
  return dir;
}

function writeRc(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.sentryclirc'), text);
}

function runScript(args, env, cwd) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function withServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    .then(() => fn(`http://127.0.0.1:${server.address().port}`))
    .finally(() => new Promise(resolve => server.close(resolve)));
}

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓  ${name}`); }
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

(async () => {
  await test('parseIni reads sections and skips comments', () => {
    const ini = parseIni('# note\n[defaults]\nurl = https://sentry.example.com/\n; other\n[auth]\ntoken=abc\n');
    assertEq(ini['defaults.url'], 'https://sentry.example.com/');
    assertEq(ini['auth.token'], 'abc');
  });

  await test('a project .sentryclirc wins over ~/.sentryclirc, key by key', () => {
    const root = tmpDir();
    writeRc(path.join(root, 'home'), '[defaults]\nurl=https://home.example.com/\n[auth]\ntoken=home\n');
    writeRc(path.join(root, 'proj'), '[auth]\ntoken=proj\n');
    fs.mkdirSync(path.join(root, 'proj', 'sub'));
    const cfg = resolveConfig({}, path.join(root, 'proj', 'sub'), path.join(root, 'home'));
    assertEq(cfg.url, 'https://home.example.com');
    assertEq(cfg.token, 'proj');
  });

  await test('SENTRY_URL and SENTRY_AUTH_TOKEN win over .sentryclirc', () => {
    const root = tmpDir();
    writeRc(root, '[defaults]\nurl=https://rc.example.com/\n[auth]\ntoken=rc\n');
    const cfg = resolveConfig({ SENTRY_URL: 'https://env.example.com/', SENTRY_AUTH_TOKEN: 'env' }, root, tmpDir());
    assertEq(cfg.url, 'https://env.example.com');
    assertEq(cfg.token, 'env');
  });

  await test('no config falls back to sentry.io with no token', () => {
    const cfg = resolveConfig({}, tmpDir(), tmpDir());
    assertEq(cfg.url, 'https://sentry.io');
    assertEq(cfg.token, '');
  });

  await test('GETs the path under /api/0/ with the bearer token and prints the body', async () => {
    let seen;
    await withServer((req, res) => {
      seen = { url: req.url, auth: req.headers.authorization };
      res.end('{"eventID":"e1"}');
    }, async base => {
      const r = await runScript(['issues/42/events/latest/'], { HOME: tmpDir(), SENTRY_URL: base + '/', SENTRY_AUTH_TOKEN: 'tok' }, tmpDir());
      assertEq(r.code, 0, r.stderr);
      assertEq(r.stdout, '{"eventID":"e1"}\n');
    });
    assertEq(seen.url, '/api/0/issues/42/events/latest/');
    assertEq(seen.auth, 'Bearer tok');
  });

  await test('reads the token from .sentryclirc when the env has none', async () => {
    const proj = tmpDir();
    let auth;
    await withServer((req, res) => { auth = req.headers.authorization; res.end('{}'); }, async base => {
      writeRc(proj, `[defaults]\nurl=${base}/\n[auth]\ntoken=fromrc\n`);
      const r = await runScript(['/api/0/organizations/o/issues/1/events/'], { HOME: tmpDir() }, proj);
      assertEq(r.code, 0, r.stderr);
    });
    assertEq(auth, 'Bearer fromrc');
  });

  await test('summarize keeps title, request and the last frames of each exception', () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({ filename: `f${i}.js`, lineNo: i, function: `fn${i}`, inApp: i > 27, vars: { big: 'x' } }));
    const s = summarize({
      eventID: 'e1', title: 'TypeError: x', culprit: 'app/x', platform: 'javascript', dateCreated: 'd', release: { version: '1.2.3' },
      tags: [{ key: 'level', value: 'error' }],
      entries: [
        { type: 'breadcrumbs', data: { values: [] } },
        { type: 'request', data: { method: 'GET', url: 'https://app/x', headers: [['cookie', 'secret']] } },
        { type: 'exception', data: { values: [{ type: 'TypeError', value: 'x is undefined', stacktrace: { frames } }] } },
      ],
    });
    assertEq(s.release, '1.2.3');
    assertEq(s.tags.level, 'error');
    assertEq(JSON.stringify(s.request), '{"method":"GET","url":"https://app/x"}');
    assertEq(s.exceptions[0].frames.length, 25);
    assertEq(JSON.stringify(s.exceptions[0].frames[24]), '{"file":"f29.js","line":29,"function":"fn29","inApp":true}');
  });

  await test('--summary prints the cut-down event, and a non-event body as is', async () => {
    await withServer((req, res) => {
      res.end(req.url.includes('latest') ? JSON.stringify({ eventID: 'e2', title: 't', entries: [], _meta: { big: 1 } }) : '[{"id":"1"}]');
    }, async base => {
      const env = { HOME: tmpDir(), SENTRY_URL: base, SENTRY_AUTH_TOKEN: 'tok' };
      const ev = await runScript(['--summary', 'issues/1/events/latest/'], env, tmpDir());
      assertEq(ev.code, 0, ev.stderr);
      const parsed = JSON.parse(ev.stdout);
      assertEq(parsed.eventID, 'e2');
      assertEq(parsed._meta, undefined);
      const list = await runScript(['--summary', 'organizations/o/issues/1/events/'], env, tmpDir());
      assertEq(list.stdout, '[{"id":"1"}]\n');
    });
  });

  await test('an HTTP error exits 1 and names the status', async () => {
    await withServer((req, res) => { res.statusCode = 401; res.end('{"detail":"no"}'); }, async base => {
      const r = await runScript(['issues/1/events/latest/'], { HOME: tmpDir(), SENTRY_URL: base, SENTRY_AUTH_TOKEN: 'bad' }, tmpDir());
      assertEq(r.code, 1);
      if (!r.stderr.includes('HTTP 401')) throw new Error(`stderr lacks the status: ${r.stderr}`);
    });
  });

  await test('no token exits 1 before any request', async () => {
    const r = await runScript(['issues/1/events/latest/'], { HOME: tmpDir(), SENTRY_URL: 'http://127.0.0.1:9' }, tmpDir());
    assertEq(r.code, 1);
    if (!r.stderr.includes('no token')) throw new Error(`unexpected stderr: ${r.stderr}`);
  });

  // ─── summary ────────────────────────────────────────────────────────────────

  tmpDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failures.length) {
    failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
    process.exit(1);
  }
  process.exit(0);
})();
