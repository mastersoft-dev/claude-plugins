'use strict';

// Shared org-rules tier loader. Single source for the three injection tiers
// so SessionStart (inject-session), UserPromptSubmit (inject-turn), and
// SubagentStart (inject-org-rules) all resolve content the same way.
//
// Content lives in ORG_RULES.md, split by HTML-comment markers:
//   <!-- tier:1 -->  operating posture — how to work (main agent only)
//   <!-- tier:2 -->  code hygiene standards (main agent + every subagent)
//   <!-- tier:3 -->  output style, ~1 line (every prompt + every subagent)
// Anything before the first marker is maintainer documentation, never injected.
//
// Per-tier env (string, \n allowed): `_TEXT` replaces the bundled section,
// `_APPEND` adds a line on top of the base. An org tunes wording via managed-
// settings `env`; a repo appends a conditional rule (e.g. tenant isolation) via
// project-settings `env` — no plugin re-ship. Org control is governed by
// managed-settings pinning; env set at a lower settings tier is gated by the
// same folder-trust dialog as any hook.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ORG_RULES_PATH = path.join(__dirname, '..', 'ORG_RULES.md');
// Claude Code caps additionalContext at 10000 chars (past it the text is
// dumped to a file and replaced with a preview). Stay under it.
const TIER_CAP = 9500;

// Shared with the hook state. The statusline writes the live context-window
// usage here every render; the tier-2 distance gate (inject-turn) reads it.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'mastersoft-state');
const CONTEXT_USAGE_FILE = path.join(STATE_DIR, 'context-usage.json');
const CONTEXT_USAGE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_DISTANCE_PCT = 15;

function stripFrontmatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

// Each tier spans from the end of its own marker to the start of the next tier
// marker (or EOF for the last). Stray HTML comments inside a tier block are
// harmless — they're just kept as part of that tier's content.
function parseTiers(body) {
  const out = { tier1: '', tier2: '', tier3: '' };
  const re = /<!--\s*tier:([123])\s*-->/g;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    marks.push({ key: `tier${m[1]}`, start: m.index, contentStart: re.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    out[marks[i].key] = body.slice(marks[i].contentStart, end).trim();
  }
  return out;
}

function readBundledTiers() {
  try {
    return parseTiers(stripFrontmatter(fs.readFileSync(ORG_RULES_PATH, 'utf8')));
  } catch {
    return { tier1: '', tier2: '', tier3: '' };
  }
}

// off | session | all  (default all). `session` keeps tiers 1+2 but mutes the
// every-prompt nudge for users who find it noisy.
function orgMode() {
  const v = String(process.env.MASTERSOFT_ORG_RULES || '').toLowerCase();
  return (v === 'off' || v === 'session' || v === 'all') ? v : 'all';
}

function quietMutesOrg() {
  const q = process.env.MASTERSOFT_QUIET;
  return q === '1' || q === 'all' || q === 'true';
}

function quietMutesTier3() {
  return quietMutesOrg() || process.env.MASTERSOFT_QUIET === 'tier3';
}

// Per tier: `_TEXT` replaces the bundled section; `_APPEND` adds to whatever
// the base resolved to (bundled or replaced). Append lets a repo keep the org
// floor and add one line on top without restating the whole tier.
function resolveTier(base, replaceEnv, appendEnv) {
  let s = process.env[replaceEnv] || base || '';
  const extra = process.env[appendEnv];
  if (extra) s = s ? `${s}\n${extra}` : extra;
  return s;
}

function loadOrgTiers() {
  const b = readBundledTiers();
  return {
    tier1: resolveTier(b.tier1, 'MASTERSOFT_ORG_TIER1_TEXT', 'MASTERSOFT_ORG_TIER1_APPEND'),
    tier2: resolveTier(b.tier2, 'MASTERSOFT_ORG_TIER2_TEXT', 'MASTERSOFT_ORG_TIER2_APPEND'),
    tier3: resolveTier(b.tier3, 'MASTERSOFT_ORG_TIER3_TEXT', 'MASTERSOFT_ORG_TIER3_APPEND'),
  };
}

function cap(s) {
  return s && s.length > TIER_CAP ? s.slice(0, TIER_CAP) + '\n…[org rules truncated]' : s;
}

// Tier-2 mid-session re-assertion threshold, in context-window percentage
// points. 0 disables. Default 15 (≈150k tokens on a 1M window).
function distancePct() {
  const v = process.env.MASTERSOFT_ORG_RECURRING_DISTANCE_PCT;
  if (v === undefined) return DEFAULT_DISTANCE_PCT;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DISTANCE_PCT;
}

// Latest context-window usage percent, or null if the statusline hasn't
// written it recently (e.g. a non-Mastersoft statusline is active).
function readContextUsagePercent() {
  try {
    const o = JSON.parse(fs.readFileSync(CONTEXT_USAGE_FILE, 'utf8'));
    if (typeof o.usedPercent === 'number' && typeof o.ts === 'number'
        && Date.now() - o.ts <= CONTEXT_USAGE_MAX_AGE_MS) {
      return o.usedPercent;
    }
  } catch { /* missing or unreadable */ }
  return null;
}

function writeContextUsagePercent(usedPercent) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${CONTEXT_USAGE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ usedPercent, ts: Date.now() }), 'utf8');
    fs.renameSync(tmp, CONTEXT_USAGE_FILE);
  } catch { /* statusline must never fail on this */ }
}

module.exports = {
  loadOrgTiers, orgMode, quietMutesOrg, quietMutesTier3, cap,
  distancePct, readContextUsagePercent, writeContextUsagePercent,
};
