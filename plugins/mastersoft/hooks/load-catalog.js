'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinJson, loadState, saveState } = require('./lib');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const STATE_FILE = path.join(os.tmpdir(), '.claude-catalog-hook-state.json');
const MAX_SESSIONS = 50;

function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return [null, null];

  const block = m[1];
  let name = null;
  const descLines = [];
  let inDesc = false;
  let firstTag = null;

  for (const line of block.split('\n')) {
    if (line.startsWith('name:')) {
      name = line.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '');
      inDesc = false;
    } else if (line.startsWith('description:')) {
      const rest = line.split(':').slice(1).join(':').trim();
      if (rest.startsWith('>')) {
        inDesc = true;
      } else {
        descLines.push(rest.replace(/^["']|["']$/g, ''));
        inDesc = false;
      }
    } else if (inDesc && line.startsWith('  ')) {
      descLines.push(line.trim());
    } else if (line.trim().startsWith('tags:') && !firstTag) {
      const tagMatch = line.match(/\[(.+?)\]/);
      if (tagMatch) {
        firstTag = tagMatch[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
      }
    } else {
      inDesc = false;
    }
  }

  const desc = descLines.join(' ').trim();
  const tag = firstTag || fallbackTag(desc);
  return [name, tag];
}

function fallbackTag(desc) {
  if (!desc) return null;
  const stripped = desc.replace(
    /^(Use |Invoke |Orchestrate |Guide |Consult |Provide |Read and write |Read |for |proactively for |Fast,? |targeted |users through a |structured workflow for |writing and |creating effective )+/i,
    ''
  );
  const chunk = stripped.split(/[.,;]/)[0];
  const words = chunk.split(/\s+/).slice(0, 2);
  return words.map(w => w.toLowerCase().replace(/[()"']/g, '')).filter(Boolean).join('-') || null;
}

function scanEntries(directory, globPattern) {
  const entries = [];
  try {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return entries;
  } catch {
    return entries;
  }

  if (globPattern === '*/SKILL.md') {
    for (const d of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(directory, d.name, 'SKILL.md');
      try {
        const text = fs.readFileSync(p, 'utf8');
        const [name, tag] = parseFrontmatter(text);
        if (name && tag) entries.push([name, tag]);
      } catch { /* skip */ }
    }
  } else if (globPattern === '*.md') {
    for (const f of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      const p = path.join(directory, f.name);
      try {
        const text = fs.readFileSync(p, 'utf8');
        const [name, tag] = parseFrontmatter(text);
        if (name && tag) entries.push([name, tag]);
      } catch { /* skip */ }
    }
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}

function buildCatalog() {
  const skills = scanEntries(SKILLS_DIR, '*/SKILL.md');
  const agents = scanEntries(AGENTS_DIR, '*.md');
  if (!skills.length && !agents.length) return null;

  const parts = [];
  if (skills.length) {
    const items = skills.map(([n, t]) =>
      (t === n || n.startsWith(t)) ? n : `${n} (${t})`
    ).join(', ');
    parts.push(`Skills: ${items}`);
  }
  if (agents.length) {
    const items = agents.map(([n, t]) =>
      (t === n || n.startsWith(t)) ? n : `${n} (${t})`
    ).join(', ');
    parts.push(`Agents: ${items}`);
  }
  return parts.join(' | ');
}

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);

  const sessionId = input.session_id || '';
  if (!sessionId) process.exit(0);

  const state = loadState(STATE_FILE);
  if (state[sessionId]) process.exit(0);

  const catalog = buildCatalog();
  if (!catalog) process.exit(0);

  state[sessionId] = true;
  saveState(STATE_FILE, state, MAX_SESSIONS);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: catalog,
    },
  }) + '\n');

  process.exit(0);
}

main();
