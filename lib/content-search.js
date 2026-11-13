'use strict';

// Searching inside session files for text, in the background: files are read
// in chunks with a yield between them so the UI stays responsive, and a search
// can be cancelled when the query changes.

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const CHUNK_BYTES = 1024 * 1024;

/**
 * True when the file contains `query` (case-insensitive). Reads it in chunks,
 * keeping an overlap so a match across a chunk boundary is still found.
 */
async function fileContains(file, query, signal) {
  const needle = query.toLowerCase();
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8'); // keeps a character split across chunks whole
    let carry = '';
    for (;;) {
      if (signal?.aborted) return false;
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, null);
      if (!bytesRead) return false;
      const text = carry + decoder.write(buf.subarray(0, bytesRead)).toLowerCase();
      if (text.includes(needle)) return true;
      carry = needle.length > 1 ? text.slice(-(needle.length - 1)) : '';
    }
  } finally { await handle.close(); }
}

/**
 * Calls onMatch(path) for each file that contains `query`, then resolves.
 * Stops early when `signal` aborts. Unreadable files are skipped.
 */
async function searchFiles(files, query, { signal, onMatch, onProgress } = {}) {
  let done = 0;
  for (const file of files) {
    if (signal?.aborted) return;
    try { if (await fileContains(file, query, signal)) onMatch?.(file); } catch {}
    onProgress?.(++done, files.length);
  }
}

module.exports = { fileContains, searchFiles };
