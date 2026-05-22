'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readStdinJson } = require('./lib');

function main() {
  const input = readStdinJson();
  if (!input) process.exit(0);

  const cwd = input.cwd || '.';
  const claudeHome = path.resolve(path.join(os.homedir(), '.claude'));
  const resolved = path.resolve(cwd);

  if (resolved === claudeHome || resolved.startsWith(claudeHome + path.sep)) {
    process.exit(0);
  }

  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    process.stdout.write('[NOTICE] No CLAUDE.md found in this directory. Consider running /init to set up project context.\n');
  }

  process.exit(0);
}

main();
