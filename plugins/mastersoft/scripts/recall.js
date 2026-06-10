#!/usr/bin/env node
'use strict';

// Read-only reader over Claude Code's own session transcripts, for the
// `hindsight` agent (invoked by /mastersoft:recall). Transcripts live as JSONL
// at <config>/projects/<dash-slug>/<session-id>.jsonl, one JSON object per
// line. This script does the deterministic extraction (which sessions, what
// titles, which lines match a query); the agent does the synthesis. It NEVER
// writes — purely a reader.
//
// Subcommands:
//   list    [--project <name>] [--limit N]
//       Recent-sessions digest for a project (default: current repo).
//   search  <query…> [--project <name>] [--all-projects] [--limit N] [--per-session N]
//       Sessions whose user/assistant text matches <query>, with excerpts.
//   show    <session-id> [--project <name>] [--max N]
//       Linear transcript digest of one session (last N turns).
//   projects [--limit N]
//       Available project dirs with session counts + last activity — use to
//       resolve a name to pass to --project.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { resolveRepoRoot } = require('../hooks/lib');

// Encode matching Claude Code's per-project dir convention under
// <config>/projects/<slug>/: every `/`, `\`, `.` and `_` becomes `-`.
// Intentionally duplicated from scripts/state.js and hooks/lint-engine.js
// (same 1-line function) — keep the copies in sync.
function claudeProjectSlug(repoRoot) {
  return repoRoot.replace(/[/._\\]/g, '-');
}

// Honor CLAUDE_CONFIG_DIR (transcripts move with it, per Claude Code docs),
// falling back to ~/.claude. Unlike the plugin's own state dir, this reads
// Claude Code's data, so the documented override must apply.
function projectsRoot() {
  const cfg = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  const base = cfg || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

function fail(msg) {
  process.stderr.write(msg.replace(/\n*$/, '\n'));
  process.exit(1);
}

function trunc(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function rel(iso) {
  if (!iso) return '?';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const s = (Date.now() - then) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return Math.round(m) + 'm ago';
  const h = m / 60; if (h < 24) return Math.round(h) + 'h ago';
  const d = h / 24; if (d < 30) return Math.round(d) + 'd ago';
  const mo = d / 30; if (mo < 12) return Math.round(mo) + 'mo ago';
  return Math.round(mo / 12) + 'y ago';
}

function dateStr(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

// Slash-command stdin (e.g. /clear) is recorded as a user message wrapped in
// <command-name>…</command-name> / <local-command-…> tags. It's a real action
// but useless as "what the user asked", so we skip it when picking firstUser.
function isCommandNoise(txt) {
  return /^<command-(name|message|args)\b/.test(txt) || txt.includes('<local-command-');
}

// Pull the human-readable text from a user/assistant message, ignoring
// thinking blocks, tool calls and tool results (noise for a retrospective).
function msgText(o) {
  const m = o && o.message;
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      fn(o);
    }
  } finally {
    rl.close();
  }
}

function listProjectDirs() {
  const root = projectsRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    fail(`Projects dir not found: ${root}`);
  }
  return { root, entries };
}

function resolveProjectDir(projectArg) {
  const { root, entries } = listProjectDirs();
  if (!projectArg) {
    const slug = claudeProjectSlug(resolveRepoRoot(process.cwd()));
    const dir = path.join(root, slug);
    if (!fs.existsSync(dir)) {
      fail(`No transcripts for the current project.\nLooked in: ${dir}\n` +
        `Sessions appear here after you've worked in this repo. ` +
        `Use --project <name> to target another, or 'projects' to list them.`);
    }
    return { dir, label: slug };
  }
  const q = projectArg.toLowerCase();
  const qslug = claudeProjectSlug(projectArg).toLowerCase();
  const lowered = entries.map((n) => ({ name: n, l: n.toLowerCase() }));
  // Tiered match, most specific first. A bare name like "officegenius" is a
  // substring of a sibling "officegenius-backend", so an exact dir name wins,
  // then a trailing-segment match (the slug ends with the query — the repo's
  // own folder name), and only then a loose substring. Without the endsWith
  // tier every bare name that prefixes a sibling stays ambiguous forever.
  const tiers = [
    (e) => e.l === q || e.l === qslug,
    (e) => e.l.endsWith(qslug) || e.l.endsWith(q),
    (e) => e.l.includes(q) || e.l.includes(qslug),
  ];
  let matches = [];
  for (const tier of tiers) {
    matches = lowered.filter(tier);
    if (matches.length) break;
  }
  if (!matches.length) fail(`No project dir matches "${projectArg}" under ${root}.`);
  if (matches.length > 1) {
    fail(`"${projectArg}" matches ${matches.length} projects — refine the name (try the folder tail, e.g. a longer suffix):\n` +
      matches.map((m) => '  ' + m.name).join('\n'));
  }
  return { dir: path.join(root, matches[0].name), label: matches[0].name };
}

function sessionFiles(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: f.slice(0, -6), file: path.join(dir, f) }));
}

async function readMeta(sf) {
  const m = {
    id: sf.id, file: sf.file, title: null, lastPrompt: null,
    firstUser: null, summary: null, branch: null,
    firstTs: null, lastTs: null, turns: 0,
  };
  await eachLine(sf.file, (o) => {
    const t = o.type;
    if (t === 'ai-title' && o.aiTitle) m.title = o.aiTitle;
    else if (t === 'agent-name' && o.agentName && !m.title) m.title = o.agentName;
    else if (t === 'last-prompt' && o.lastPrompt) m.lastPrompt = o.lastPrompt;
    else if (t === 'summary' && o.summary) m.summary = o.summary;
    if (o.gitBranch) m.branch = o.gitBranch;
    if (o.timestamp) { if (!m.firstTs) m.firstTs = o.timestamp; m.lastTs = o.timestamp; }
    if (t === 'user' && !o.isMeta && !o.isSidechain) {
      const txt = msgText(o).trim();
      if (txt) { m.turns++; if (!m.firstUser && !isCommandNoise(txt)) m.firstUser = txt; }
    }
  });
  if (!m.lastTs) {
    try { m.lastTs = fs.statSync(sf.file).mtime.toISOString(); } catch {}
  }
  return m;
}

function makeSnippet(txt, q, width = 200) {
  const flat = txt.replace(/\s+/g, ' ').trim();
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return trunc(flat, width);
  const before = Math.floor(width / 3);
  const start = Math.max(0, i - before);
  const end = Math.min(flat.length, i + q.length + (width - before));
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

function out(s) { process.stdout.write(s); }

async function cmdList(projectArg, limit) {
  const proj = resolveProjectDir(projectArg);
  const files = sessionFiles(proj.dir);
  if (!files.length) { out(`Project: ${proj.label}\n(no sessions found)\n`); return; }
  const metas = [];
  for (const sf of files) metas.push(await readMeta(sf));
  metas.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  const shown = metas.slice(0, limit);
  out(`Project: ${proj.label}\n${metas.length} session(s), showing ${shown.length} most recent.\n\n`);
  shown.forEach((m, idx) => {
    out(`${idx + 1}. ${m.title || '(untitled)'}\n`);
    const bits = [`${rel(m.lastTs)} (${dateStr(m.lastTs)})`];
    if (m.branch) bits.push(`branch ${m.branch}`);
    bits.push(`${m.turns} turn(s)`);
    bits.push(`id ${m.id}`);
    out(`   ${bits.join(' · ')}\n`);
    if (m.firstUser) out(`   first: "${trunc(m.firstUser, 160)}"\n`);
    if (m.lastPrompt && m.lastPrompt !== m.firstUser) out(`   last:  "${trunc(m.lastPrompt, 160)}"\n`);
    if (m.summary) out(`   summary: ${trunc(m.summary, 200)}\n`);
    out(`   resume: claude --resume ${m.id}\n\n`);
  });
}

async function cmdSearch(query, projectArg, allProjects, limit, perSession) {
  let dirs;
  if (allProjects) {
    const { root, entries } = listProjectDirs();
    dirs = entries.map((n) => ({ dir: path.join(root, n), label: n }));
  } else {
    const p = resolveProjectDir(projectArg);
    dirs = [{ dir: p.dir, label: p.label }];
  }
  const q = query.toLowerCase();
  const results = [];
  for (const d of dirs) {
    for (const sf of sessionFiles(d.dir)) {
      let title = null, lastTs = null, branch = null, total = 0;
      const excerpts = [];
      await eachLine(sf.file, (o) => {
        const t = o.type;
        if (t === 'ai-title' && o.aiTitle) title = o.aiTitle;
        else if (t === 'agent-name' && o.agentName && !title) title = o.agentName;
        if (o.timestamp) lastTs = o.timestamp;
        if (o.gitBranch) branch = o.gitBranch;
        const isUser = t === 'user' && !o.isMeta && !o.isSidechain;
        if (isUser || t === 'assistant') {
          const txt = msgText(o);
          if (txt && txt.toLowerCase().includes(q)) {
            total++;
            if (excerpts.length < perSession) {
              excerpts.push({ role: isUser ? 'user' : 'assistant', ts: o.timestamp || lastTs, snippet: makeSnippet(txt, q) });
            }
          }
        }
      });
      if (excerpts.length) results.push({ label: d.label, id: sf.id, title, lastTs, branch, total, excerpts });
    }
  }
  results.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  const shown = results.slice(0, limit);
  const scope = allProjects ? 'all projects' : dirs[0].label;
  out(`Search "${query}" in ${scope}: ${results.length} matching session(s)` +
    (results.length > shown.length ? `, showing ${shown.length}` : '') + `.\n\n`);
  shown.forEach((r, idx) => {
    out(`${idx + 1}. ${r.title || '(untitled)'}\n`);
    const bits = [`${rel(r.lastTs)} (${dateStr(r.lastTs)})`];
    if (allProjects) bits.push(r.label);
    if (r.branch) bits.push(`branch ${r.branch}`);
    bits.push(`${r.total} hit(s)`);
    bits.push(`id ${r.id}`);
    out(`   ${bits.join(' · ')}\n`);
    for (const e of r.excerpts) out(`   [${e.role} ${dateStr(e.ts)}] ${e.snippet}\n`);
    out(`   resume: claude --resume ${r.id}\n\n`);
  });
  if (!shown.length) out('No matches. Try a broader query or --all-projects.\n');
}

function findSession(sessionId, projectArg) {
  const root = projectsRoot();
  let dirs = [];
  if (projectArg) {
    dirs = [resolveProjectDir(projectArg).dir];
  } else {
    try {
      const slug = claudeProjectSlug(resolveRepoRoot(process.cwd()));
      const d = path.join(root, slug);
      if (fs.existsSync(d)) dirs.push(d);
    } catch {}
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const d = path.join(root, e.name);
        if (!dirs.includes(d)) dirs.push(d);
      }
    } catch {}
  }
  for (const d of dirs) {
    const exact = path.join(d, sessionId + '.jsonl');
    if (fs.existsSync(exact)) return { file: exact, label: path.basename(d) };
  }
  for (const d of dirs) {
    let fl;
    try { fl = fs.readdirSync(d); } catch { continue; }
    const hit = fl.find((f) => f.endsWith('.jsonl') && f.startsWith(sessionId));
    if (hit) return { file: path.join(d, hit), label: path.basename(d) };
  }
  return null;
}

async function cmdShow(sessionId, projectArg, max) {
  const found = findSession(sessionId, projectArg);
  if (!found) fail(`Session "${sessionId}" not found.` + (projectArg ? '' : ' Pass --project <name> to scope the lookup.'));
  let title = null;
  const turns = [];
  await eachLine(found.file, (o) => {
    const t = o.type;
    if (t === 'ai-title' && o.aiTitle) title = o.aiTitle;
    else if (t === 'agent-name' && o.agentName && !title) title = o.agentName;
    if (t === 'user' && !o.isMeta && !o.isSidechain) {
      const txt = msgText(o).trim();
      if (txt) turns.push({ role: 'user', ts: o.timestamp, txt });
    } else if (t === 'assistant') {
      const m = o.message;
      const parts = m && Array.isArray(m.content) ? m.content : [];
      const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
      const tools = parts.filter((p) => p && p.type === 'tool_use').map((p) => p.name);
      if (text) turns.push({ role: 'assistant', ts: o.timestamp, txt: text });
      else if (tools.length) turns.push({ role: 'assistant', ts: o.timestamp, txt: `[tools: ${tools.join(', ')}]` });
    }
  });
  const shown = turns.slice(-max);
  out(`Session: ${title || '(untitled)'}  ·  id ${path.basename(found.file).slice(0, -6)}  ·  ${found.label}\n`);
  out(`${turns.length} turn(s), showing last ${shown.length}.\n\n`);
  for (const tn of shown) {
    out(`[${tn.role} ${dateStr(tn.ts)}]\n${trunc(tn.txt, 1200)}\n\n`);
  }
}

async function cmdProjects(limit) {
  const { root, entries } = listProjectDirs();
  const rows = entries.map((name) => {
    const dir = path.join(root, name);
    const files = sessionFiles(dir);
    let last = 0;
    for (const sf of files) {
      try { const mt = fs.statSync(sf.file).mtimeMs; if (mt > last) last = mt; } catch {}
    }
    return { name, count: files.length, last };
  });
  rows.sort((a, b) => b.last - a.last);
  const shown = rows.slice(0, limit);
  out(`${rows.length} project(s) under ${root}, showing ${shown.length} most recent.\n\n`);
  for (const r of shown) {
    const iso = r.last ? new Date(r.last).toISOString() : null;
    out(`${r.name}\n   ${r.count} session(s) · last ${rel(iso)} (${dateStr(iso)})\n\n`);
  }
}

function getOpt(rest, name, def) {
  const i = rest.indexOf(name);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : def;
}
function getFlag(rest, name) { return rest.includes(name); }
function getInt(rest, name, def) {
  const v = getOpt(rest, name, null);
  if (v == null) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function positionals(rest) {
  const valued = new Set(['--project', '--limit', '--per-session', '--max']);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

const USAGE =
  'Usage: recall.js <list|search|show|projects> [options]\n' +
  '  list    [--project <name>] [--limit N]\n' +
  '  search  <query…> [--project <name>] [--all-projects] [--limit N] [--per-session N]\n' +
  '  show    <session-id> [--project <name>] [--max N]\n' +
  '  projects [--limit N]\n';

(async () => {
  const [, , cmd, ...rest] = process.argv;
  const project = getOpt(rest, '--project', null);
  try {
    switch (cmd) {
      case 'list':
        await cmdList(project, getInt(rest, '--limit', 10));
        break;
      case 'search': {
        const query = positionals(rest).join(' ').trim();
        if (!query) fail('search requires a query.\n' + USAGE);
        await cmdSearch(query, project, getFlag(rest, '--all-projects'),
          getInt(rest, '--limit', 12), getInt(rest, '--per-session', 3));
        break;
      }
      case 'show': {
        const id = positionals(rest)[0];
        if (!id) fail('show requires a session id.\n' + USAGE);
        await cmdShow(id, project, getInt(rest, '--max', 50));
        break;
      }
      case 'projects':
        await cmdProjects(getInt(rest, '--limit', 25));
        break;
      default:
        process.stderr.write(USAGE);
        process.exit(2);
    }
  } catch (e) {
    fail(`recall.js ${cmd} failed: ${e && e.message ? e.message : e}`);
  }
})();
