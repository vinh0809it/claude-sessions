'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Never read or write the real ~/.cache from tests.
require('../../lib/sessions').cache.enabled = false;

/** A fresh temp dir with the given subdirectories. */
function makeTmp(subdirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
  for (const d of subdirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

function rmTmp(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

/** Writes records as JSONL, creating parent folders. */
function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
}

module.exports = { makeTmp, rmTmp, writeJsonl };
