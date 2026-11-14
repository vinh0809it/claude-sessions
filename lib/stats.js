'use strict';

// Token usage of a session, from the `usage` Claude Code records on each reply.
//
// - A reply is written as several lines (one per content block) that repeat
//   the same usage, so replies are counted once, by message id.
// - Subagents keep their own transcripts in <id>/subagents/*.jsonl; they count.
// - /compact keeps earlier turns in the file, so they count too. A session
//   continued in a new file only covers that file's part.

const fs   = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const CHUNK_BYTES = 1024 * 1024;

/** Calls onLine for each line of a file, reading it in chunks. */
async function eachLine(file, onLine) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, null);
      const text = rest + (bytesRead ? decoder.write(buf.subarray(0, bytesRead)) : decoder.end());
      const lines = text.split('\n');
      rest = bytesRead ? lines.pop() : '';
      lines.forEach(onLine);
      if (!bytesRead) return;
    }
  } finally { await handle.close(); }
}

function subagentFiles(jsonlPath) {
  const dir = path.join(jsonlPath.replace(/\.jsonl$/, ''), 'subagents');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); }
  catch { return []; }
}

/**
 * Token totals of a session and its subagents:
 * { input, cacheWrite, cacheRead, output, replies, models: [most used first] }.
 */
async function sessionStats(jsonlPath) {
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, replies: 0 };
  const models = new Map();
  const seen = new Set();
  const onLine = (line) => {
    if (!line.includes('"usage"')) return; // cheap check before parsing
    let r;
    try { r = JSON.parse(line); } catch { return; }
    const m = r.message;
    if (r.type !== 'assistant' || !m?.usage) return;
    const id = m.id || r.requestId || r.uuid;
    if (seen.has(id)) return;
    seen.add(id);
    const u = m.usage;
    totals.input      += u.input_tokens || 0;
    totals.cacheWrite += u.cache_creation_input_tokens || 0;
    totals.cacheRead  += u.cache_read_input_tokens || 0;
    totals.output     += u.output_tokens || 0;
    totals.replies++;
    if (m.model && m.model !== '<synthetic>') models.set(m.model, (models.get(m.model) || 0) + 1);
  };
  for (const file of [jsonlPath, ...subagentFiles(jsonlPath)]) {
    try { await eachLine(file, onLine); } catch {}
  }
  return { ...totals, models: [...models].sort((a, b) => b[1] - a[1]).map(([name]) => name) };
}

/** 1234 → "1.2K", 3456789 → "3.5M". */
function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

module.exports = { sessionStats, fmtTokens };
