#!/usr/bin/env node
'use strict';

// Cross-platform helper for Mastersoft plugin state mutations. Skills call
// `node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js <subcmd>` instead of shelling
// out to POSIX-only commands like `touch`, `rm -f`, `mkdir -p`. All file
// operations go through Node's fs API so it works on macOS, Linux, Windows,
// and WSL identically.
//
// Subcommands:
//   record-refresh                — write last_refresh_at for current repo
//   record-verify                 — write last_verify_at for current repo
//   record-audit                  — write last_audit_at for current repo
//   record-promotion-check        — write last_promotion_check_at for current repo
//   ack-lints {defer|suppress|clear} — manage repo-local sentinel files
//   write-findings                — stdin finding blocks (or JSON) → verify-findings/<slug>.json
//   state-path                    — print canonical state file path
//   findings-path [slug]          — print canonical verify findings path
//   memory-path                   — print Claude Code auto-memory dir for current repo (nothing when it's off)
//   agents-md-mode                — print the Project instructions mode Claude Code applies to AGENTS.md
//   rule-files                    — print the project rule files Claude Code loads at launch, one per line
//   repo-root                     — print canonicalized repo root for current cwd
//   slug                          — print plugin-internal repo slug (underscore-encoded)
//   claude-project-slug           — print Claude Code's per-project dir name (dash-encoded, hashed past 200 chars)

const fs = require('fs');
const path = require('path');
const { loadState, saveState, resolveStateDir, resolveRepoRoot, projectDataDir, projectRuleFiles, agentsMdSetting, autoMemoryDir } = require('../hooks/lib');

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, 'lint-engine-state.json');
const FINDINGS_DIR = path.join(STATE_DIR, 'verify-findings');
const MAX_SESSIONS = 50;

function repoSlug(repoRoot) {
  // Encode the full canonical path so two checkouts with the same basename
  // (e.g. ~/work/app vs ~/tmp/app) get distinct slugs — otherwise
  // verify-findings/<slug>.json would collide and refresh-rules could
  // consume findings from the wrong repo.
  return repoRoot.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '');
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function recordTimestamp(field) {
  ensureDir(STATE_DIR);
  const repoRoot = resolveRepoRoot(process.cwd());
  const state = loadState(STATE_FILE);
  state.__repos = state.__repos || {};
  state.__repos[repoRoot] = state.__repos[repoRoot] || {};
  state.__repos[repoRoot][field] = Date.now();
  saveState(STATE_FILE, state, MAX_SESSIONS);
  process.stdout.write(`[mastersoft-state] ${field} recorded for ${repoRoot}\n`);
}

function ensureGitignored(repoRoot) {
  const gi = path.join(repoRoot, '.gitignore');
  const patterns = [
    '.claude/.mastersoft-lints-ack',
    '.claude/.mastersoft-lints-suppress',
  ];
  let content = '';
  try { content = fs.readFileSync(gi, 'utf8'); } catch {}
  const lines = new Set(content.split('\n').map(l => l.trim()));
  const missing = patterns.filter(p => !lines.has(p));
  if (!missing.length) return;
  const sep = content && !content.endsWith('\n') ? '\n' : '';
  try {
    fs.writeFileSync(gi, content + sep + missing.join('\n') + '\n');
  } catch {}
}

function ackLints(action, categories) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const claudeDir = path.join(repoRoot, '.claude');
  ensureDir(claudeDir);
  const ackFile = path.join(claudeDir, '.mastersoft-lints-ack');
  const suppressFile = path.join(claudeDir, '.mastersoft-lints-suppress');
  switch (action) {
    case 'defer': {
      // Optional category list scopes the defer. `defer rules` silences only
      // the rule-file signals; `defer` (no args) writes an empty file =
      // all categories (back-compat with legacy touched files + no-arg defer).
      // lint-engine reads this file's content as a CSV of acked categories.
      const body = (categories || []).join(',');
      try { fs.writeFileSync(ackFile, body); } catch {}
      ensureGitignored(repoRoot);
      const scope = body ? `categories [${body}]` : 'all categories';
      process.stdout.write(`Deferred ${scope}. ${ackFile} written. Silent for the session window.\n`);
      break;
    }
    case 'suppress':
      try {
        fs.writeFileSync(
          suppressFile,
          `Created ${new Date().toISOString()} via /mastersoft:ack-lints suppress.\nDelete this file to re-enable Mastersoft lint signals.\n`,
        );
      } catch (e) {
        process.stderr.write(`Failed to write ${suppressFile}: ${e.message}\n`);
        process.exit(1);
      }
      ensureGitignored(repoRoot);
      process.stdout.write(`Suppressed. ${suppressFile} written. Delete it to re-enable signals.\n`);
      break;
    case 'clear':
      try { fs.rmSync(ackFile, { force: true }); } catch {}
      try { fs.rmSync(suppressFile, { force: true }); } catch {}
      process.stdout.write(`Cleared. Removed any ack/suppress sentinel files.\n`);
      break;
    default:
      process.stderr.write(`Usage: state.js ack-lints {defer|suppress|clear}\n`);
      process.exit(2);
  }
}

const FINDING_HEAD_RE = /^##\s+Finding\s+\d+\s*[—–-]\s*(.+?)\s*$/;
const FINDING_FIELD_RE = /^\*\*(Severity|Class|Signal|Evidence|Suggestion|Files)\*\*:\s*(.*?)\s*$/;
const NO_FINDINGS_RE = /^\s*No issues detected\.?\s*$/m;
const EMPTY_MARK_RE = /^[—–-]?$/;
const SEVERITIES = ['low', 'medium', 'high'];
const FINDING_FORMAT_HINT = 'write each finding as "## Finding N — <summary>" followed by **Severity**: low|medium|high, **Class**, **Signal**, **Evidence**, **Suggestion** and **Files** lines, with the labels in English';

/**
 * Parse the rule-auditor's human-readable finding blocks into the persisted
 * findings shape. Blocks carry no JSON, so the heredoc that feeds them passes
 * Claude Code's permission check, which refuses a `{` followed by a quote.
 */
function parseFindingBlocks(text) {
  const findings = [];
  let current = null;
  for (const line of text.split('\n')) {
    const head = line.match(FINDING_HEAD_RE);
    if (head) {
      current = { summary: head[1] };
      findings.push(current);
      continue;
    }
    const field = current && line.match(FINDING_FIELD_RE);
    if (field) current[field[1].toLowerCase()] = field[2];
  }
  const incomplete = findings.find(f => !SEVERITIES.includes((f.severity || '').toLowerCase()) || !f.evidence);
  if (incomplete) throw new Error(`finding "${incomplete.summary}" has no valid **Severity** or **Evidence** line: ${FINDING_FORMAT_HINT}`);
  return findings.map(f => ({
    summary: f.summary,
    severity: (f.severity || '').toLowerCase(),
    class: f.class || '',
    signal: EMPTY_MARK_RE.test(f.signal || '') ? null : f.signal,
    evidence: f.evidence || '',
    suggestion: f.suggestion || '',
    files: (f.files || '').split(',').map(s => s.trim().replace(/^`|`$/g, '')).filter(s => !EMPTY_MARK_RE.test(s)),
  }));
}

function parseFindingsInput(body) {
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const findings = parseFindingBlocks(body);
  if (!findings.length && !NO_FINDINGS_RE.test(body)) {
    throw new Error(`no finding blocks, "No issues detected." or JSON object found: ${FINDING_FORMAT_HINT}`);
  }
  return { findings };
}

function writeFindings() {
  ensureDir(FINDINGS_DIR);
  const repoRoot = resolveRepoRoot(process.cwd());
  const slug = repoSlug(repoRoot);
  const file = path.join(FINDINGS_DIR, `${slug}.json`);
  let body;
  try { body = fs.readFileSync(0, 'utf8'); }
  catch (e) {
    process.stderr.write(`Failed to read stdin: ${e.message}\n`);
    process.exit(1);
  }
  try {
    const parsed = parseFindingsInput(body);
    parsed.generatedAt = parsed.generatedAt || Date.now();
    parsed.repoRoot = parsed.repoRoot || repoRoot;
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  } catch (e) {
    process.stderr.write(`Invalid findings on stdin: ${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`Wrote findings to ${file}\n`);
}

const [,, cmd, ...rest] = process.argv;
switch (cmd) {
  case 'record-refresh': recordTimestamp('last_refresh_at'); break;
  case 'record-verify': recordTimestamp('last_verify_at'); break;
  case 'record-audit': recordTimestamp('last_audit_at'); break;
  case 'ack-lints': ackLints(rest[0], rest.slice(1)); break;
  case 'write-findings': writeFindings(); break;
  case 'state-path':
    process.stdout.write(STATE_FILE + '\n');
    break;
  case 'findings-path': {
    const slug = rest[0] || repoSlug(resolveRepoRoot(process.cwd()));
    process.stdout.write(path.join(FINDINGS_DIR, slug + '.json') + '\n');
    break;
  }
  case 'memory-path': {
    const memDir = autoMemoryDir(process.cwd());
    if (memDir) process.stdout.write(memDir + '\n');
    else process.stderr.write('No auto-memory dir for this repo: auto memory is off (autoMemoryEnabled or CLAUDE_CODE_DISABLE_AUTO_MEMORY), or its project dir name is past 200 characters and not unique on disk.\n');
    break;
  }
  case 'agents-md-mode': {
    const setting = agentsMdSetting(process.cwd());
    process.stdout.write(setting.mode + (setting.pluginDisabled ? ' (agents-md plugin disabled)' : '') + '\n');
    break;
  }
  case 'rule-files': {
    const cwd = process.cwd();
    const rules = projectRuleFiles(resolveRepoRoot(cwd), agentsMdSetting(cwd));
    for (const file of rules.files) process.stdout.write(file + '\n');
    break;
  }
  case 'record-promotion-check':
    recordTimestamp('last_promotion_check_at');
    break;
  case 'repo-root':
    process.stdout.write(resolveRepoRoot(process.cwd()) + '\n');
    break;
  case 'slug':
    process.stdout.write(repoSlug(resolveRepoRoot(process.cwd())) + '\n');
    break;
  case 'claude-project-slug': {
    const dataDir = projectDataDir(resolveRepoRoot(process.cwd()));
    if (!dataDir) {
      process.stderr.write('The project dir name is past 200 characters and no unique match exists under projects/.\n');
      process.exit(1);
    }
    process.stdout.write(path.basename(dataDir) + '\n');
    break;
  }
  default:
    process.stderr.write(
      'Usage: state.js {record-refresh|record-verify|record-audit|record-promotion-check|ack-lints {defer|suppress|clear} [categories...]|write-findings|state-path|findings-path [slug]|memory-path|agents-md-mode|rule-files|repo-root|slug|claude-project-slug}\n',
    );
    process.exit(2);
}
