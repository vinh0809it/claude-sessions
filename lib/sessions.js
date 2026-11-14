'use strict';

// Reading Claude Code session files (~/.claude*/projects/<encoded-path>/<id>.jsonl)
// and listing them.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { discoverConfigDirs } = require('./config');
const { MAX_DIR_NAME, encodePathToDir, isWithin } = require('./paths');
const { shortenPath } = require('./format');

// Session files can reach hundreds of MB. Everything we need sits near the
// start (cwd, first prompt) or the end (latest title, recent messages).
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

// Text Claude Code injects into user turns (reminders, slash-command echoes, hook output).
const WRAPPER_RE = /^<(system-reminder|command-|local-command-|user-prompt-submit-hook|bash-|task-notification|pasted_content)/;

// ─── File reading ────────────────────────────────────────────────────────────

/** First `head` and last `tail` bytes of a file, as complete lines only. */
function readEdges(file, head = HEAD_BYTES, tail = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= head + tail) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const lines = buf.toString('utf8').split('\n');
      return { headLines: lines, tailLines: lines, whole: true };
    }
    const hb = Buffer.alloc(head);
    fs.readSync(fd, hb, 0, head, 0);
    const tb = Buffer.alloc(tail);
    fs.readSync(fd, tb, 0, tail, size - tail);
    return {
      headLines: hb.toString('utf8').split('\n').slice(0, -1), // drop the partial last line
      tailLines: tb.toString('utf8').split('\n').slice(1),     // drop the partial first line
      whole: false,
    };
  } finally { fs.closeSync(fd); }
}

function parseLine(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** Human-typed text of a user/assistant record; '' for tool results, meta and injected text. */
function messageText(record) {
  if (!record || record.isMeta || !record.message) return '';
  const c = record.message.content;
  const parts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text || '') : [];
  return parts.map(t => t.trim()).filter(t => t && !WRAPPER_RE.test(t)).join(' ');
}

/** Title, first prompt, working directory and start time of a session file. */
function readSession(jsonlPath) {
  let title = null, firstUserMessage = null, cwd = null, timestamp = null;
  let edges;
  try { edges = readEdges(jsonlPath); }
  catch { return { title, firstUserMessage, cwd, timestamp }; }

  for (const line of edges.headLines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (!firstUserMessage && r.type === 'user') {
      const text = messageText(r);
      if (text) firstUserMessage = text.replace(/\s+/g, ' ').slice(0, 80);
    }
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!timestamp && r.timestamp) timestamp = r.timestamp;
  }
  if (!edges.whole) {
    // Claude Code re-emits custom-title throughout the file; the last one wins.
    for (const line of edges.tailLines) {
      if (!line.includes('"custom-title"')) continue;
      const r = parseLine(line);
      if (r?.type === 'custom-title' && r.customTitle) title = r.customTitle;
    }
  }
  return { title, firstUserMessage, cwd, timestamp };
}

/** The last `n` human-readable messages, oldest first. */
function readRecentMessages(jsonlPath, n = 8) {
  let lines;
  try { lines = readEdges(jsonlPath, 0, TAIL_BYTES).tailLines; } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const r = parseLine(lines[i]);
    if (!r || (r.type !== 'user' && r.type !== 'assistant')) continue;
    const text = messageText(r);
    if (text) out.push({ role: r.type, text: text.replace(/\s+/g, ' ') });
  }
  return out.reverse();
}

// ─── Metadata cache ──────────────────────────────────────────────────────────
// readSession results keyed by path, valid while the file's size and mtime match.

const cache = {
  file: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-sessions', 'index.json'),
  data: null,
  dirty: false,
  enabled: true,

  load() {
    if (this.data) return;
    this.data = {};
    if (!this.enabled) return;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
  },

  get(p, stat) {
    this.load();
    const e = this.data[p];
    return e && e.mtimeMs === stat.mtimeMs && e.size === stat.size ? e.meta : null;
  },

  set(p, stat, meta) {
    this.data[p] = { mtimeMs: stat.mtimeMs, size: stat.size, meta };
    this.dirty = true;
  },

  /** Writes atomically. With `livePaths`, entries for files that no longer exist are dropped. */
  save(livePaths) {
    if (!this.enabled || !this.dirty) return;
    if (livePaths) for (const k of Object.keys(this.data)) if (!livePaths.has(k)) delete this.data[k];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {}
  },
};

function readSessionCached(jsonlPath, stat) {
  const hit = cache.get(jsonlPath, stat);
  if (hit) return hit;
  const meta = readSession(jsonlPath);
  cache.set(jsonlPath, stat, meta);
  return meta;
}

// ─── Scanning ────────────────────────────────────────────────────────────────

/**
 * True when Claude Code would store sessions started in `cwd` in folder
 * `folderName`. Windows paths are case-insensitive ("c:\\x" and "C:\\x" are the
 * same directory), so the comparison is too.
 */
function belongsTo(cwd, folderName, windows = process.platform === 'win32') {
  const fold = s => windows ? s.toLowerCase() : s;
  const encoded = fold(encodePathToDir(cwd));
  folderName = fold(folderName);
  return encoded === folderName
    // Long names are cut and given a hash suffix; compare the kept prefix.
    || (encoded.length > MAX_DIR_NAME && folderName.startsWith(encoded.slice(0, MAX_DIR_NAME)));
}

/**
 * The real path of a projects/ folder: its .project-path hint, else the cwd of
 * a session that belongs to it, else null. A session's cwd alone is not enough:
 * moved sessions keep the cwd they were started in.
 */
function folderPath(folderDir, folderName, files) {
  try {
    const hint = fs.readFileSync(path.join(folderDir, '.project-path'), 'utf8').trim();
    if (hint) return hint;
  } catch {}
  return files.find(f => f.meta.cwd && belongsTo(f.meta.cwd, folderName))?.meta.cwd ?? null;
}

/** Session files of a projects/ folder with their (cached) metadata. */
function readFolder(folderDir, livePaths) {
  let names;
  try { names = fs.readdirSync(folderDir).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  const files = [];
  for (const name of names) {
    const jsonlPath = path.join(folderDir, name);
    try {
      const stat = fs.statSync(jsonlPath);
      livePaths?.add(jsonlPath);
      files.push({ name, jsonlPath, mtime: stat.mtime, size: stat.size, meta: readSessionCached(jsonlPath, stat) });
    } catch {}
  }
  return files;
}

/**
 * All sessions in one config dir, newest first. Each session file's path is
 * added to `livePaths` so the cache can drop stale entries.
 */
function scanConfigDir(configDir, filterPath, livePaths = new Set()) {
  const projectsDir = path.join(configDir, 'projects');
  let folders;
  try { folders = fs.readdirSync(projectsDir); } catch { return []; }
  const results = [];

  for (const folderName of folders) {
    const folderDir = path.join(projectsDir, folderName);
    const files = readFolder(folderDir, livePaths);
    if (!files) continue;

    const dirPath = folderPath(folderDir, folderName, files);
    for (const { name, jsonlPath, mtime, size, meta } of files) {
      const project = dirPath || meta.cwd || folderName;
      if (filterPath && !isWithin(project, filterPath)) continue;
      results.push({
        configDir:     path.basename(configDir),
        configDirPath: configDir,
        project,
        sessionId:     name.replace(/\.jsonl$/, ''),
        title:         meta.title,
        firstMessage:  meta.firstUserMessage,
        lastModified:  mtime,
        timestamp:     meta.timestamp,
        size,
        jsonlPath,
      });
    }
  }
  return results.sort((a, b) => b.lastModified - a.lastModified);
}

/** Sessions from `opts.dir` or every discovered config dir, honoring the CLI filters. */
function loadSessions(opts) {
  const dirs = opts.dir ? [path.resolve(opts.dir)] : discoverConfigDirs();
  if (dirs.length === 0 && !opts.quiet) {
    process.stderr.write('No Claude Code config directories found (looked for ~/.claude* and $CLAUDE_CONFIG_DIR)\n');
  }
  const live = new Set();
  const all  = dirs.flatMap(d => scanConfigDir(d, opts.filterPath, live));
  cache.save(opts.filterPath || opts.dir ? null : live); // only prune after a full scan
  return opts.namedOnly ? all.filter(s => s.title) : all;
}

/** The real path of the projects/ folder `folderDir` (see folderPath), or null. */
function projectPathOf(folderDir) {
  return folderPath(folderDir, path.basename(folderDir), readFolder(folderDir) || []);
}

/**
 * Project folders of a config dir whose real path is known, sorted by path.
 * Folders without one (e.g. holding only memory/) can't be shown meaningfully
 * and are left out; a path can still be typed in the picker.
 */
function listProjectFolders(configDirPath) {
  const projectsDir = path.join(configDirPath, 'projects');
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const folders = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectPath = projectPathOf(path.join(projectsDir, e.name));
    if (projectPath) folders.push({ projectDirName: e.name, projectPath, displayPath: shortenPath(projectPath) });
  }
  return folders.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

/**
 * Sessions matching `query` for "-o", best kind of match first: exact title or
 * id, then id prefix, then title, first message, folder containing it (case-
 * insensitive). Returns only the best kind found, newest first.
 */
function findSessions(sessions, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const has = (v) => (v || '').toLowerCase().includes(q);
  const tiers = [
    s => (s.title || '').toLowerCase() === q || s.sessionId === q,
    s => q.length >= 4 && s.sessionId.startsWith(q),
    s => has(s.title),
    s => has(s.firstMessage),
    s => has(s.project),
  ];
  for (const test of tiers) {
    const hits = sessions.filter(test);
    if (hits.length) return hits.sort((a, b) => b.lastModified - a.lastModified);
  }
  return [];
}

const SORTS = ['date', 'size', 'name'];

/** Sorts within each profile, keeping profiles in their original order. */
function sortSessions(sessions, mode, isPinned = () => false) {
  const order = new Map();
  for (const s of sessions) if (!order.has(s.configDir)) order.set(s.configDir, order.size);
  const compare = {
    date: (a, b) => b.lastModified - a.lastModified,
    size: (a, b) => b.size - a.size,
    name: (a, b) => (a.title || a.firstMessage || '~').localeCompare(b.title || b.firstMessage || '~'),
  }[mode];
  return [...sessions].sort((a, b) =>
    (order.get(a.configDir) - order.get(b.configDir)) ||
    (isPinned(b.sessionId) - isPinned(a.sessionId)) || // pinned first within a profile
    compare(a, b));
}

module.exports = {
  cache, messageText, readSession, readRecentMessages, scanConfigDir, loadSessions, findSessions, belongsTo, projectPathOf, listProjectFolders, SORTS, sortSessions,
};
