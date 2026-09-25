#!/usr/bin/env node
'use strict';

// GET one Sentry REST API path, for the root-cause step of /mastersoft:sentry,
// with the host and token sentry-cli would use: SENTRY_URL and
// SENTRY_AUTH_TOKEN first, then the `.sentryclirc` files, where one nearer the
// working directory wins over one higher up and all of them over
// ~/.sentryclirc. Prints the response body. The token stays inside this
// process: read in the shell, it needs `$(…)` and a file outside the working
// directory, and Claude Code asks for approval on both.
//
// Usage: node sentry-api.js [--summary] <path under /api/0/>
//   e.g. node sentry-api.js --summary issues/1234/events/latest/
// --summary cuts an event down to title, culprit, tags, request and each
// exception with its last frames (file, line, function, in-app); a full event
// runs to tens of KB, more than a tool result shows inline.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FRAMES = 25;

function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { section = header[1].trim(); continue; }
    const eq = line.indexOf('=');
    if (eq > 0) out[`${section}.${line.slice(0, eq).trim()}`] = line.slice(eq + 1).trim();
  }
  return out;
}

function rcFiles(cwd, home) {
  const nearFirst = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    nearFirst.push(path.join(dir, '.sentryclirc'));
    if (path.dirname(dir) === dir) break;
  }
  return [path.join(home, '.sentryclirc'), ...nearFirst.reverse()];
}

function resolveConfig(env, cwd, home) {
  const rc = {};
  for (const file of rcFiles(cwd, home)) {
    try { Object.assign(rc, parseIni(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  return {
    url: (env.SENTRY_URL || rc['defaults.url'] || 'https://sentry.io/').replace(/\/+$/, ''),
    token: env.SENTRY_AUTH_TOKEN || rc['auth.token'] || '',
  };
}

function summarize(event) {
  const entry = type => (event.entries || []).find(e => e.type === type);
  const exception = entry('exception');
  const request = entry('request');
  return {
    eventID: event.eventID,
    title: event.title,
    culprit: event.culprit,
    platform: event.platform,
    dateCreated: event.dateCreated,
    release: event.release ? event.release.version : null,
    tags: Object.fromEntries((event.tags || []).map(t => [t.key, t.value])),
    request: request ? { method: request.data.method, url: request.data.url } : null,
    exceptions: exception ? exception.data.values.map(v => ({
      type: v.type,
      value: v.value,
      frames: ((v.stacktrace && v.stacktrace.frames) || []).slice(-MAX_FRAMES).map(f => ({
        file: f.filename || f.absPath || f.module,
        line: f.lineNo,
        function: f.function,
        inApp: f.inApp,
      })),
    })) : [],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const summary = args.includes('--summary');
  const apiPath = (args.find(a => !a.startsWith('--')) || '').replace(/^\/+/, '').replace(/^api\/0\//, '');
  if (!apiPath) {
    process.stderr.write('usage: sentry-api.js [--summary] <path under /api/0/>\n');
    process.exit(2);
  }
  const { url, token } = resolveConfig(process.env, process.cwd(), os.homedir());
  if (!token) {
    process.stderr.write('sentry-api: no token; set SENTRY_AUTH_TOKEN or [auth] token= in .sentryclirc\n');
    process.exit(1);
  }
  let res;
  try {
    res = await fetch(`${url}/api/0/${apiPath}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    process.stderr.write(`sentry-api: ${url} unreachable: ${e.cause ? e.cause.message : e.message}\n`);
    process.exit(1);
  }
  const body = await res.text();
  if (!res.ok) {
    process.stderr.write(`sentry-api: HTTP ${res.status} from ${url}/api/0/${apiPath}\n${body.slice(0, 500)}\n`);
    process.exit(1);
  }
  if (summary) {
    let event;
    try { event = JSON.parse(body); } catch {}
    if (event && Array.isArray(event.entries)) {
      process.stdout.write(JSON.stringify(summarize(event), null, 1) + '\n');
      return;
    }
  }
  process.stdout.write(body.endsWith('\n') ? body : body + '\n');
}

if (require.main === module) main();

module.exports = { parseIni, rcFiles, resolveConfig, summarize };
