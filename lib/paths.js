'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { shortenPath } = require('./format');

// Claude Code shortens project folder names longer than this.
const MAX_DIR_NAME = 200;

/** "~/x" → "/home/me/x". */
function expandHome(p) {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** True when `p` is `root` or inside it. */
function isWithin(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Same scheme as Claude Code: every non-alphanumeric character becomes '-'. */
function encodePathToDir(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The projects/ folder name Claude Code uses for `absPath`. Very long names get
 * a hash suffix we can't reproduce, so for those an existing folder sharing the
 * prefix is reused.
 */
function projectDirNameFor(configDirPath, absPath) {
  const encoded = encodePathToDir(absPath);
  if (encoded.length <= MAX_DIR_NAME) return encoded;
  const prefix = encoded.slice(0, MAX_DIR_NAME);
  try {
    const hit = fs.readdirSync(path.join(configDirPath, 'projects')).find(d => d.startsWith(prefix));
    if (hit) return hit;
  } catch {}
  throw new Error('path too long: start one Claude session in it first, then move');
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function commonPrefix(words) {
  let common = words[0];
  for (const w of words.slice(1)) {
    let i = 0;
    while (i < common.length && i < w.length && common[i] === w[i]) i++;
    common = common.slice(0, i);
  }
  return common;
}

/**
 * Shell-style directory completion. Returns the completed input and, when it is
 * ambiguous, the candidate names.
 */
function tabComplete(input) {
  const expanded      = expandHome(input);
  const endsWithSlash = /[\\/]$/.test(expanded);
  const baseDir       = endsWithSlash ? (expanded.slice(0, -1) || path.sep) : path.dirname(expanded);
  const prefix        = endsWithSlash ? '' : path.basename(expanded);

  let matches;
  try {
    matches = fs.readdirSync(baseDir)
      .filter(n => n.startsWith(prefix) && isDirectory(path.join(baseDir, n)))
      .sort();
  } catch { return { completed: input, matches: [] }; }

  if (!matches.length) return { completed: input, matches: [] };
  if (matches.length === 1) {
    return { completed: shortenPath(path.join(baseDir, matches[0]) + path.sep), matches: [] };
  }

  const common     = commonPrefix(matches);
  const candidates = matches.map(m => m + path.sep);
  return common.length > prefix.length
    ? { completed: shortenPath(path.join(baseDir, common)), matches: candidates }
    : { completed: input, matches: candidates };
}

module.exports = { expandHome, isWithin, encodePathToDir, projectDirNameFor, tabComplete };
