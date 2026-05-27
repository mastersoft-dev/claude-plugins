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
//   write-findings                — stdin JSON → verify-findings/<slug>.json
//   state-path                    — print canonical state file path
//   findings-path [slug]          — print canonical verify findings path
//   memory-path                   — print Claude Code auto-memory dir for current repo
//   repo-root                     — print canonicalized repo root for current cwd
//   slug                          — print plugin-internal repo slug (underscore-encoded)
//   claude-project-slug           — print Claude Code's per-project slug (dash-encoded)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadState, saveState } = require('../hooks/lib');

const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.tmpdir(), 'mastersoft-state');
const STATE_FILE = path.join(STATE_DIR, 'lint-engine-state.json');
const FINDINGS_DIR = path.join(STATE_DIR, 'verify-findings');
const MAX_SESSIONS = 50;

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function resolveRepoRoot(cwd) {
  let p = process.env.CLAUDE_PROJECT_DIR
    || git(['rev-parse', '--show-toplevel'], cwd)
    || cwd;
  try { p = fs.realpathSync(p); } catch {}
  return p;
}

function repoSlug(repoRoot) {
  // Encode the full canonical path so two checkouts with the same basename
  // (e.g. ~/work/app vs ~/tmp/app) get distinct slugs — otherwise
  // verify-findings/<slug>.json would collide and refresh-rules could
  // consume findings from the wrong repo.
  return repoRoot.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '');
}

function claudeProjectSlug(repoRoot) {
  // Encode matching Claude Code's own per-project dir convention under
  // ~/.claude/projects/<slug>/. Empirically: every `/`, `\`, `.` AND `_`
  // becomes `-`, leading `-` is kept. Examples:
  //   /Users/alex/.claude        →  -Users-alex--claude
  //   /Users/alex/dev/app        →  -Users-alex-dev-app
  //   /Users/alex/dev/foo_bar    →  -Users-alex-dev-foo-bar
  //   C:\Users\alex\dev\app      →  C--Users-alex-dev-app
  // The `_` mapping is required: a path like `.../master_soft/...` lands in
  // `.../master-soft/...` on disk, so omitting it makes the lookup miss.
  // Backslash inclusion is required for Windows native paths returned by
  // fs.realpathSync — without it, the slug would have no separators and
  // the ~/.claude/projects/<slug>/ lookup would silently miss.
  // Required for any caller that wants to read Claude Code's auto-memory
  // or transcript dirs — those live under the dash-encoded slug, not the
  // underscore-encoded repoSlug used for the plugin's own state files.
  //
  // Intentionally duplicated in hooks/lint-engine.js (same 1-line function).
  // Keep both copies in sync — see the note over there.
  return repoRoot.replace(/[/._\\]/g, '-');
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
    const parsed = JSON.parse(body);
    parsed.generatedAt = parsed.generatedAt || Date.now();
    parsed.repoRoot = parsed.repoRoot || repoRoot;
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  } catch (e) {
    process.stderr.write(`Invalid JSON on stdin: ${e.message}\n`);
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
    // Use Claude Code's own dash-encoding so the returned path actually
    // matches the dir where auto-memory is written. Earlier this used
    // repoSlug (underscore + stripped leading), which never matched
    // Claude Code's layout — callers got a phantom path.
    const slug = claudeProjectSlug(resolveRepoRoot(process.cwd()));
    process.stdout.write(path.join(os.homedir(), '.claude', 'projects', slug, 'memory') + '\n');
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
  case 'claude-project-slug':
    process.stdout.write(claudeProjectSlug(resolveRepoRoot(process.cwd())) + '\n');
    break;
  default:
    process.stderr.write(
      'Usage: state.js {record-refresh|record-verify|record-audit|record-promotion-check|ack-lints {defer|suppress|clear} [categories...]|write-findings|state-path|findings-path [slug]|memory-path|repo-root|slug|claude-project-slug}\n',
    );
    process.exit(2);
}
