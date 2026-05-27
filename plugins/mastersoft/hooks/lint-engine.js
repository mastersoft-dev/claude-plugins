'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { readStdinJson, loadState, saveState } = require('./lib');

const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.tmpdir(), 'mastersoft-state');
const STATE_FILE = path.join(STATE_DIR, 'lint-engine-state.json');
const MAX_SESSIONS = 50;
// Claude Code caps a hook's additionalContext at 10000 chars; past that it
// dumps the text to a file and replaces it with a preview+path. Keep the
// assembled signal output under the cap and hard-trim as a final guard
// (see OUTPUT_CHAR_CAP below).
const OUTPUT_CHAR_CAP = 9500;
const SIGNAL_BUDGET_CHARS = 800;
// Skip the expensive git/doc scan when nothing relevant changed. Findings are
// cached per-repo keyed by a cheap signature (HEAD sha + input mtimes); this
// max-age forces an occasional refresh so time-based thresholds still advance.
const LINT_SCAN_MAX_AGE_MS = Number(process.env.MASTERSOFT_LINT_SCAN_MAX_AGE_MS) || 3600000;

// ORG_RULES.md (sibling of hooks/) carries a YAML-ish frontmatter with all
// tunable lint defaults (precedence per key: env var > frontmatter > built-in
// default). The prose tiers below the frontmatter are injected by the separate
// tier hooks (inject-session.js / inject-turn.js / inject-org-rules.js), not here.
const ORG_RULES_PATH = path.join(__dirname, '..', 'ORG_RULES.md');

function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { config: {}, body: text };
  const config = {};
  for (const raw of m[1].split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const kv = line.match(/^([\w_]+)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const k = kv[1];
    let v = kv[2];
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, '');
    config[k] = v;
  }
  return { config, body: m[2].trim() };
}

function loadOrgRules() {
  try {
    const text = fs.readFileSync(ORG_RULES_PATH, 'utf8');
    return parseFrontmatter(text);
  } catch {
    return { config: {}, body: null };
  }
}

const ORG = loadOrgRules();

function cfg(envVar, frontmatterKey, builtinDefault, parser) {
  parser = parser || (v => v);
  const e = process.env[envVar];
  if (e !== undefined && e !== '') return parser(e);
  if (ORG.config[frontmatterKey] !== undefined) return ORG.config[frontmatterKey];
  return builtinDefault;
}

const CLAUDE_MAX_LINES = cfg('MASTERSOFT_CLAUDE_MAX_LINES', 'claude_max_lines', 200, Number);
const REFRESH_INTERVAL_DAYS = cfg('MASTERSOFT_REFRESH_INTERVAL_DAYS', 'refresh_interval_days', 60, Number);
const VERIFY_MIN_AGE_DAYS = cfg('MASTERSOFT_VERIFY_MIN_AGE_DAYS', 'verify_min_age_days', 7, Number);
const VERIFY_MODE = cfg('MASTERSOFT_VERIFY_MODE', 'verify_mode', 'suggest');
const AUDIT_INTERVAL_DAYS = cfg('MASTERSOFT_AUDIT_INTERVAL_DAYS', 'audit_interval_days', 14, Number);
const AUDIT_ENABLED = cfg('MASTERSOFT_AUDIT_ENABLED', 'audit_enabled', true, v => v !== '0' && v !== 'false');
const LINTS_ACK_HOURS = cfg('MASTERSOFT_LINTS_ACK_HOURS', 'lints_ack_hours', 4, Number);
const PATTERNS_PROMOTE_THRESHOLD = cfg('MASTERSOFT_PATTERNS_PROMOTE_THRESHOLD', 'patterns_promote_threshold', 3, Number);
const MEMORY_REVIEW_DAYS = cfg('MASTERSOFT_MEMORY_REVIEW_DAYS', 'memory_review_days', 30, Number);

// Rule-file staleness (CLAUDE.md, AGENTS.md, and @-imported rule files).
// Generous thresholds — rule files are stable by design and drift slowly.
const RULE_STALE_COMMITS = cfg('MASTERSOFT_RULE_STALE_COMMITS', 'rule_stale_commits', 40, Number);
const RULE_STALE_DAYS = cfg('MASTERSOFT_RULE_STALE_DAYS', 'rule_stale_days', 120, Number);

// Frontmatter typo guard. Every key consumed by a cfg(...) call above must
// appear here; anything in ORG_RULES.md frontmatter that's NOT in this set
// is reported once per session via systemMessage. Without this, a typo like
// `claude_max_line` (singular) silently falls back to the builtin default
// and the admin sees no signal.
const KNOWN_FRONTMATTER_KEYS = new Set([
  'claude_max_lines',
  'refresh_interval_days',
  'verify_min_age_days',
  'verify_mode',
  'audit_interval_days',
  'audit_enabled',
  'lints_ack_hours',
  'patterns_promote_threshold',
  'memory_review_days',
  'rule_stale_commits',
  'rule_stale_days',
]);

const UNKNOWN_FRONTMATTER_KEYS = Object.keys(ORG.config)
  .filter(k => !KNOWN_FRONTMATTER_KEYS.has(k));

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

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
  // Normalize through realpath so per-repo state lookups are consistent
  // across symlinks. On macOS /var and /private/var both resolve to the
  // same canonical path; without this, refresh recorded under one form
  // wouldn't match the other on next session.
  try { p = fs.realpathSync(p); } catch {}
  return p;
}

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Security audit lint: detect dependency lockfile per language; flag if it's
// been touched since the last recorded audit OR if cadence elapsed.
// Order matters: more-specific entries (poetry.lock, uv.lock) before generic
// fallbacks (requirements.txt, pyproject.toml) so the best probe wins.
const LOCKFILES = [
  { file: 'package-lock.json', stack: 'npm' },
  { file: 'pnpm-lock.yaml', stack: 'pnpm' },
  { file: 'yarn.lock', stack: 'yarn' },
  { file: 'bun.lock', stack: 'bun' },
  { file: 'bun.lockb', stack: 'bun' },
  { file: 'uv.lock', stack: 'uv' },
  { file: 'poetry.lock', stack: 'poetry' },
  { file: 'Pipfile.lock', stack: 'pipenv' },
  { file: 'requirements.txt', stack: 'pip' },
  { file: 'pyproject.toml', stack: 'pip' },
  { file: 'Cargo.lock', stack: 'cargo' },
  { file: 'Gemfile.lock', stack: 'bundler' },
  { file: 'go.sum', stack: 'go' },
  { file: 'composer.lock', stack: 'composer' },
  { file: 'mix.lock', stack: 'mix' },
  { file: 'pubspec.lock', stack: 'dart' },
  { file: 'gradle/libs.versions.toml', stack: 'gradle' },
  { file: 'build.gradle.kts', stack: 'gradle' },
  { file: 'build.gradle', stack: 'gradle' },
  { file: 'Package.resolved', stack: 'swift' },
  { file: 'pdm.lock', stack: 'pdm' },
  { file: 'conda-lock.yml', stack: 'conda' },
  { file: 'environment.yml', stack: 'conda' },
];

// Search root first, then immediate subdirs (depth 1), then their children
// (depth 2) — covers monorepos and backend/frontend splits without a full-tree
// walk. Returns the first match; root wins over nested.
function findLockfile(repoRoot) {
  const dirsToSearch = [repoRoot];
  try {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = path.join(repoRoot, entry.name);
      dirsToSearch.push(sub);
      try {
        for (const sub2 of fs.readdirSync(sub, { withFileTypes: true })) {
          if (!sub2.isDirectory() || sub2.name.startsWith('.') || sub2.name === 'node_modules') continue;
          dirsToSearch.push(path.join(sub, sub2.name));
        }
      } catch {}
    }
  } catch {}
  for (const dir of dirsToSearch) {
    for (const lk of LOCKFILES) {
      const p = path.join(dir, lk.file);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return { ...lk, path: p, mtime: st.mtimeMs };
      } catch {}
    }
  }
  return null;
}

// Claude Code stores per-repo auto-memory at ~/.claude/projects/<slug>/memory/
// where <slug> is the repo's canonical path with `/`, `\`, `.` AND `_`
// replaced by `-`. The `_` mapping matters: `.../master_soft/...` lands in
// `.../master-soft/...` on disk, so omitting it makes the dir lookup miss.
// Backslash is included for Windows native paths returned by
// fs.realpathSync — without it, `C:\Users\…` would yield a slug missing all
// separators and the resulting dir lookup would silently fail.
// Every memory entry there is a promotion candidate except the MEMORY.md index
// and `reference` entries (already explicit pointers, not patterns to codify).
// Naming has two coexisting conventions on disk: legacy filename prefixes
// (`feedback_`/`project_`/`user_`/`reference_`) and the current slug-style
// (`<slug>.md` carrying `type:` in frontmatter, either top-level or nested
// under `metadata:`). We therefore exclude a `reference` by EITHER cue and
// count everything else — keying off the filename prefix alone would miss the
// slug-style entries the current convention writes.
//
// claudeProjectSlug is intentionally duplicated from scripts/state.js (same
// 1-line function). Hooks run synchronously per-prompt; importing from scripts/
// would add a require path resolution that's not worth the few bytes saved.
// Keep both copies in sync — if one changes, change the other.
function claudeProjectSlug(repoRoot) {
  return repoRoot.replace(/[/._\\]/g, '-');
}

function isReferenceMemory(memDir, entry) {
  if (entry.startsWith('reference_')) return true;
  try {
    return /^\s*type:\s*reference\s*$/m.test(fs.readFileSync(path.join(memDir, entry), 'utf8').slice(0, 600));
  } catch { return false; }
}

function countAutoMemoryPatterns(repoRoot) {
  const slug = claudeProjectSlug(repoRoot);
  const memDir = path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
  let entries;
  try { entries = fs.readdirSync(memDir); } catch { return { count: 0, dir: memDir }; }
  const candidates = entries.filter(e =>
    e.endsWith('.md')
    && e !== 'MEMORY.md'
    && !isReferenceMemory(memDir, e)
  );
  return { count: candidates.length, dir: memDir };
}

// Generic per-file git staleness used for rule files (CLAUDE.md, AGENTS.md,
// @-imported rule files). Fixed thresholds (not adaptive) — rule files are
// stable by design, so a simple "untouched for N commits / M days while the
// repo moved" check is enough and avoids false adaptive tightening.
function fileStaleness(repoRoot, filePath, commitThreshold, dayThreshold) {
  const sha = git(['log', '-1', '--format=%H', '--', filePath], repoRoot);
  if (!sha) return { stale: false };
  const ts = git(['log', '-1', '--format=%ct', '--', filePath], repoRoot);
  const days = ts ? (Date.now() / 1000 - Number(ts)) / 86400 : null;
  const commitsOut = git(['rev-list', '--count', 'HEAD', `^${sha}`], repoRoot);
  const commits = commitsOut !== null ? Number(commitsOut) : null;
  const reasons = [];
  if (commits !== null && commits > commitThreshold) reasons.push(`${commits} commits since touch (threshold ${commitThreshold})`);
  if (days !== null && days > dayThreshold) reasons.push(`${Math.floor(days)}d (threshold ${dayThreshold})`);
  return { stale: reasons.length > 0, reason: reasons.join(', ') };
}

const PATH_REF_RE = /`([./][\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|yaml|yml|sh|go|rs|rb|toml|java|kt|swift|m|cs))`/g;

function findStaleRefs(repoRoot, ruleFiles) {
  const findings = [];
  for (const { path: filePath, content } of ruleFiles) {
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      let m;
      PATH_REF_RE.lastIndex = 0;
      while ((m = PATH_REF_RE.exec(line))) {
        const ref = m[1];
        const abs = path.resolve(repoRoot, ref);
        if (!fileExists(abs) && !dirExists(abs)) {
          findings.push({ file: filePath, line: idx + 1, ref });
        }
      }
    });
  }
  return findings;
}

// Recursively resolve `@path.md` imports starting at filePath. Per docs:
// "CLAUDE.md files can now import other files. Add @path/to/file.md to
// ./CLAUDE.md to load additional files on launch."
// Returns [{ path, content }, ...] including the root file. Visited set
// prevents cycles. Imports are interpreted relative to the importing file.
const IMPORT_RE = /(?:^|[\s(])@([./\w-]+\.md)\b/g;
function resolveImports(repoRoot, filePath, visited) {
  visited = visited || new Set();
  const abs = path.resolve(filePath);
  if (visited.has(abs)) return [];
  visited.add(abs);
  const content = readFileSafe(abs);
  const out = [{ path: abs, content }];
  if (!content) return out;
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(content))) {
    const ref = m[1];
    const importedAbs = path.resolve(path.dirname(abs), ref);
    // Only follow imports that live under the repo root (security: avoid
    // walking to /etc/passwd if a rule file contains a `@/etc/passwd.md` joke).
    if (!importedAbs.startsWith(path.resolve(repoRoot) + path.sep)
        && importedAbs !== path.resolve(repoRoot)) {
      continue;
    }
    out.push(...resolveImports(repoRoot, importedAbs, visited));
  }
  return out;
}

// Recursively list `.md` rule files under .claude/rules/. Per memory.md:
// "All `.md` files are discovered recursively, so you can organize rules
// into subdirectories like `frontend/` or `backend/`". Lint must match
// the harness's discovery rule, otherwise nested files with stale refs
// or oversize content are silently skipped.
function listRuleFiles(rulesDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  }
  walk(rulesDir);
  return out;
}

function main() {
  ensureStateDir();
  const input = readStdinJson();
  if (!input) process.exit(0);

  // Global mute switch. `MASTERSOFT_QUIET=1|all|true` silences this hook
  // entirely (no signals). `=lints` also suppresses lint signals (the org-rule
  // tier hooks honor it separately). Intended for CI agents and one-off shells where
  // any nudge is noise. Per-repo .mastersoft-lints-suppress is the persistent
  // equivalent.
  const QUIET = process.env.MASTERSOFT_QUIET;
  if (QUIET === '1' || QUIET === 'all' || QUIET === 'true') process.exit(0);
  const quietLintsOnly = QUIET === 'lints';

  const sessionId = input.session_id || '';
  const cwd = input.cwd || '.';
  const repoRoot = resolveRepoRoot(cwd);

  // Skip the user's home ~/.claude/ dir — global rules live there with different
  // loading semantics (always loaded across projects) and our skills target repos.
  const claudeHome = path.resolve(path.join(os.homedir(), '.claude'));
  const resolvedRoot = path.resolve(repoRoot);
  if (resolvedRoot === claudeHome || resolvedRoot.startsWith(claudeHome + path.sep)) {
    process.exit(0);
  }

  const isGitRepo = git(['rev-parse', '--is-inside-work-tree'], repoRoot) === 'true';
  const briefPath = path.join(repoRoot, 'BRIEF.md');
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  const rulesDir = path.join(repoRoot, '.claude', 'rules');

  // BRIEF.md is deprecated — no longer read, injected, or staleness-linted.
  // We only detect its presence to nudge migration (notice below).
  const briefPresent = fileExists(briefPath);
  const claudeContent = readFileSafe(claudePath);

  const state = loadState(STATE_FILE);
  const sessionState = state[sessionId] || {};
  const nowMs = Date.now();
  if (!sessionState.sessionStartMs) sessionState.sessionStartMs = nowMs;

  // Per-directory + per-session lint suppression, CATEGORY-SCOPED.
  // - .claude/.mastersoft-lints-suppress (any mtime): suppress all categories
  //   indefinitely until deleted.
  // - .claude/.mastersoft-lints-ack (within LINTS_ACK_HOURS): suppress for the
  //   session window. File CONTENT is a CSV of acked categories (e.g. "rules"
  //   or "rules,patterns"). EMPTY content = all categories (backward-compat
  //   with legacy touched files and the no-arg `defer`, which defers
  //   everything currently shown).
  //
  // Why categories: running /mastersoft:refresh-rules used to blanket-defer
  // ALL signals, which silenced orthogonal ones like security-audit-due that
  // refresh never addressed. Handling one concern must not mute another.
  const suppressFile = path.join(repoRoot, '.claude', '.mastersoft-lints-suppress');
  const ackFile = path.join(repoRoot, '.claude', '.mastersoft-lints-ack');
  let suppressAll = false;
  let ackAll = false;
  const ackedCategories = new Set();
  if (fileExists(suppressFile)) {
    suppressAll = true;
  } else if (fileExists(ackFile)) {
    try {
      const ageH = (nowMs - fs.statSync(ackFile).mtimeMs) / 3600000;
      if (ageH < LINTS_ACK_HOURS) {
        const content = (readFileSafe(ackFile) || '').trim();
        if (!content) ackAll = true;
        else content.split(',').map(s => s.trim()).filter(Boolean).forEach(c => ackedCategories.add(c));
      }
    } catch {}
  }
  function categorySuppressed(category) {
    if (suppressAll || ackAll) return true;
    return ackedCategories.has(category);
  }

  const signalCandidates = []; // { rendered, severity } — budget applied at output time
  let anyLintSignal = false;
  // Signals are emitted as a two-line bullet: a parseable `[SIGNAL …]` head
  // followed by a prose body indented two spaces. The head carries a stable
  // `id` (kebab-case) so the model can route on the signal class without
  // re-parsing prose every prompt. Severity is one of: info | warn | high.
  // `fix` is optional and typically a slash command. `category` (default
  // `rules`) scopes session-window ack so one concern's ack doesn't mute
  // another. Catalog of ids + categories lives in /mastersoft:help.
  // Budget (SIGNAL_BUDGET_CHARS) is applied at output assembly after sorting
  // by severity so high-severity signals are never dropped by earlier
  // low-priority ones filling the cap first.
  function addSignal({ id, severity, fix, body, category }) {
    category = category || 'rules';
    if (quietLintsOnly || categorySuppressed(category)) return;
    anyLintSignal = true;
    const fixPart = fix ? ` fix=${fix}` : '';
    const head = `[SIGNAL id=${id} severity=${severity}${fixPart}]`;
    const rendered = `${head}\n  ${body}`;
    signalCandidates.push({ rendered, severity: severity || 'info', id, fix });
  }

  // BRIEF.md deprecation is handled as a lint signal (emitted as a bootstrap
  // signal below, exempt from the first-prompt diet) so the model receives it
  // in additionalContext and can act on it. No per-session gate needed —
  // standard ack/suppress.

  // Resolve @import chains starting from CLAUDE.md. Per Claude Code memory
  // docs, `@path/to/file.md` references in CLAUDE.md load additional files on
  // session start (e.g. CLAUDE.md as a 1-line pointer to AGENTS.md). fs-only,
  // cheap — needed both for the change-signature and the scan below.
  const importedRuleFiles = claudeContent
    ? resolveImports(repoRoot, claudePath)
    : [];

  // Per-repo timestamps + cache. State shape: state.__repos[<repoRoot>] = {
  //   last_refresh_at, last_verify_at, last_audit_at, last_promotion_check_at,
  //   lintScan } (millis + scan cache). Scoping by full repo path avoids
  //   cross-repo pollution.
  const repoTs = (state.__repos && state.__repos[repoRoot]) || {};
  const lastRefreshAt = repoTs.last_refresh_at || 0;
  const lastVerifyAt = repoTs.last_verify_at || 0;
  const lastAuditAt = repoTs.last_audit_at || 0;
  const lastPromotionCheckAt = repoTs.last_promotion_check_at || 0;

  // First-prompt diet: this session's prompt index. Lint signals are held back
  // until prompt #2 so the first turn isn't buried under hygiene output (it
  // already carries the SessionStart org injection + the tier-3 nudge).
  // Skipping the scan on prompt #1 also keeps the git/doc cost off the most
  // latency-sensitive turn.
  const promptIndex = (sessionState.count || 0) + 1;
  const emitSignals = promptIndex > 1;

  function mtimeOf(p) {
    try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return 0; }
  }

  // Git/doc lint scan. Spawns several git subprocesses and may read doc files,
  // so it does NOT run per-prompt: findings are cached per-repo keyed by a
  // cheap change-signature (HEAD sha + input mtimes) and reused while the
  // signature is unchanged and the cache is younger than LINT_SCAN_MAX_AGE_MS.
  // Returns raw finding objects; suppression + budget are applied fresh by
  // addSignal on every prompt, so defer/suppress still take effect on a cache
  // hit. Session-scoped (mid-session edit) and timestamp-reactive signals
  // (patterns/refresh/audit/verify) are computed outside the cache so they
  // react immediately to skill runs.
  function scanRepo() {
    const findings = [];

    // Size + staleness across the @-import chain (mid-session edit handled
    // per-prompt in main, since it depends on this session's start time).
    const staleRuleFiles = [];
    for (const rf of importedRuleFiles) {
      if (!rf.content) continue;
      const rel = path.relative(repoRoot, rf.path) || path.basename(rf.path);
      const lines = rf.content.split('\n').length;
      const rfStale = fileStaleness(repoRoot, rf.path, RULE_STALE_COMMITS, RULE_STALE_DAYS);
      if (rfStale.stale) staleRuleFiles.push(`${rel} (${rfStale.reason})`);
      if (lines > CLAUDE_MAX_LINES) findings.push({ id: 'rule-file-oversize', severity: 'warn', fix: '/mastersoft:refresh-rules', category: 'rules', body: `${rel} is ${lines} lines (>${CLAUDE_MAX_LINES}). Split per-topic into .claude/rules/<topic>.md with \`paths:\` frontmatter.` });
      else if ((rel === 'CLAUDE.md' || rel === 'AGENTS.md') && lines > 100 && !dirExists(rulesDir)) findings.push({ id: 'claude-md-large', severity: 'info', fix: '/mastersoft:refresh-rules', category: 'rules', body: `${rel} is sizable; consider .claude/rules/ split.` });
    }
    if (staleRuleFiles.length) findings.push({ id: 'rule-file-stale', severity: 'info', fix: '/mastersoft:verify', category: 'rules', body: `Rule file(s) untouched while repo moved: ${staleRuleFiles.join('; ')}. Re-verify rules still match the codebase.` });

    // Stale path refs across all rule files (incl. @-imports + .claude/rules/).
    const ruleContents = importedRuleFiles
      .filter(rf => rf.content)
      .map(rf => ({ path: path.relative(repoRoot, rf.path) || path.basename(rf.path), content: rf.content }));
    for (const rf of listRuleFiles(rulesDir)) {
      const c = readFileSafe(rf);
      if (c) ruleContents.push({ path: path.relative(repoRoot, rf), content: c });
    }
    const staleRefs = findStaleRefs(repoRoot, ruleContents);
    if (staleRefs.length) {
      const first = staleRefs.slice(0, 3).map(r => `${r.file}:${r.line} \`${r.ref}\``).join('; ');
      const more = staleRefs.length > 3 ? ` (+${staleRefs.length - 3} more)` : '';
      findings.push({ id: 'stale-path-refs', severity: 'warn', fix: '/mastersoft:refresh-rules', category: 'rules', body: `Stale refs in rule files: ${first}${more}.` });
    }

    return findings;
  }

  // Bootstrap signal — EXEMPT from the first-prompt diet above. Claude Code
  // loads only CLAUDE.md, never AGENTS.md (memory docs: "Claude Code reads
  // CLAUDE.md, not AGENTS.md"), so when CLAUDE.md is absent no project rules
  // are in context — even if an AGENTS.md sits there. "Set up project rules"
  // is most actionable on prompt #1 of a fresh repo, so unlike the hygiene
  // signals this fires regardless of promptIndex. The recommended fix is a
  // CLAUDE.md whose body is `@AGENTS.md` (the import auto-injects it).
  if (!claudeContent) {
    const hasAgents = fileExists(path.join(repoRoot, 'AGENTS.md'));
    const body = hasAgents
      ? 'AGENTS.md present but Claude Code loads only CLAUDE.md — its rules are not in context. Add a CLAUDE.md whose body is `@AGENTS.md`.'
      : 'No project rules (CLAUDE.md) in this repo. Scaffold them so every session shares the same conventions.';
    addSignal({ id: 'no-rules-file', severity: 'info', fix: '/mastersoft:init-rules', category: 'rules', body });
  }

  // Bootstrap signal — EXEMPT from the first-prompt diet, same as no-rules-file
  // above. BRIEF.md deprecation is presence-based (cheap fileExists) and most
  // actionable on prompt #1 of a session; it also replaces a systemMessage
  // notice that fired on prompt #1, so gating it behind emitSignals regressed
  // that. Not timestamp-reactive — do not move it into emitSignals.
  if (briefPresent) {
    addSignal({ id: 'brief-deprecated', severity: 'info', fix: '/mastersoft:refresh-rules', category: 'migration', body: 'BRIEF.md is deprecated — no longer injected or linted. Migrate: stable conventions → CLAUDE.md, settled decisions → docs/adr/, drop ephemeral state. Then remove BRIEF.md.' });
  }

  if (emitSignals) {
    // Cheap change-signature: HEAD sha (1 git call, no enumeration) + mtimes of
    // every input the scan reads. Any relevant change flips the signature and
    // forces a fresh scan; otherwise the cached findings are replayed.
    const headSha = isGitRepo ? (git(['rev-parse', 'HEAD'], repoRoot) || '') : 'nogit';
    const lockProbe = findLockfile(repoRoot);
    const memDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(repoRoot), 'memory');
    const sig = [
      headSha,
      mtimeOf(claudePath),
      ...importedRuleFiles.map(rf => mtimeOf(rf.path)),
      mtimeOf(rulesDir),
      lockProbe ? Math.floor(lockProbe.mtime) : 0,
      mtimeOf(memDir),
    ].join(':');

    let scanFindings;
    const cached = repoTs.lintScan;
    if (cached && cached.sig === sig && (nowMs - (cached.ts || 0)) < LINT_SCAN_MAX_AGE_MS) {
      scanFindings = cached.findings || [];
    } else {
      scanFindings = scanRepo();
      state.__repos = state.__repos || {};
      state.__repos[repoRoot] = state.__repos[repoRoot] || {};
      state.__repos[repoRoot].lintScan = { sig, ts: nowMs, findings: scanFindings };
    }

    for (const f of scanFindings) addSignal(f);

    // Mid-session rule-file edit — per-prompt (cheap fs.stat), not cached.
    for (const rf of importedRuleFiles) {
      if (!rf.content) continue;
      try {
        const mtime = fs.statSync(rf.path).mtimeMs;
        if (mtime > sessionState.sessionStartMs && !sessionState.midSessionEditNoticed && !categorySuppressed('rules')) {
          const rel = path.relative(repoRoot, rf.path) || path.basename(rf.path);
          addSignal({ id: 'rule-edited-midsession', severity: 'info', category: 'rules', body: `Rule file edited mid-session (${rel}). Edits to root/imported rule files do not apply until /clear, /compact, or restart.` });
          sessionState.midSessionEditNoticed = true;
        }
      } catch {}
    }

    // Timestamp-reactive signals — cheap (readdir/stat/math), computed fresh so
    // they clear the moment the relevant skill records a new timestamp.
    const patterns = countAutoMemoryPatterns(repoRoot);
    let memDirMtime = 0;
    try { memDirMtime = fs.statSync(patterns.dir).mtimeMs; } catch {}
    let promoteSignaled = false;
    if (patterns.count >= PATTERNS_PROMOTE_THRESHOLD) {
      const memTouchedSinceCheck = lastPromotionCheckAt ? memDirMtime > lastPromotionCheckAt : true;
      if (memTouchedSinceCheck) {
        addSignal({ id: 'patterns-to-promote', severity: 'info', fix: '/mastersoft:promote-patterns', category: 'patterns', body: `${patterns.count} auto-memory pattern(s) in this repo not yet codified as rules. Triage to decide which belong in repo CLAUDE.md / .claude/rules vs user-global ~/.claude/CLAUDE.md.` });
        promoteSignaled = true;
      }
    }

    // Staleness nudge, complementary to the volume trigger above. Clock = time
    // since last triage; if never triaged, time since the memory dir was last
    // written (so a freshly-growing dir isn't flagged — the volume trigger owns
    // that). Suppressed when patterns-to-promote already fired this pass.
    if (!promoteSignaled && patterns.count > 0) {
      const sinceTriageMs = lastPromotionCheckAt ? nowMs - lastPromotionCheckAt : (memDirMtime ? nowMs - memDirMtime : 0);
      if (sinceTriageMs / 86400000 > MEMORY_REVIEW_DAYS) {
        addSignal({ id: 'memory-review-due', severity: 'info', fix: '/mastersoft:promote-patterns', category: 'patterns', body: `Auto-memory in this repo has ${patterns.count} uncodified pattern(s) and hasn't been triaged in over ${MEMORY_REVIEW_DAYS}d. Review whether any belong in repo CLAUDE.md / .claude/rules vs user-global ~/.claude/CLAUDE.md.` });
      }
    }

    if (claudeContent && (!lastRefreshAt || (nowMs - lastRefreshAt) / 86400000 > REFRESH_INTERVAL_DAYS)) {
      addSignal({ id: 'refresh-overdue', severity: 'info', fix: '/mastersoft:refresh-rules', category: 'rules', body: 'No recent /mastersoft:refresh-rules run recorded for this repo. Consider weekly `/schedule run /mastersoft:verify --report-only`.' });
    }

    if (AUDIT_ENABLED) {
      const lk = findLockfile(repoRoot);
      if (lk) {
        const daysSinceAudit = lastAuditAt ? (nowMs - lastAuditAt) / 86400000 : Infinity;
        const lockChanged = lk.mtime > lastAuditAt;
        if (lockChanged || daysSinceAudit > AUDIT_INTERVAL_DAYS) {
          const why = lockChanged && lastAuditAt
            ? `${lk.file} changed since last audit`
            : (lastAuditAt ? `${Math.floor(daysSinceAudit)}d since last audit` : 'no audit recorded');
          addSignal({ id: 'security-audit-due', severity: 'high', fix: '/mastersoft:audit-deps', category: 'audit', body: `Security audit due (${lk.stack}, ${why}).` });
        }
      }
    }

    // Verify-due gate (chain to Haiku) — must run after the others so it can
    // see whether any lint fired this prompt.
    const verifyAgeDays = lastVerifyAt ? (nowMs - lastVerifyAt) / 86400000 : Infinity;
    const inCI = process.env.CLAUDE_CODE_REMOTE === 'true';
    if (anyLintSignal && verifyAgeDays > VERIFY_MIN_AGE_DAYS && VERIFY_MODE !== 'off' && !inCI) {
      addSignal({ id: 'verify-due', severity: 'info', fix: '/mastersoft:verify', category: 'verify', body: 'Lints flagged issues and semantic verify is due.' });
    }
  }

  sessionState.count = promptIndex;

  // Org-rules prose is injected by the dedicated tier hooks (inject-session.js
  // at session boundaries, inject-turn.js per prompt), not here. lint-engine
  // owns only the lint signals + their notices. ORG.config (frontmatter) still
  // drives signal thresholds; ORG.body is unused.

  // Warn once per session if ORG_RULES.md frontmatter contains keys the runtime
  // doesn't recognise (e.g. a typo like `claude_max_line` that would silently
  // fall back to the builtin default).
  let unknownKeysMessage = null;
  if (UNKNOWN_FRONTMATTER_KEYS.length && !sessionState.orgRulesUnknownKeysWarned) {
    unknownKeysMessage = `[Mastersoft] Unknown keys in ORG_RULES.md frontmatter: ${UNKNOWN_FRONTMATTER_KEYS.join(', ')}. Ignored — values fell back to builtin defaults. Check spelling against the known list in /mastersoft:help.`;
    sessionState.orgRulesUnknownKeysWarned = true;
  }

  // Apply severity-ordered budget: sort high→warn→info (JS sort is stable so
  // insertion order is preserved within each tier), then greedily fill up to
  // SIGNAL_BUDGET_CHARS. Ensures high-severity signals (e.g. security-audit-due)
  // can't be silently dropped because earlier low-priority info signals
  // exhausted the cap first.
  const SEVERITY_RANK = { high: 0, warn: 1, info: 2 };
  const chosen = [];
  let signalSize = 0;
  for (const c of [...signalCandidates].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
  )) {
    if (signalSize + c.rendered.length + 1 <= SIGNAL_BUDGET_CHARS) {
      chosen.push(c);
      signalSize += c.rendered.length + 1;
    }
  }
  const signals = chosen.map(c => c.rendered);

  // User-visible notification: enumerate the active signals + each one's fix
  // command, so the toast carries the actual lint content instead of a generic
  // pointer. Surfaced once per session for info/warn (anti-fatigue), but
  // re-surfaced while a high-severity signal is unaddressed — ack/suppress
  // drops the signal from `chosen`, which clears hasHigh and ends the
  // re-surface. No auto-dialog: AskUserQuestion is reserved for user-started
  // flows (/mastersoft:ack-lints, /mastersoft:refresh-rules).
  const hasHigh = chosen.some(c => c.severity === 'high');
  let systemMessage = null;
  if (signals.length && (!sessionState.lintsNoticeShown || hasHigh)) {
    if (!claudeContent) {
      // A repo with no CLAUDE.md needs init-rules (scaffold), not the per-signal
      // routing below (there is nothing yet to refresh).
      systemMessage = '[Mastersoft] No CLAUDE.md in this repo — run /mastersoft:init-rules to scaffold project rules, or /mastersoft:ack-lints to silence.';
    } else {
      const lines = chosen.map(c =>
        `  • ${c.id}${c.severity ? ` (${c.severity})` : ''}${c.fix ? ` → ${c.fix}` : ''}`);
      systemMessage = [
        `[Mastersoft] ${signals.length} lint signal(s) in this repo:`,
        ...lines,
        '  /mastersoft:ack-lints to defer/suppress.',
      ].join('\n');
    }
    sessionState.lintsNoticeShown = true;
  }
  if (unknownKeysMessage) {
    systemMessage = systemMessage ? `${unknownKeysMessage}\n${systemMessage}` : unknownKeysMessage;
  }

  // Persist state (after all sessionState mutations).
  if (sessionId) {
    state[sessionId] = sessionState;
    saveState(STATE_FILE, state, MAX_SESSIONS);
  }

  // Assemble output.
  const parts = [];
  if (signals.length) parts.push(['## Mastersoft signals', ...signals.map(s => `- ${s}`)].join('\n'));
  if (parts.length === 0 && !systemMessage) process.exit(0);

  const out = {};
  if (parts.length) {
    let additionalContext = parts.join('\n\n');
    // Final guard against the 10000-char additionalContext cap (past it, Claude
    // Code dumps the text to a file and replaces it with a preview+path).
    if (additionalContext.length > OUTPUT_CHAR_CAP) {
      additionalContext = additionalContext.slice(0, OUTPUT_CHAR_CAP);
    }
    out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext };
  }

  if (systemMessage) {
    out.systemMessage = systemMessage;
    out.terminalSequence = String.fromCharCode(7);
  }

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// The lint engine is advisory and runs on every prompt. A throw here (a huge
// rule file, unexpected git output) must not block or nag: log to stderr for
// `claude --debug`, then exit 0 so the prompt proceeds without a brief.
try {
  main();
} catch (err) {
  process.stderr.write(`[mastersoft] lint-engine skipped: ${err && err.message ? err.message : err}\n`);
  process.exit(0);
}
