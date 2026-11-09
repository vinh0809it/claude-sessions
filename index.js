#!/usr/bin/env node
'use strict';

/**
 * claude-sessions — Terminal UI for Claude Code sessions
 *
 * Usage:
 *   claude-sessions [folder]        TUI, optionally filtered by folder path
 *   claude-sessions --list [folder] Plain list output
 *   claude-sessions --named-only    Only /rename'd sessions
 *   claude-sessions --json          JSON output
 *   claude-sessions -d <path>       Scan a specific config dir
 *   claude-sessions --empty-trash   Permanently remove deleted sessions
 *   claude-sessions --no-cache      Ignore the metadata cache
 *   claude-sessions --version       Print version
 *   claude-sessions -h              Help
 *
 * TUI keys:
 *   ↑ ↓  j k        Navigate
 *   PgUp PgDn        Page up / down
 *   g G              Jump to top / bottom
 *   /                Search (shows [config] project inline)
 *   Esc              Clear search / marks
 *   Enter            Open session (new tab if supported, else here)
 *   o                Open session in this terminal
 *   p                Toggle preview of recent messages
 *   r                Rename session
 *   s                Cycle sort: date / size / name
 *   Space            Mark session (for bulk delete)
 *   n                New session
 *   m                Move session to another config / folder
 *   d                Delete session(s) to trash
 *   ?                Help
 *   q  Ctrl-C        Quit
 *
 * Environment variables:
 *   CLAUDE_SESSIONS_TERMINAL    Force terminal: kitty | wezterm | tmux | iterm2 | apple-terminal | here
 *   CLAUDE_SESSIONS_OPEN_CMD    Custom open command (placeholders: %cmd% %title% %project%)
 *   CLAUDE_CONFIG_DIR           Also scanned when set
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawnSync } = require('child_process');

let VERSION = 'dev';
try { VERSION = require('./package.json').version; } catch {} // single-file installs have no package.json
const IS_WIN   = process.platform === 'win32';
const TRASH    = '.claude-sessions-trash';
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

// ─── Config dir discovery ─────────────────────────────────────────────────────

function hasProjects(d) {
  try { return fs.statSync(path.join(d, 'projects')).isDirectory(); } catch { return false; }
}

function discoverConfigDirs() {
  const home = os.homedir();
  let dirs = [];
  try {
    dirs = fs.readdirSync(home)
      .filter(n => n === '.claude' || n.startsWith('.claude-'))
      .map(n => path.join(home, n));
  } catch {}
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  return [...new Set(dirs)]
    .filter(hasProjects)
    .sort((a, b) => {
      const na = path.basename(a), nb = path.basename(b);
      if (na === '.claude') return 1;
      if (nb === '.claude') return -1;
      return na.localeCompare(nb);
    });
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { dir: null, namedOnly: false, json: false, list: false, help: false, version: false,
                 filterPath: null, emptyTrash: false, noCache: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '-d' || a === '--dir')        opts.dir = argv[++i];
    else if (a === '--named-only')               opts.namedOnly = true;
    else if (a === '--json')                     opts.json = true;
    else if (a === '--list')                     opts.list = true;
    else if (a === '--empty-trash')              opts.emptyTrash = true;
    else if (a === '--no-cache')                 opts.noCache = true;
    else if (a === '--version' || a === '-v')    opts.version = true;
    else if (a === '-h' || a === '--help')       opts.help = true;
    else if (!a.startsWith('-'))                 opts.filterPath = path.resolve(a.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return opts;
}

// ─── Session reading ──────────────────────────────────────────────────────────

// Reads the first `head` and last `tail` bytes, returning only complete lines.
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
    const headLines = hb.toString('utf8').split('\n').slice(0, -1); // drop partial last line
    const tailLines = tb.toString('utf8').split('\n').slice(1);     // drop partial first line
    return { headLines, tailLines, whole: false };
  } finally { fs.closeSync(fd); }
}

function parseLine(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// Text Claude Code injects into user turns (reminders, slash-command echoes, hook output).
const WRAPPER_RE = /^<(system-reminder|command-|local-command-|user-prompt-submit-hook|bash-|task-notification|pasted_content)/;

// Human-typed text of a user/assistant record, or '' for tool results, meta and wrappers.
function messageText(r) {
  if (!r || r.isMeta || !r.message) return '';
  const c = r.message.content;
  const parts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text || '') : [];
  return parts.map(t => t.trim()).filter(t => t && !WRAPPER_RE.test(t)).join(' ');
}

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

// Last `n` human-readable messages, for the preview pane.
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

// ─── Metadata cache ───────────────────────────────────────────────────────────

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
  get(p, st) {
    this.load();
    const e = this.data[p];
    return e && e.mtimeMs === st.mtimeMs && e.size === st.size ? e.meta : null;
  },
  set(p, st, meta) {
    this.data[p] = { mtimeMs: st.mtimeMs, size: st.size, meta };
    this.dirty = true;
  },
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

function readSessionCached(jsonlPath, st) {
  const hit = cache.get(jsonlPath, st);
  if (hit) return hit;
  const meta = readSession(jsonlPath);
  cache.set(jsonlPath, st, meta);
  return meta;
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

function scanConfigDir(configDir, filterPath, livePaths = new Set()) {
  const projectsDir = path.join(configDir, 'projects');
  let projectEntries;
  try { projectEntries = fs.readdirSync(projectsDir); } catch { return []; }
  const results = [];

  for (const pd of projectEntries) {
    const pdFull = path.join(projectsDir, pd);
    let names;
    try { names = fs.readdirSync(pdFull).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    const files = [];
    for (const f of names) {
      const p = path.join(pdFull, f);
      try {
        const st = fs.statSync(p);
        livePaths.add(p);
        files.push({ file: f, jsonlPath: p, mtime: st.mtime, size: st.size, meta: readSessionCached(p, st) });
      } catch {}
    }

    // Folder's real path: .project-path hint (written at move time), else any session whose cwd encodes to it.
    let dirPath = null;
    try { dirPath = fs.readFileSync(path.join(pdFull, '.project-path'), 'utf8').trim() || null; } catch {}
    if (!dirPath) dirPath = files.find(x => x.meta.cwd && encodePathToDir(x.meta.cwd) === pd)?.meta.cwd ?? null;

    for (const { file, jsonlPath, mtime, size, meta } of files) {
      const project = dirPath || meta.cwd || pd;
      if (filterPath && !isWithin(project, filterPath)) continue;
      results.push({
        configDir:     path.basename(configDir),
        configDirPath: configDir,
        project,
        sessionId:    file.replace(/\.jsonl$/, ''),
        title:        meta.title,
        firstMessage: meta.firstUserMessage,
        lastModified: mtime,
        timestamp:    meta.timestamp,
        size,
        jsonlPath,
      });
    }
  }
  return results.sort((a, b) => b.lastModified - a.lastModified);
}

function isWithin(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function loadSessions(opts) {
  const dirs = opts.dir ? [path.resolve(opts.dir)] : discoverConfigDirs();
  if (dirs.length === 0) process.stderr.write('No Claude Code config directories found (looked for ~/.claude* and $CLAUDE_CONFIG_DIR)\n');
  const live = new Set();
  const all  = dirs.flatMap(d => scanConfigDir(d, opts.filterPath, live));
  cache.save(opts.filterPath || opts.dir ? null : live); // only prune on a full scan
  return opts.namedOnly ? all.filter(s => s.title) : all;
}

// ─── Session operations ───────────────────────────────────────────────────────

// rename(2) fails across filesystems (EXDEV); fall back to copy + remove.
function movePath(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function companionDir(jsonlPath) { return jsonlPath.replace(/\.jsonl$/, ''); }

// Moves a session into <configDir>/.claude-sessions-trash/ (same filesystem, so it's a cheap rename).
function deleteSessionFiles(session) {
  const projDirName = path.basename(path.dirname(session.jsonlPath));
  const trashDir    = path.join(session.configDirPath, TRASH, projDirName);
  fs.mkdirSync(trashDir, { recursive: true });
  let base = path.basename(session.jsonlPath, '.jsonl');
  if (fs.existsSync(path.join(trashDir, base + '.jsonl'))) base += '-' + Date.now();
  movePath(session.jsonlPath, path.join(trashDir, base + '.jsonl'));
  const dir = companionDir(session.jsonlPath);
  try { if (fs.statSync(dir).isDirectory()) movePath(dir, path.join(trashDir, base)); } catch {}
  return trashDir;
}

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    for (const n of fs.readdirSync(p)) total += dirSize(path.join(p, n));
  } catch {}
  return total;
}

function emptyTrash(configDirs) {
  let freed = 0;
  for (const d of configDirs) {
    const t = path.join(d, TRASH);
    if (!fs.existsSync(t)) continue;
    freed += dirSize(t);
    fs.rmSync(t, { recursive: true, force: true });
  }
  return freed;
}

function moveSession(session, targetConfigDirPath, targetProjectDirName, targetRawPath = null) {
  const srcProjectDirName = path.basename(path.dirname(session.jsonlPath));
  const destDirName       = targetProjectDirName || srcProjectDirName;
  const targetProjectDir  = path.join(targetConfigDirPath, 'projects', destDirName);
  const targetJsonl       = path.join(targetProjectDir, path.basename(session.jsonlPath));
  if (path.resolve(targetJsonl) === path.resolve(session.jsonlPath)) return;
  if (fs.existsSync(targetJsonl)) throw new Error('a session with this id already exists there');

  fs.mkdirSync(targetProjectDir, { recursive: true });
  movePath(session.jsonlPath, targetJsonl);

  const srcDir = companionDir(session.jsonlPath);
  try { if (fs.statSync(srcDir).isDirectory()) movePath(srcDir, companionDir(targetJsonl)); } catch {}

  if (targetRawPath) {
    try { fs.writeFileSync(path.join(targetProjectDir, '.project-path'), targetRawPath, 'utf8'); } catch {}
  }

  session.configDir     = path.basename(targetConfigDirPath);
  session.configDirPath = targetConfigDirPath;
  session.jsonlPath     = targetJsonl;
}

// Appends a custom-title record — the same thing /rename writes.
function renameSession(session, title) {
  title = title.trim();
  if (!title) throw new Error('empty title');
  const fd = fs.openSync(session.jsonlPath, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const rec = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: session.sessionId });
    fs.writeSync(fd, prefix + rec + '\n', size);
  } finally { fs.closeSync(fd); }
  session.title = title;
}

function listProjectFolders(configDirPath) {
  const projectsDir = path.join(configDirPath, 'projects');
  try {
    return fs.readdirSync(projectsDir)
      .filter(d => { try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; } })
      .map(d => {
        let displayPath = d;
        try {
          const hint = fs.readFileSync(path.join(projectsDir, d, '.project-path'), 'utf8').trim();
          if (hint) displayPath = shortenPath(hint);
        } catch {
          try {
            const f = fs.readdirSync(path.join(projectsDir, d)).find(f => f.endsWith('.jsonl'));
            if (f) {
              const { cwd } = readSession(path.join(projectsDir, d, f));
              if (cwd) displayPath = shortenPath(cwd);
            }
          } catch {}
        }
        return { projectDirName: d, displayPath };
      })
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  } catch { return []; }
}

// Same scheme as Claude Code: every non-alphanumeric char becomes '-'.
const MAX_DIR_NAME = 200;
function encodePathToDir(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// Claude Code shortens very long names with a hash suffix we can't reproduce,
// so for those reuse an existing folder that shares the prefix.
function projectDirNameFor(configDirPath, absPath) {
  const enc = encodePathToDir(absPath);
  if (enc.length <= MAX_DIR_NAME) return enc;
  const prefix = enc.slice(0, MAX_DIR_NAME);
  try {
    const hit = fs.readdirSync(path.join(configDirPath, 'projects')).find(d => d.startsWith(prefix));
    if (hit) return hit;
  } catch {}
  throw new Error('path too long: start one Claude session in it first, then move');
}

function expandHome(p) { return p.replace(/^~(?=$|[\\/])/, os.homedir()); }

function tabComplete(input) {
  const expanded      = expandHome(input);
  const endsWithSlash = /[\\/]$/.test(expanded);
  const baseDir       = endsWithSlash ? (expanded.slice(0, -1) || path.sep) : path.dirname(expanded);
  const prefix        = endsWithSlash ? '' : path.basename(expanded);

  let matches;
  try {
    matches = fs.readdirSync(baseDir)
      .filter(n => n.startsWith(prefix) && (() => {
        try { return fs.statSync(path.join(baseDir, n)).isDirectory(); } catch { return false; }
      })())
      .sort();
  } catch { return { completed: input, matches: [] }; }

  if (!matches.length) return { completed: input, matches: [] };

  if (matches.length === 1) {
    return { completed: shortenPath(path.join(baseDir, matches[0]) + path.sep), matches: [] };
  }

  let common = matches[0];
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < common.length && i < m.length && common[i] === m[i]) i++;
    common = common.slice(0, i);
  }

  if (common.length > prefix.length) {
    return { completed: shortenPath(path.join(baseDir, common)), matches: matches.map(m => m + path.sep) };
  }
  return { completed: input, matches: matches.map(m => m + path.sep) };
}

// ─── Terminal detection & open ────────────────────────────────────────────────

function detectTerminal(env = process.env) {
  if (env.CLAUDE_SESSIONS_TERMINAL) return env.CLAUDE_SESSIONS_TERMINAL;
  if (env.KITTY_WINDOW_ID !== undefined) return 'kitty';
  if (env.WEZTERM_PANE    !== undefined) return 'wezterm';
  if (env.TMUX)                          return 'tmux';
  if (env.TERM_PROGRAM === 'iTerm.app')      return 'iterm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'apple-terminal';
  return 'here';
}

function shellEsc(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function appleStr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function trySpawn(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) return { ok: false, msg: `${cmd}: ${r.error.code === 'ENOENT' ? 'not found' : r.error.message}` };
  return r.status === 0
    ? { ok: true }
    : { ok: false, msg: r.stderr?.toString().trim() || `${cmd} exited with ${r.status}` };
}

function resolveProjectPath(session) {
  const sessionDir = path.dirname(session.jsonlPath);
  try {
    const hint = fs.readFileSync(path.join(sessionDir, '.project-path'), 'utf8').trim();
    if (hint && fs.existsSync(hint)) return hint;
  } catch {}
  try {
    const siblings = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl') && f !== path.basename(session.jsonlPath));
    for (const sibling of siblings) {
      const { cwd } = readSession(path.join(sessionDir, sibling));
      if (cwd && fs.existsSync(cwd)) return cwd;
    }
  } catch {}
  return fs.existsSync(session.project) ? session.project : os.homedir();
}

// A launch plan: where to run, which claude args, under which config dir.
function resumePlan(session) {
  return {
    cwd:   resolveProjectPath(session),
    args:  ['-r', session.sessionId],
    configDirPath: session.configDirPath,
    title: session.title || session.sessionId.slice(0, 8),
  };
}

function newPlan(configDirPath, projectPath) {
  return { cwd: projectPath, args: [], configDirPath, title: path.basename(projectPath) };
}

function planShellCmd(plan) {
  const claude = ['claude', ...plan.args].join(' ');
  return `cd ${shellEsc(plan.cwd)} && CLAUDE_CONFIG_DIR=${shellEsc(plan.configDirPath)} ${claude}; exec "\${SHELL:-bash}"`;
}

// Returns { ok, msg } or { here: true } when the caller should run it in this terminal.
function launchInTab(plan) {
  const shellCmd  = planShellCmd(plan);
  const customTpl = process.env.CLAUDE_SESSIONS_OPEN_CMD;
  if (customTpl) {
    const expanded = customTpl
      .replace(/%cmd%/g,     shellEsc(shellCmd))
      .replace(/%title%/g,   shellEsc(plan.title))
      .replace(/%project%/g, shellEsc(plan.cwd));
    const r = spawnSync('bash', ['-c', expanded], { stdio: 'ignore' });
    return r.status === 0 ? { ok: true } : { ok: false, msg: `Custom open command failed (exit ${r.status})` };
  }

  switch (detectTerminal()) {
    case 'kitty':
      return trySpawn('kitty', ['@', 'launch', '--type=tab', `--tab-title=${plan.title}`, 'bash', '-i', '-c', shellCmd]);
    case 'wezterm':
      return trySpawn('wezterm', ['cli', 'spawn', '--', 'bash', '-i', '-c', shellCmd]);
    case 'tmux':
      return trySpawn('tmux', ['new-window', '-n', plan.title.slice(0, 20), `bash -i -c ${shellEsc(shellCmd)}`]);
    case 'iterm2':
      return trySpawn('osascript', ['-e',
        `tell application "iTerm2" to tell current window to create tab with default profile command ${appleStr('bash -i -c ' + shellEsc(shellCmd))}`]);
    case 'apple-terminal':
      return trySpawn('osascript', ['-e', `tell application "Terminal" to do script ${appleStr(shellCmd)}`]);
    default:
      return { here: true };
  }
}

// Runs claude in the current terminal and waits for it to exit.
function runHere(plan) {
  const r = spawnSync('claude', plan.args, {
    cwd:   plan.cwd,
    env:   { ...process.env, CLAUDE_CONFIG_DIR: plan.configDirPath },
    stdio: 'inherit',
    shell: IS_WIN, // claude may be a .cmd shim on Windows
  });
  if (r.error) return { ok: false, msg: r.error.code === 'ENOENT' ? '`claude` not found on PATH' : r.error.message };
  return { ok: true };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtDate(d) {
  const t = new Date(d), p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  const u = ['K', 'M', 'G'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}${u[i]}`;
}

function shortConfig(configDir) {
  return path.basename(configDir).replace(/^\.claude-?/, '') || 'default';
}

function shortenPath(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

const SORTS = ['date', 'size', 'name'];
function sortSessions(sessions, mode) {
  const order = new Map();
  for (const s of sessions) if (!order.has(s.configDir)) order.set(s.configDir, order.size);
  const key = {
    date: (a, b) => b.lastModified - a.lastModified,
    size: (a, b) => b.size - a.size,
    name: (a, b) => (a.title || a.firstMessage || '~').localeCompare(b.title || b.firstMessage || '~'),
  }[mode];
  return [...sessions].sort((a, b) => (order.get(a.configDir) - order.get(b.configDir)) || key(a, b));
}

// ─── Plain list output ────────────────────────────────────────────────────────

function ansi(code, s) { return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s; }

function printList(sessions) {
  if (!sessions.length) { console.log('No sessions found.'); return; }
  let lastConfig = null, lastProject = null;
  for (const s of sessions) {
    if (s.configDir !== lastConfig) {
      if (lastConfig) console.log();
      console.log(ansi('1;36', `[${s.configDir}]`));
      lastConfig = s.configDir; lastProject = null;
    }
    if (s.project !== lastProject) {
      console.log(ansi('33', `  ${shortenPath(s.project)}`));
      lastProject = s.project;
    }
    const label = s.title
      ? ansi('1;32', s.title)
      : ansi('2', `(${(s.firstMessage || 'untitled').slice(0, 60)}…)`);
    console.log(`    ${label}  ${ansi('2', `${fmtDate(s.lastModified)}  ${fmtSize(s.size)}`)}`);
    console.log(ansi('2', `    id: ${s.sessionId}`));
  }
}

// ─── TUI ──────────────────────────────────────────────────────────────────────

const ESC        = '\x1b';
const clrLine    = `${ESC}[2K`;
const clrScreen  = `${ESC}[2J`;
const hideCursor = `${ESC}[?25l`;
const showCursor = `${ESC}[?25h`;
const altBuf     = `${ESC}[?1049h`;
const normBuf    = `${ESC}[?1049l`;

const mv    = (r, c) => `${ESC}[${r};${c}H`;
const bold  = s => `${ESC}[1m${s}${ESC}[0m`;
const dim   = s => `${ESC}[2m${s}${ESC}[0m`;
const inv   = s => `${ESC}[7m${s}${ESC}[0m`;
const fgc   = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;
const bgc   = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;
const trunc = (s, n) => n > 0 && s.length > n ? s.slice(0, n - 1) + '…' : s;
const pad   = (s, n) => s.padEnd(n).slice(0, n);

const HELP = [
  ['↑↓ / j k', 'Navigate'],          ['PgUp PgDn', 'Page up / down'],
  ['g / G', 'Top / bottom'],         ['/', 'Search titles, messages, paths'],
  ['Esc', 'Clear search / marks'],   ['Enter', 'Open (new tab if supported, else here)'],
  ['o', 'Open in this terminal'],    ['p', 'Toggle preview'],
  ['r', 'Rename'],                   ['s', 'Sort: date / size / name'],
  ['Space', 'Mark for bulk delete'], ['n', 'New session'],
  ['m', 'Move to profile / folder'], ['d', 'Delete marked or selected (to trash)'],
  ['q / Ctrl-C', 'Quit'],
];

// ─── Picker ───────────────────────────────────────────────────────────────────
// Shared profile → folder → input flow used by both move and new modes.
// step: 'profile' | 'folder' | 'input'

class Picker {
  constructor({ headerLabel, profileLabel = 'Select profile', inputPrompt, buildProfileItems, buildFolderItems, onConfirmItem, onConfirmCustom }) {
    this.step  = 'profile';
    this.items = [];
    this.selIdx = 0;
    this.scroll = 0;
    this.config = null;
    this.input  = '';
    this.completions = [];

    this._headerLabel       = headerLabel;
    this._profileLabel      = profileLabel;
    this._inputPrompt       = inputPrompt;
    this._buildProfileItems = buildProfileItems;
    this._buildFolderItems  = buildFolderItems;
    this._onConfirmItem     = onConfirmItem;
    this._onConfirmCustom   = onConfirmCustom;
  }

  enter() {
    this.step        = 'profile';
    this.items       = this._buildProfileItems();
    this.selIdx      = 0;
    this.scroll      = 0;
    this.config      = null;
    this.input       = '';
    this.completions = [];
    // Skip the profile step when there is only one.
    if (this.items.length === 1) this._enterFolderStep(this.items[0].configDirPath);
  }

  _enterFolderStep(configDirPath) {
    this.config = configDirPath;
    this.step   = 'folder';
    this.items  = this._buildFolderItems(configDirPath);
    this.selIdx = 0;
    this.scroll = 0;
  }

  // Returns false when the picker should be dismissed.
  handleKey(key) {
    if (this.step === 'input') {
      if (key === '\x1b') {
        this.step        = 'folder';
        this.completions = [];
        this.items       = this._buildFolderItems(this.config);
      } else if (key === '\t') {
        const { completed, matches } = tabComplete(this.input || '~/');
        this.input       = completed;
        this.completions = matches.length > 1 ? matches : [];
      } else if (key === '\x7f' || key === '\b') {
        this.input       = this.input.slice(0, -1);
        this.completions = [];
      } else if (key === '\r') {
        const raw = this.input.trim();
        this.completions = [];
        if (raw) this._onConfirmCustom(path.resolve(expandHome(raw).replace(/[\\/]+$/, '') || path.sep));
        else this.step = 'folder';
      } else if (isPrintable(key)) {
        this.input      += key;
        this.completions = [];
      }
      return true;
    }

    if (key === '\x1b') {
      const profiles = this._buildProfileItems();
      if (this.step === 'folder' && profiles.length > 1) {
        this.step   = 'profile';
        this.items  = profiles;
        this.selIdx = 0;
        this.scroll = 0;
        return true;
      }
      return false;
    }

    if (key === '\x1b[A' || key === 'k') { this.selIdx = Math.max(0, this.selIdx - 1); return true; }
    if (key === '\x1b[B' || key === 'j') { this.selIdx = Math.min(this.items.length - 1, this.selIdx + 1); return true; }

    if (key === '\r') {
      const item = this.items[this.selIdx];
      if (!item) return true;
      if (item.type === 'profile') { this._enterFolderStep(item.configDirPath); return true; }
      if (item.type === 'new')     { this.step = 'input'; this.input = '~/'; this.completions = []; return true; }
      this._onConfirmItem(item);
    }
    return true;
  }

  render(out, W, H) {
    const headerLabel = typeof this._headerLabel === 'function' ? this._headerLabel() : this._headerLabel;
    out.push(mv(2, 1), clrLine, `  ${headerLabel}`);

    out.push(mv(3, 1), clrLine);
    const divider = dim('─'.repeat(Math.max(0, W - 30)));
    if (this.step === 'profile') {
      out.push(`  ` + bold(this._profileLabel) + `  ` + divider);
    } else {
      out.push(`  ` + bold('Select folder in ') + bold(fgc('96', `[${path.basename(this.config)}]`)) + `  ` + divider);
    }

    let listStart = 4;
    if (this.step === 'input') {
      out.push(mv(4, 1), clrLine, `  ${fgc('93', this._inputPrompt)} ${this.input}█`);
      out.push(mv(5, 1), clrLine);
      if (this.completions.length > 1) {
        const cols = Math.max(1, Math.floor((W - 2) / 22));
        const rows = Math.ceil(this.completions.length / cols);
        for (let r = 0; r < Math.min(rows, H - 8); r++) {
          out.push(mv(r + 5, 1), clrLine);
          out.push(`  ` + dim(this.completions.slice(r * cols, r * cols + cols).map(n => pad(n, 22)).join(' ')));
        }
        listStart = H;
      } else {
        out.push(dim(`  Tab to complete path`));
        listStart = 6;
      }
    }

    const items  = this.step === 'input' ? [] : this.items;
    const maxVis = Math.max(0, H - listStart - 1);
    if (this.selIdx < this.scroll) this.scroll = this.selIdx;
    if (this.selIdx >= this.scroll + maxVis) this.scroll = this.selIdx - maxVis + 1;
    if (this.scroll < 0) this.scroll = 0;

    for (let r = 0; r < maxVis; r++) {
      out.push(mv(listStart + r, 1), clrLine);
      const item = items[this.scroll + r];
      if (!item) continue;
      const isSel  = (this.scroll + r) === this.selIdx;
      const label  = item.type === 'same'    ? dim(item.label)
                   : item.type === 'new'     ? fgc('93', item.label)
                   : item.type === 'profile' ? bold(fgc('96', item.label))
                   : fgc('33', item.label);
      out.push(isSel ? inv(pad(`    ${trunc(item.label, W - 4)}`, W)) : `    ${label}`);
    }
  }
}

// Word-wraps text to `width` columns; words longer than a line are split.
function wrapWords(text, width) {
  const lines = [];
  let cur = '';
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, width)); word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}

// A stdin chunk may hold several keys (fast typing, paste): split into single
// chars, keeping escape sequences like "\x1b[A" or "\x1b[5~" whole.
function splitKeys(chunk) {
  const keys = [];
  const re = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
  let m;
  while ((m = re.exec(chunk))) keys.push(m[0]);
  return keys;
}

function isPrintable(key) {
  return key.length >= 1 && !key.startsWith('\x1b') && [...key].every(ch => ch >= ' ' && ch !== '\x7f');
}

// ─── TUI ─────────────────────────────────────────────────────────────────────

class TUI {
  constructor(sessions, opts = {}) {
    this.all        = sessions;
    this.opts       = opts;
    this.filterPath = opts.filterPath || '';
    this.search     = '';
    this.mode       = null;  // null | 'search' | 'delete' | 'move' | 'new' | 'rename' | 'help'
    this.statusMsg  = '';
    this._statusTimer = null;
    this.selIdx     = 0;
    this.scrollTop  = 0;
    this.items      = [];
    this.sort       = 'date';
    this.marked     = new Set();   // jsonlPath
    this.preview    = false;
    this._previewCache = new Map();
    this.renameInput = '';
    this.w = process.stdout.columns || 80;
    this.h = process.stdout.rows    || 24;

    this.movePicker = this._createMovePicker();
    this.newPicker  = this._createNewPicker();
    this.rebuild();
  }

  get previewH() { return this.preview ? Math.max(4, Math.floor((this.h - 2) * 0.4)) : 0; }
  get listH()    { return this.h - 2 - this.previewH; }

  _createMovePicker() {
    return new Picker({
      headerLabel: () => {
        const s = this.selectedSession();
        const label = s?.title || s?.firstMessage?.slice(0, 60) || s?.sessionId?.slice(0, 8) || '';
        return `Moving: ` + (label ? fgc('92', `"${trunc(label, this.w - 12)}"`) : dim('(untitled)'));
      },
      profileLabel: 'Select target profile',
      inputPrompt:  'New path:',
      buildProfileItems: () => {
        const s = this.selectedSession();
        return discoverConfigDirs().map(d => ({
          type: 'profile',
          label: path.basename(d) + (d === s?.configDirPath ? '  (current)' : ''),
          configDirPath: d,
        }));
      },
      buildFolderItems: (configDirPath) => {
        const s            = this.selectedSession();
        const isSameConfig = configDirPath === s?.configDirPath;
        const srcDirName   = s ? path.basename(path.dirname(s.jsonlPath)) : null;
        const items = [];
        if (!isSameConfig) {
          items.push({ type: 'same', label: (s ? shortenPath(s.project) : '') + '  (keep same folder)', dirName: null });
        }
        listProjectFolders(configDirPath)
          .filter(f => !(isSameConfig && f.projectDirName === srcDirName))
          .forEach(f => items.push({ type: 'folder', label: f.displayPath, dirName: f.projectDirName }));
        items.push({ type: 'new', label: '[type a new path…]', dirName: null });
        return items;
      },
      onConfirmItem:   (item) => this._doMove(item.dirName),
      onConfirmCustom: (absPath) => {
        try { this._doMove(projectDirNameFor(this.movePicker.config, absPath), absPath); }
        catch (e) { this.mode = null; this.setStatus(`Move failed: ${e.message}`, 5000); }
      },
    });
  }

  _createNewPicker() {
    return new Picker({
      headerLabel: fgc('92', 'New session'),
      inputPrompt: 'Path:',
      buildProfileItems: () => discoverConfigDirs().map(d => ({
        type: 'profile', label: path.basename(d), configDirPath: d,
      })),
      buildFolderItems: (configDirPath) => [
        ...listProjectFolders(configDirPath).map(f => ({
          type: 'folder',
          label: f.displayPath,
          projectPath: expandHome(f.displayPath),
        })),
        { type: 'new', label: '[type a new path…]', projectPath: null },
      ],
      onConfirmItem:   (item) => { if (item.projectPath) this._doNew(item.projectPath); },
      onConfirmCustom: (absPath) => this._doNew(absPath),
    });
  }

  // ── Item list ───────────────────────────────────────────────────────────────

  rebuild() {
    const q        = this.search.toLowerCase();
    const filtered = q
      ? this.all.filter(s =>
          (s.title        || '').toLowerCase().includes(q) ||
          (s.firstMessage || '').toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q))
      : this.all;

    this.items = [];
    let lastConfig = null;
    for (const s of sortSessions(filtered, this.sort)) {
      if (s.configDir !== lastConfig) {
        this.items.push({ type: 'config', label: s.configDir });
        lastConfig = s.configDir;
      }
      this.items.push({ type: 'session', session: s });
    }

    const total = this.sessionItems().length;
    this.selIdx = Math.min(this.selIdx, Math.max(0, total - 1));
    this.ensureVisible();
  }

  sessionItems()    { return this.items.filter(i => i.type === 'session'); }
  selectedSession() { return this.sessionItems()[this.selIdx]?.session ?? null; }

  selItemRow() {
    let si = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].type === 'session') {
        if (si === this.selIdx) return i;
        si++;
      }
    }
    return -1;
  }

  ensureVisible() {
    const r = this.selItemRow();
    if (r === -1) return;
    if (r < this.scrollTop) this.scrollTop = r;
    if (r >= this.scrollTop + this.listH) this.scrollTop = r - this.listH + 1;
    if (this.scrollTop < 0) this.scrollTop = 0;
  }

  setStatus(msg, ms = 2500) {
    this.statusMsg = msg;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { this.statusMsg = ''; this.render(); }, ms);
  }

  reloadAll() {
    const keep = this.selectedSession()?.sessionId;
    this.all = loadSessions(this.opts);
    this._previewCache.clear();
    this.rebuild();
    this.selectById(keep);
  }

  selectById(sessionId) {
    if (!sessionId) return;
    const idx = this.sessionItems().findIndex(i => i.session.sessionId === sessionId);
    if (idx >= 0) { this.selIdx = idx; this.ensureVisible(); }
  }

  _doMove(targetDirName, targetRawPath = null) {
    const s = this.selectedSession();
    this.mode = null;
    if (!s) return;
    const targetConfig = this.movePicker.config;
    try {
      moveSession(s, targetConfig, targetDirName, targetRawPath);
      this.reloadAll();
      this.selectById(s.sessionId);
      this.setStatus(`Moved to [${path.basename(targetConfig)}]`);
    } catch (e) {
      this.setStatus(`Move failed: ${e.message}`, 5000);
    }
  }

  _open(plan, forceHere = false) {
    const r = forceHere ? { here: true } : launchInTab(plan);
    if (r.here) {
      if (!fs.existsSync(plan.cwd)) { this.setStatus(`Folder not found: ${plan.cwd}`, 5000); return; }
      this.suspend();
      const res = runHere(plan);
      this.resume();
      if (!res.ok) this.setStatus(res.msg, 5000);
      return;
    }
    this.setStatus(r.ok ? `Opened "${plan.title}" in new tab` : r.msg, r.ok ? 2500 : 5000);
  }

  _doNew(projectPath) {
    this.mode = null;
    if (!projectPath) return;
    this._open(newPlan(this.newPicker.config, projectPath));
  }

  _deleteTargets() {
    if (this.marked.size) return this.all.filter(s => this.marked.has(s.jsonlPath));
    const s = this.selectedSession();
    return s ? [s] : [];
  }

  _doDelete() {
    const targets = this._deleteTargets();
    const failed = [];
    for (const s of targets) {
      try { deleteSessionFiles(s); } catch (e) { failed.push(e.message); }
    }
    const gone = new Set(targets.map(s => s.jsonlPath));
    this.all = this.all.filter(x => !gone.has(x.jsonlPath) || fs.existsSync(x.jsonlPath));
    this.marked.clear();
    this.rebuild();
    this.setStatus(failed.length
      ? `Delete failed for ${failed.length}: ${failed[0]}`
      : `Moved ${targets.length} session(s) to trash — run with --empty-trash to free space`, 4000);
  }

  // ── Preview ─────────────────────────────────────────────────────────────────

  _previewLines(s, W, H) {
    const key = s.jsonlPath + ':' + s.lastModified.valueOf();
    let msgs = this._previewCache.get(key);
    if (!msgs) { msgs = readRecentMessages(s.jsonlPath); this._previewCache.set(key, msgs); }
    const lines = [];
    for (const m of msgs) {
      const tag = m.role === 'user' ? fgc('92', 'you ') : fgc('96', 'cc  ');
      const width = Math.max(10, W - 8);
      const chunks = wrapWords(m.text, width);
      chunks.slice(0, 3).forEach((c, i) => lines.push(`  ${i === 0 ? tag : '    '} ${i === 2 && chunks.length > 3 ? trunc(c, width - 1) + '…' : c}`));
    }
    if (!lines.length) lines.push(dim('  (no messages)'));
    return lines.slice(-H);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render() {
    const W = this.w, H = this.h;
    const out = [hideCursor, altBuf, clrScreen, mv(1, 1)];

    const filterInfo = this.filterPath ? `  path:${shortenPath(this.filterPath)}` : '';
    const searchInfo = this.search     ? `  search:${this.search}`   : '';
    const sortInfo   = this.sort !== 'date' ? `  sort:${this.sort}` : '';
    out.push(bgc('44', bold(fgc('97', pad(trunc(`  claude-sessions${filterInfo}${searchInfo}${sortInfo}`, W), W)))));

    if (this.mode === 'move') {
      this.movePicker.render(out, W, H);
    } else if (this.mode === 'new') {
      this.newPicker.render(out, W, H);
    } else if (this.mode === 'help') {
      HELP.forEach(([k, d], i) => out.push(mv(i + 3, 1), clrLine, `  ${fgc('93', pad(k, 14))}${d}`));
      out.push(mv(HELP.length + 4, 1), dim('  Env: CLAUDE_SESSIONS_TERMINAL, CLAUDE_SESSIONS_OPEN_CMD, CLAUDE_CONFIG_DIR'));
    } else {
      this._renderList(out, W);
      if (this.preview) this._renderPreview(out, W);
    }

    out.push(mv(H, 1));
    out.push(bgc('40', fgc('37', pad(trunc(this._footer(W), W), W))));
    process.stdout.write(out.join(''));
  }

  _renderList(out, W) {
    const visible = this.items.slice(this.scrollTop, this.scrollTop + this.listH);
    let si = this.items.slice(0, this.scrollTop).filter(i => i.type === 'session').length;

    for (let r = 0; r < this.listH; r++) {
      out.push(mv(r + 2, 1), clrLine);
      const item = visible[r];
      if (!item) continue;

      if (item.type === 'config') {
        out.push(bold(fgc('96', `  [${item.label}]`)));
        continue;
      }
      const s        = item.session;
      const isSel    = si === this.selIdx;
      const mark     = this.marked.has(s.jsonlPath) ? '●' : ' ';
      const title    = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
      const project  = shortenPath(s.project);
      const meta     = `${fmtSize(s.size).padStart(5)}  ${fmtDate(s.lastModified)}`;
      const cfgTag   = this.search ? `[${shortConfig(s.configDir)}] ` : '';
      const avail    = Math.max(12, W - 2 - cfgTag.length - 2 - 2 - meta.length);
      const titleW   = Math.floor(avail * 0.55);
      const projectW = avail - titleW;

      if (isSel) {
        out.push(inv(pad(`${mark} ${cfgTag}${pad(trunc(title, titleW), titleW)}  ${pad(trunc(project, projectW), projectW)}  ${meta}`, W)));
      } else {
        out.push(
          fgc('91', mark) + ' ' + (cfgTag ? fgc('96', cfgTag) : '') +
          (s.title ? fgc('92', pad(trunc(title, titleW), titleW)) : dim(pad(trunc(title, titleW), titleW))) +
          `  ${fgc('33', pad(trunc(project, projectW), projectW))}` +
          `  ${dim(meta)}`
        );
      }
      si++;
    }
  }

  _renderPreview(out, W) {
    const top = this.listH + 2;
    out.push(mv(top, 1), clrLine, dim('─'.repeat(W)));
    const s = this.selectedSession();
    const lines = s ? this._previewLines(s, W, this.previewH - 1) : [];
    for (let r = 0; r < this.previewH - 1; r++) out.push(mv(top + 1 + r, 1), clrLine, lines[r] || '');
  }

  _footer(W) {
    const sel   = this.selectedSession();
    const total = this.sessionItems().length;
    const pick  = p => p.step === 'profile' ? `  ↑↓/jk=navigate  Enter=select profile  Esc=cancel`
                     : p.step === 'input'   ? `  Tab=complete path  Enter=confirm  Esc=back`
                     :                        `  ↑↓/jk=navigate  Enter=select  Esc=back`;
    switch (this.mode) {
      case 'delete': {
        const t = this._deleteTargets();
        const name = t.length > 1 ? `${t.length} sessions` : `"${trunc(sel?.title || sel?.firstMessage || 'this session', 35)}"`;
        return `  Move ${name} to trash?  y=yes  n/Esc=cancel`;
      }
      case 'move':   return pick(this.movePicker);
      case 'new':    return pick(this.newPicker);
      case 'search': return `  SEARCH: ${this.search}█  Esc=cancel  Enter=done`;
      case 'rename': return `  RENAME: ${this.renameInput}█  Enter=save  Esc=cancel`;
      case 'help':   return `  Press any key to close help`;
    }
    if (this.statusMsg) return `  ${this.statusMsg}`;
    const marks = this.marked.size ? `  ${this.marked.size} marked` : '';
    const ctx = sel ? `  ${dim(trunc(shortenPath(sel.project), Math.max(0, W - 80)))}` : '';
    return `  Enter=open o=here /=search p=preview r=rename m=move d=del ?=help q=quit  [${total}]${marks}${ctx}`;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  handleKey(key) {
    if (this.mode === 'help') { this.mode = null; return true; }

    if (this.mode === 'delete') {
      this.mode = null;
      if (key === 'y' || key === 'Y') this._doDelete();
      return true;
    }

    if (this.mode === 'move') {
      if (this.movePicker.handleKey(key) === false) this.mode = null;
      return true;
    }

    if (this.mode === 'new') {
      if (this.newPicker.handleKey(key) === false) this.mode = null;
      return true;
    }

    if (this.mode === 'search') {
      if      (key === '\x1b')                { this.mode = null; this.search = ''; this.rebuild(); }
      else if (key === '\r')                  { this.mode = null; }
      else if (key === '\x7f' || key === '\b') { this.search = this.search.slice(0, -1); this.rebuild(); }
      else if (isPrintable(key))              { this.search += key; this.rebuild(); }
      return true;
    }

    if (this.mode === 'rename') {
      if      (key === '\x1b')                { this.mode = null; }
      else if (key === '\x7f' || key === '\b') { this.renameInput = this.renameInput.slice(0, -1); }
      else if (key === '\r') {
        this.mode = null;
        const s = this.selectedSession();
        if (s && this.renameInput.trim()) {
          try { renameSession(s, this.renameInput); this.reloadAll(); this.setStatus(`Renamed to "${s.title}"`); }
          catch (e) { this.setStatus(`Rename failed: ${e.message}`, 5000); }
        }
      }
      else if (isPrintable(key))              { this.renameInput += key; }
      return true;
    }

    // Normal mode
    const total = this.sessionItems().length;
    const move  = (delta) => {
      this.selIdx = Math.max(0, Math.min(total - 1, this.selIdx + delta));
      this.ensureVisible();
    };
    const s = this.selectedSession();

    if (key === 'q' || key === '\x03') return false;

    if      (key === '/')    { this.mode = 'search'; }
    else if (key === '?')    { this.mode = 'help'; }
    else if (key === '\x1b') { this.search = ''; this.marked.clear(); this.rebuild(); }
    else if (key === '\r')   { if (s) this._open(resumePlan(s)); }
    else if (key === 'o')    { if (s) this._open(resumePlan(s), true); }
    else if (key === 'p')    { this.preview = !this.preview; this.ensureVisible(); }
    else if (key === 's')    { this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]; this.rebuild(); this.selectById(s?.sessionId); }
    else if (key === 'r')    { if (s) { this.renameInput = s.title || ''; this.mode = 'rename'; } }
    else if (key === ' ')    {
      if (s) { this.marked.has(s.jsonlPath) ? this.marked.delete(s.jsonlPath) : this.marked.add(s.jsonlPath); move(+1); }
    }
    else if (key === 'd')    { if (this._deleteTargets().length) this.mode = 'delete'; }
    else if (key === 'n')    { this.newPicker.enter(); this.mode = 'new'; }
    else if (key === 'm') {
      if (s) { this.movePicker.enter(); this.mode = 'move'; }
      else this.setStatus('No session selected.');
    }
    else if (key === '\x1b[A' || key === 'k') move(-1);
    else if (key === '\x1b[B' || key === 'j') move(+1);
    else if (key === '\x1b[5~')               move(-this.listH);
    else if (key === '\x1b[6~')               move(+this.listH);
    else if (key === 'g')                     { this.selIdx = 0; this.ensureVisible(); }
    else if (key === 'G')                     { this.selIdx = Math.max(0, total - 1); this.ensureVisible(); }

    return true;
  }

  // Hand the terminal to a child process, then take it back.
  suspend() {
    process.stdin.removeListener('data', this._onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(showCursor + normBuf);
  }

  resume() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this._onData);
    this.reloadAll();
  }

  cleanup() { process.stdout.write(showCursor + normBuf); }

  start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdout.on('resize', () => {
      this.w = process.stdout.columns;
      this.h = process.stdout.rows;
      this.ensureVisible();
      this.render();
    });

    this._onData = chunk => {
      for (const key of splitKeys(chunk)) {
        if (this.handleKey(key) === false) {
          this.cleanup();
          process.exit(0);
        }
      }
      this.render();
    };
    process.stdin.on('data', this._onData);
    this.render();

    process.on('exit',   () => this.cleanup());
    process.on('SIGTERM', () => { this.cleanup(); process.exit(0); });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printHelp() {
  const src   = fs.readFileSync(__filename, 'utf8');
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (match) console.log(match[0].replace(/\/\*\*|\*\//g, '').replace(/^ \* ?/gm, '').trim());
}

function main() {
  const opts = parseArgs();
  if (opts.version) { console.log(VERSION); return; }
  if (opts.help)    { printHelp(); return; }
  if (opts.noCache) cache.enabled = false;

  if (opts.emptyTrash) {
    const dirs = opts.dir ? [path.resolve(opts.dir)] : discoverConfigDirs();
    console.log(`Freed ${fmtSize(emptyTrash(dirs))}`);
    return;
  }

  const sessions = loadSessions(opts);

  if (opts.json) {
    const out = sessions.map(({ jsonlPath: _j, configDirPath: _c, ...rest }) => rest);
    console.log(JSON.stringify(out, null, 2));
  } else if (opts.list || !process.stdout.isTTY || !process.stdin.isTTY) {
    printList(sessions);
  } else {
    new TUI(sessions, opts).start();
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    encodePathToDir, projectDirNameFor, tabComplete, resolveProjectPath, moveSession, readSession,
    readRecentMessages, renameSession, deleteSessionFiles, emptyTrash, scanConfigDir, sortSessions,
    detectTerminal, parseArgs, fmtSize, splitKeys, wrapWords, cache,
  };
}
