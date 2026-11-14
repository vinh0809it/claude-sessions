'use strict';

// Searching the conversation text of session files (what you and Claude
// wrote; not tool output) in the background: files are read in chunks so the
// UI stays responsive, and a search can be cancelled when the query changes.

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { messageText } = require('./sessions');

const CHUNK_BYTES = 1024 * 1024;
const MAX_MATCHES = 3;

/** The record's message text if it contains `needle` (lowercase), else null. */
function matchLine(line, needle) {
  if (!line.toLowerCase().includes(needle)) return null; // cheap check before parsing
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (record.type !== 'user' && record.type !== 'assistant') return null;
  const text = messageText(record).replace(/\s+/g, ' ');
  return text.toLowerCase().includes(needle) ? { role: record.type, text } : null;
}

/**
 * The first few messages of a session file whose text contains `query`
 * (case-insensitive), as [{ role, text }]; [] when none does. Tool calls and
 * tool output are not searched.
 */
async function findInConversation(file, query, { signal, max = MAX_MATCHES } = {}) {
  const needle = query.toLowerCase();
  const matches = [];
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8'); // keeps a character split across chunks whole
    let rest = '';
    for (;;) {
      if (signal?.aborted) return [];
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, null);
      const text = rest + (bytesRead ? decoder.write(buf.subarray(0, bytesRead)) : decoder.end());
      const lines = text.split('\n');
      rest = bytesRead ? lines.pop() : '';
      for (const line of lines) {
        const m = matchLine(line, needle);
        if (m && matches.push(m) >= max) return matches;
      }
      if (!bytesRead) return matches;
    }
  } finally { await handle.close(); }
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
