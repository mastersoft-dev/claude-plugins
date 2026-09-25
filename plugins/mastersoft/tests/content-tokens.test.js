#!/usr/bin/env node
/**
 * Static checks on the Markdown that Claude Code renders with substitution:
 * skills (skills/<name>/SKILL.md) and agents (agents/*.md).
 *
 * Claude Code replaces only the literal tokens `${CLAUDE_SKILL_DIR}`,
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}`,
 * in the body and in the Bash rules of `allowed-tools`; none of them is
 * exported to the Bash tool's environment. In skill bodies it also replaces
 * `$N` with the (0-based) N-th argument.
 * Each test fails with the offending file:line list.
 *
 * Usage: node plugins/mastersoft/tests/content-tokens.test.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TOKEN_NAMES = 'CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)';
const allFiles = () => [...skillFiles(), ...agentFiles()];

const RULES = [
  {
    name: 'plugin path tokens are braced',
    pattern: new RegExp(`\\$${TOKEN_NAMES}\\b`),
    hint: 'write ${VAR}: the unbraced form is never substituted and the variable is empty in Bash',
    files: allFiles,
    frontmatter: true,
  },
  {
    name: 'plugin path tokens use no shell default forms',
    pattern: new RegExp(`\\$\\{${TOKEN_NAMES}[:\\-=+?]`),
    hint: 'write the bare ${VAR}: default/alternate forms are left unsubstituted',
    files: allFiles,
    frontmatter: true,
  },
  {
    name: 'plugin path tokens are not read from process.env',
    pattern: new RegExp(`process\\.env\\.${TOKEN_NAMES}\\b`),
    hint: 'inline ${VAR} in the command instead: the variable is not in the Bash environment',
    files: allFiles,
  },
  {
    name: 'skill bodies contain no positional $N placeholders',
    pattern: /(?<![\\$\w])\$[0-9]/,
    hint: 'declare `arguments:` and use $name, or escape a literal as \\$N (awk/shell fields included)',
    files: () => skillFiles(),
  },
];

function skillFiles() {
  const dir = path.join(PLUGIN_ROOT, 'skills');
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name, 'SKILL.md'))
    .filter(f => fs.existsSync(f));
}

function agentFiles() {
  const dir = path.join(PLUGIN_ROOT, 'agents');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f));
}

function checkedLines(file, withFrontmatter) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const start = withFrontmatter || close === -1 ? 0 : close + 1;
  return lines.slice(start).map((text, i) => ({ text, line: start + i + 1 }));
}

function violations(rule) {
  return rule.files().flatMap(file =>
    checkedLines(file, rule.frontmatter)
      .filter(({ text }) => rule.pattern.test(text))
      .map(({ line }) => `${path.relative(PLUGIN_ROOT, file)}:${line}`));
}

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓  ${name}`); }
  catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  ✗  ${name}\n     ${e.message}`);
  }
}

console.log('\ncontent-tokens — substitution-safe skill and agent bodies\n');

RULES.forEach(rule => test(rule.name, () => {
  const hits = violations(rule);
  if (hits.length) throw new Error(`${rule.hint}: ${hits.join(', ')}`);
}));

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log(`  FAIL: ${f.name}\n       ${f.message}`));
  process.exit(1);
}
process.exit(0);
