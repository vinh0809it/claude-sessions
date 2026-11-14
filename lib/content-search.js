'use strict';

// Searching the conversation text of session files (what you and Claude
// wrote; not tool output) in the background: files are read in chunks so the
// UI stays responsive, and a search can be cancelled when the query changes.

const { messageText } = require('./sessions');
const { clean } = require('./text');
const { eachLine } = require('./stats');

const MAX_MATCHES = 3;

/**
 * The record's message text if it contains `needle` (lowercase), else null.
 * A raw line is checked cheaply before parsing, but only for needles that read
 * the same inside JSON (no quote, backslash or whitespace, which JSON escapes
 * or which may span a newline in the text).
 */
function matchLine(line, needle, rawCheck) {
  if (rawCheck && !line.toLowerCase().includes(needle)) return null;
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (record?.type !== 'user' && record?.type !== 'assistant') return null;
  const text = clean(messageText(record));
  return text.toLowerCase().includes(needle) ? { role: record.type, text } : null;
}

/**
 * The first few messages of a session file whose text contains `query`
 * (case-insensitive; runs of whitespace match any whitespace), as
 * [{ role, text }]; [] when none does. Tool calls and tool output are not
 * searched.
 */
async function findInConversation(file, query, { signal, max = MAX_MATCHES } = {}) {
  const needle = query.toLowerCase().replace(/\s+/g, ' ');
  const rawCheck = !/["\\\s\x00-\x1f]/.test(needle);
  const matches = [];
  await eachLine(file, (line) => {
    const m = matchLine(line, needle, rawCheck);
    return !(m && matches.push(m) >= max);
  }, { signal });
  return signal?.aborted ? [] : matches;
}

/**
 * Calls onMatch(path, matches) for each file whose conversation contains
 * `query`, then resolves. Stops early when `signal` aborts. Unreadable files
 * are skipped.
 */
async function searchFiles(files, query, { signal, onMatch, onProgress } = {}) {
  let done = 0;
  for (const file of files) {
    if (signal?.aborted) return;
    try {
      const matches = await findInConversation(file, query, { signal });
      if (matches.length && !signal?.aborted) onMatch?.(file, matches);
    } catch {}
    onProgress?.(++done, files.length);
  }
}

module.exports = { findInConversation, searchFiles };
