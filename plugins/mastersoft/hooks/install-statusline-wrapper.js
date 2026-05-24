#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, 'statusline-wrapper.js');
const DST = path.join(os.homedir(), '.claude', 'mastersoft-statusline-wrapper.js');

try {
  const srcStat = fs.statSync(SRC);
  let needCopy = true;
  try {
    const dstStat = fs.statSync(DST);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
      needCopy = false;
    }
  } catch {}
  if (needCopy) {
    fs.mkdirSync(path.dirname(DST), { recursive: true });
    fs.copyFileSync(SRC, DST);
  }
} catch {}

process.exit(0);
