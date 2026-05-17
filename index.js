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
 *   claude-sessions --version       Print version
 *   claude-sessions -h              Help
 *
 * TUI keys:
 *   ↑ ↓  j k        Navigate
 *   PgUp PgDn        Page up / down
 *   g G              Jump to top / bottom
 *   /                Search (shows [config] project inline)
 *   Esc              Clear search
 *   Enter            Open session in a new terminal tab
 *   m                Move session to another config profile
 *   d                Delete session
 *   q  Ctrl-C        Quit
 *
 * Environment variables:
 *   CLAUDE_SESSIONS_TERMINAL    Force terminal: kitty | wezterm | tmux
 *   CLAUDE_SESSIONS_OPEN_CMD    Custom open command (placeholders: %cmd% %title% %project%)
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawnSync } = require('child_process');

const VERSION = require('./package.json').version;

// ─── Config dir discovery ─────────────────────────────────────────────────────

/**
 * Auto-discover all ~/.claude* directories that contain a projects/ folder.
 * Sorted so ~/.claude comes last (it's the default/fallback profile).
 */
function discoverConfigDirs() {
  const home = os.homedir();
  try {
    return fs.readdirSync(home)
      .filter(n => n === '.claude' || n.startsWith('.claude-'))
      .map(n => path.join(home, n))
      .filter(d => {
        try { return fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'projects')); }
        catch { return false; }
      })
      .sort((a, b) => {
        const na = path.basename(a), nb = path.basename(b);
        if (na === '.claude') return 1;
        if (nb === '.claude') return -1;
        return na.localeCompare(nb);
      });
  } catch { return []; }
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dir: null,
    namedOnly: false,
    json: false,
    list: false,
    help: false,
    version: false,
    filterPath: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--dir')         opts.dir = args[++i];
    else if (a === '--named-only')            opts.namedOnly = true;
    else if (a === '--json')                  opts.json = true;
    else if (a === '--list')                  opts.list = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '-h' || a === '--help')    opts.help = true;
    else if (!a.startsWith('-'))              opts.filterPath = path.resolve(a);
  }
  return opts;
}

// ─── Session reading ──────────────────────────────────────────────────────────

function readSession(jsonlPath) {
  let title = null, firstUserMessage = null, cwd = null, timestamp = null;
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
        if (!firstUserMessage && r.type === 'user' && r.message?.content) {
          const c = r.message.content;
          const text = typeof c === 'string' ? c : (c.find?.(x => x.type === 'text')?.text ?? '');
          if (text) firstUserMessage = text.trim().replace(/\s+/g, ' ').slice(0, 80);
        }
        if (!cwd && r.cwd) cwd = r.cwd;
        if (!timestamp && r.timestamp) timestamp = r.timestamp;
      } catch { /* malformed line — skip */ }
    }
  } catch { /* unreadable file — return nulls */ }
  return { title, firstUserMessage, cwd, timestamp };
}

function scanConfigDir(configDir, filterPath) {
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const results = [];

  let projectEntries;
  try { projectEntries = fs.readdirSync(projectsDir); } catch { return []; }

  for (const pd of projectEntries) {
    const pdFull = path.join(projectsDir, pd);
    try { if (!fs.statSync(pdFull).isDirectory()) continue; } catch { continue; }

    let files;
    try {
      files = fs.readdirSync(pdFull)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const p = path.join(pdFull, f);
          return { file: f, mtime: fs.statSync(p).mtime, jsonlPath: p };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { continue; }

    for (const { file, mtime, jsonlPath } of files) {
      const { title, firstUserMessage, cwd, timestamp } = readSession(jsonlPath);
      const project = cwd || pd;
      if (filterPath && !project.startsWith(filterPath)) continue;
      results.push({
        configDir:     path.basename(configDir),
        configDirPath: configDir,
        project,
        sessionId:    file.replace('.jsonl', ''),
        title,
        firstMessage: firstUserMessage,
        lastModified: mtime,
        timestamp,
        jsonlPath,
      });
    }
  }
  return results.sort((a, b) => b.lastModified - a.lastModified);
}

function loadSessions(opts) {
  const dirs = opts.dir ? [path.resolve(opts.dir)] : discoverConfigDirs();
  if (dirs.length === 0) {
    process.stderr.write('No Claude Code config directories found in ~\n');
  }
  const all = dirs.flatMap(d => scanConfigDir(d, opts.filterPath));
  return opts.namedOnly ? all.filter(s => s.title) : all;
}

// ─── Session operations ───────────────────────────────────────────────────────

function deleteSessionFiles(session) {
  try { fs.unlinkSync(session.jsonlPath); } catch {}
  const dir = session.jsonlPath.replace(/\.jsonl$/, '');
  try {
    if (fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function moveSession(session, targetConfigDirPath, targetProjectDirName) {
  const srcProjectDirName = path.basename(path.dirname(session.jsonlPath));
  const destDirName       = targetProjectDirName || srcProjectDirName;
  const targetProjectDir  = path.join(targetConfigDirPath, 'projects', destDirName);
  fs.mkdirSync(targetProjectDir, { recursive: true });

  const targetJsonl = path.join(targetProjectDir, path.basename(session.jsonlPath));
  fs.renameSync(session.jsonlPath, targetJsonl);

  const srcDir = session.jsonlPath.replace(/\.jsonl$/, '');
  try {
    if (fs.statSync(srcDir).isDirectory()) {
      fs.renameSync(srcDir, targetJsonl.replace(/\.jsonl$/, ''));
    }
  } catch {}

  session.configDir     = path.basename(targetConfigDirPath);
  session.configDirPath = targetConfigDirPath;
  session.jsonlPath     = targetJsonl;
}

/** List project folders that exist in a config dir, with display paths from cwd. */
function listProjectFolders(configDirPath) {
  const projectsDir = path.join(configDirPath, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  try {
    return fs.readdirSync(projectsDir)
      .filter(d => { try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; } })
      .map(d => {
        let displayPath = d;
        try {
          const f = fs.readdirSync(path.join(projectsDir, d)).find(f => f.endsWith('.jsonl'));
          if (f) { const { cwd } = readSession(path.join(projectsDir, d, f)); if (cwd) displayPath = shortenPath(cwd); }
        } catch {}
        return { projectDirName: d, displayPath };
      })
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  } catch { return []; }
}

/** Encode an absolute path the same way Claude Code does for project dir names. */
function encodePathToDir(absPath) {
  return absPath.replace(/\//g, '-');
}

/** Shell-style Tab completion for directory paths. */
function tabComplete(input) {
  const expanded = input.replace(/^~/, os.homedir());
  const endsWithSlash = expanded.endsWith('/');
  const baseDir = endsWithSlash ? (expanded.slice(0, -1) || '/') : path.dirname(expanded);
  const prefix  = endsWithSlash ? '' : path.basename(expanded);

  let matches;
  try {
    matches = fs.readdirSync(baseDir)
      .filter(n => n.startsWith(prefix) && (() => { try { return fs.statSync(path.join(baseDir, n)).isDirectory(); } catch { return false; } })())
      .sort();
  } catch { return { completed: input, matches: [] }; }

  if (!matches.length) return { completed: input, matches: [] };

  if (matches.length === 1) {
    const completed = (path.join(baseDir, matches[0]) + '/').replace(os.homedir(), '~');
    return { completed, matches: [] };
  }

  // Multiple: find common prefix among match names
  let common = matches[0];
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < common.length && i < m.length && common[i] === m[i]) i++;
    common = common.slice(0, i);
  }

  if (common.length > prefix.length) {
    const completed = path.join(baseDir, common).replace(os.homedir(), '~');
    return { completed, matches: matches.map(m => m + '/') };
  }

  // No further completion — keep input unchanged, show options
  return { completed: input, matches: matches.map(m => m + '/') };
}

// ─── Terminal detection & open ────────────────────────────────────────────────

function detectTerminal() {
  const forced = process.env.CLAUDE_SESSIONS_TERMINAL;
  if (forced) return forced;
  if (process.env.KITTY_WINDOW_ID !== undefined) return 'kitty';
  if (process.env.WEZTERM_PANE    !== undefined) return 'wezterm';
  if (process.env.TMUX)                          return 'tmux';
  if (process.env.TERM_PROGRAM === 'iTerm.app')  return 'iterm2';
  return null;
}

function shellEsc(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function trySpawn(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return r.status === 0
    ? { ok: true }
    : { ok: false, msg: (r.stderr?.toString().trim() || `${cmd} exited with ${r.status}`) };
}

function openSession(session) {
  const projectPath = fs.existsSync(session.project) ? session.project : os.homedir();
  const title       = session.title || session.sessionId.slice(0, 8);
  const resumeCmd   = `CLAUDE_CONFIG_DIR=${shellEsc(session.configDirPath)} claude -r ${session.sessionId}`;
  const shellCmd    = `cd ${shellEsc(projectPath)} && ${resumeCmd}; exec $SHELL`;

  // User-supplied template takes priority
  const customTpl = process.env.CLAUDE_SESSIONS_OPEN_CMD;
  if (customTpl) {
    const expanded = customTpl
      .replace(/%cmd%/g,     shellEsc(shellCmd))
      .replace(/%title%/g,   shellEsc(title))
      .replace(/%project%/g, shellEsc(projectPath));
    const r = spawnSync('bash', ['-c', expanded], { stdio: 'ignore' });
    return r.status === 0 ? { ok: true } : { ok: false, msg: `Custom open command failed (exit ${r.status})` };
  }

  const term = detectTerminal();
  switch (term) {
    case 'kitty':
      return trySpawn('kitty', ['@', 'launch', '--type=tab', `--tab-title=${title}`, 'bash', '-i', '-c', shellCmd]);
    case 'wezterm':
      return trySpawn('wezterm', ['cli', 'spawn', '--', 'bash', '-i', '-c', shellCmd]);
    case 'tmux':
      return trySpawn('tmux', ['new-window', '-n', title.slice(0, 20), `bash -i -c ${shellEsc(shellCmd)}`]);
    default:
      return { ok: false, msg: 'Terminal not supported. Set CLAUDE_SESSIONS_OPEN_CMD or CLAUDE_SESSIONS_TERMINAL.' };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtDate(d) {
  return new Date(d).toLocaleString(undefined, { hour12: false });
}

/** .claude-main → main, .claude → default */
function shortConfig(configDir) {
  return path.basename(configDir).replace(/^\.claude-?/, '') || 'default';
}

/** Replace home dir prefix with ~ */
function shortenPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
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
    console.log(`    ${label}  ${ansi('2', fmtDate(s.lastModified))}`);
    console.log(ansi('2', `    id: ${s.sessionId}`));
  }
}

// ─── TUI ──────────────────────────────────────────────────────────────────────

const ESC = '\x1b';
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

// mode: null | 'search' | 'delete' | 'move'
class TUI {
  constructor(sessions, filterPath) {
    this.all         = sessions;
    this.filterPath  = filterPath || '';
    this.search      = '';
    this.mode          = null;  // null | 'search' | 'delete' | 'move'
    this.moveStep      = 'profile';  // 'profile' | 'folder' | 'input'
    this.moveItems     = [];   // current picker items (profile list or folder list)
    this.moveSelIdx    = 0;
    this.moveScroll    = 0;
    this.pendingConfig    = null; // config dir chosen in step 1
    this.moveInput        = '';   // typed path in input step
    this.moveCompletions  = [];   // Tab completion candidates shown below input
    this.statusMsg     = '';
    this._statusTimer = null;
    this.selIdx      = 0;
    this.scrollTop   = 0;
    this.items       = [];
    this.w = process.stdout.columns || 80;
    this.h = process.stdout.rows    || 24;
    this.rebuild();
  }

  get listH() { return this.h - 2; }

  // ── Item list ───────────────────────────────────────────────────────────────

  rebuild() {
    const q = this.search.toLowerCase();
    const filtered = q
      ? this.all.filter(s =>
          (s.title        || '').toLowerCase().includes(q) ||
          (s.firstMessage || '').toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q))
      : this.all;

    // Both modes: config section headers only; folder shown as column 2 per row
    this.items = [];
    let lastConfig = null;
    for (const s of filtered) {
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

  sessionItems() { return this.items.filter(i => i.type === 'session'); }
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

  _buildMoveItems() {
    const s = this.selectedSession();
    if (this.moveStep === 'profile') {
      return discoverConfigDirs()
        .map(d => ({
          type: 'profile',
          label: path.basename(d) + (d === s?.configDirPath ? '  (current)' : ''),
          configDirPath: d,
        }));
    }
    const sameLabel = (s ? shortenPath(s.project) : '') + '  (same as source)';
    return [
      { type: 'same',   label: sameLabel, dirName: null },
      ...listProjectFolders(this.pendingConfig).map(f => ({
        type: 'folder', label: f.displayPath, dirName: f.projectDirName,
      })),
      { type: 'new',    label: '[type a new path…]', dirName: null },
    ];
  }

  _enterMove() {
    this.moveStep   = 'profile';
    this.moveItems  = this._buildMoveItems();
    this.moveSelIdx = 0;
    this.moveScroll = 0;
    this.mode       = 'move';
  }

  _enterFolderStep(configDirPath) {
    this.pendingConfig = configDirPath;
    this.moveStep      = 'folder';
    this.moveItems     = this._buildMoveItems();
    this.moveSelIdx    = 0;
    this.moveScroll    = 0;
  }

  _doMove(targetDirName) {
    const s = this.selectedSession();
    if (!s) { this.mode = null; return; }
    const sessionId = s.sessionId;
    try {
      moveSession(s, this.pendingConfig, targetDirName);
      this.mode = null;
      this.rebuild();
      // Focus the moved session in its new position
      const idx = this.sessionItems().findIndex(i => i.session.sessionId === sessionId);
      if (idx >= 0) { this.selIdx = idx; this.ensureVisible(); }
      this.setStatus(`Moved to [${path.basename(this.pendingConfig)}]`);
    } catch (e) {
      this.mode = null;
      this.setStatus(`Move failed: ${e.message}`, 4000);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render() {
    const W = this.w;
    const out = [hideCursor, altBuf, clrScreen, mv(1, 1)];

    // Header
    const filterInfo = this.filterPath ? `  path:${this.filterPath}` : '';
    const searchInfo = this.search     ? `  search:${this.search}`   : '';
    out.push(bgc('44', bold(fgc('97', pad(trunc(`  claude-sessions${filterInfo}${searchInfo}`, W), W)))));

    // List
    if (this.mode === 'move') {
      // ── Move picker (full-screen, two-step: profile → folder/input) ───────────
      const s = this.selectedSession();
      const sessionLabel = s?.title || s?.firstMessage?.slice(0, 60) || s?.sessionId?.slice(0, 8) || '';

      // Row 2: session being moved
      out.push(mv(2, 1), clrLine);
      out.push(`  Moving: ` + (sessionLabel ? fgc('92', `"${trunc(sessionLabel, W - 12)}"`) : dim('(untitled)')));

      // Row 3: step subtitle
      out.push(mv(3, 1), clrLine);
      const divider = dim('─'.repeat(Math.max(0, W - 2)));
      if (this.moveStep === 'profile') {
        out.push(`  ` + bold('Select target profile') + `  ` + divider);
      } else {
        out.push(`  ` + bold('Select folder in ') + bold(fgc('96', `[${path.basename(this.pendingConfig)}]`)) + `  ` + divider);
      }

      // Row 4+: path input + Tab completion candidates (input step only)
      let listStart = 4;
      if (this.moveStep === 'input') {
        out.push(mv(4, 1), clrLine);
        out.push(`  ${fgc('93', 'New path:')} ${this.moveInput}█`);
        out.push(mv(5, 1), clrLine);

        if (this.moveCompletions.length > 1) {
          // Show completion candidates (read-only, just for reference)
          const cols = Math.max(1, Math.floor((W - 2) / 22));
          const rows = Math.ceil(this.moveCompletions.length / cols);
          for (let r = 0; r < Math.min(rows, this.h - 8); r++) {
            out.push(mv(r + 5, 1), clrLine);
            const row = this.moveCompletions.slice(r * cols, r * cols + cols)
              .map(n => pad(n, 22)).join(' ');
            out.push(`  ` + dim(row));
          }
          listStart = this.h; // no session list while completing
        } else {
          out.push(dim(`  Tab to complete path`));
          listStart = 6;
        }
      }

      // Scrollable item list
      const maxVis = this.h - listStart - 1;
      const items  = this.moveStep === 'input' ? [] : this.moveItems;
      if (this.moveSelIdx < this.moveScroll) this.moveScroll = this.moveSelIdx;
      if (this.moveSelIdx >= this.moveScroll + maxVis) this.moveScroll = this.moveSelIdx - maxVis + 1;

      for (let r = 0; r < maxVis; r++) {
        out.push(mv(listStart + r, 1), clrLine);
        const item = items[this.moveScroll + r];
        if (!item) continue;
        const isSel  = (this.moveScroll + r) === this.moveSelIdx;
        const label  = item.type === 'same'    ? dim(item.label)
                     : item.type === 'new'     ? fgc('93', item.label)
                     : item.type === 'profile' ? bold(fgc('96', item.label))
                     : fgc('33', item.label);
        const plain  = `    ${item.label}`;
        out.push(isSel ? inv(pad(plain, W)) : `    ${label}`);
      }

    } else {
      // ── Session list ──────────────────────────────────────────────────────────
      const visible = this.items.slice(this.scrollTop, this.scrollTop + this.listH);
      let si = this.items.slice(0, this.scrollTop).filter(i => i.type === 'session').length;

      for (let r = 0; r < this.listH; r++) {
        out.push(mv(r + 2, 1), clrLine);
        const item = visible[r];
        if (!item) continue;

        if (item.type === 'config') {
          out.push(bold(fgc('96', `  [${item.label}]`)));

        } else {
          const s       = item.session;
          const isSel   = si === this.selIdx;
          const title   = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
          const project = shortenPath(s.project);
          const dateStr = fmtDate(s.lastModified);

          const cfgTag  = this.search ? `[${shortConfig(s.configDir)}] ` : '';
          const cfgLen  = cfgTag.length;
          const dateW   = dateStr.length;
          const avail   = Math.max(12, W - 2 - cfgLen - 2 - 2 - dateW);
          const titleW  = Math.floor(avail * 0.5);
          const projectW = avail - titleW;

          if (isSel) {
            const plain = `  ${cfgTag}${trunc(title, titleW).padEnd(titleW)}  ${trunc(project, projectW).padEnd(projectW)}  ${dateStr}`;
            out.push(inv(pad(plain, W)));
          } else {
            out.push(
              `  ${this.search ? fgc('96', cfgTag) : ''}` +
              (s.title ? fgc('92', pad(trunc(title, titleW), titleW)) : dim(pad(trunc(title, titleW), titleW))) +
              `  ${fgc('33', pad(trunc(project, projectW), projectW))}` +
              `  ${dim(dateStr)}`
            );
          }
          si++;
        }
      }
    }

    // Footer
    out.push(mv(this.h, 1));
    const sel   = this.selectedSession();
    const total = this.sessionItems().length;
    let footer;

    if (this.mode === 'delete') {
      const name = sel?.title || sel?.firstMessage?.slice(0, 35) || 'this session';
      footer = `  Delete "${trunc(name, 35)}"?  y=yes  n/Esc=cancel`;
    } else if (this.mode === 'move') {
      if (this.moveStep === 'profile') footer = `  ↑↓/jk=navigate  Enter=select profile  Esc=cancel`;
      else if (this.moveStep === 'input') footer = `  Tab=complete path  Enter=confirm  Esc=back`;
      else footer = `  ↑↓/jk=navigate  Enter=select  Esc=back to profiles`;
    } else if (this.mode === 'search') {
      footer = `  SEARCH: ${this.search}█  Esc=cancel  Enter=done`;
    } else if (this.statusMsg) {
      footer = `  ${this.statusMsg}`;
    } else {
      const ctx = sel ? `  ${dim(trunc(sel.project, W - 45))}` : '';
      footer = `  ↑↓/jk=nav  /=search  Enter=open  m=move  d=del  q=quit  [${total}]${ctx}`;
    }

    out.push(bgc('40', fgc('37', pad(trunc(footer, W), W))));
    process.stdout.write(out.join(''));
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  handleKey(key) {
    // Delete confirmation
    if (this.mode === 'delete') {
      this.mode = null;
      if (key === 'y' || key === 'Y') {
        const s = this.selectedSession();
        if (s) {
          deleteSessionFiles(s);
          this.all = this.all.filter(x => x.sessionId !== s.sessionId);
          this.setStatus(`Deleted: ${s.title || s.sessionId.slice(0, 8)}`);
          this.rebuild();
        }
      }
      return true;
    }

    // Move picker (unified: profile → folder → input)
    if (this.mode === 'move') {
      if (this.moveStep === 'input') {
        if (key === '\x1b') {
          this.moveStep = 'folder'; this.moveCompletions = []; this.moveItems = this._buildMoveItems();
        } else if (key === '\t') {
          const { completed, matches } = tabComplete(this.moveInput || '~/');
          this.moveInput       = completed;
          this.moveCompletions = matches.length > 1 ? matches : [];
        } else if (key === '\x7f') {
          this.moveInput = this.moveInput.slice(0, -1);
          this.moveCompletions = [];
        } else if (key === '\r') {
          const raw = this.moveInput.trim();
          this.moveCompletions = [];
          if (raw) this._doMove(encodePathToDir(raw.replace(/^~/, os.homedir())));
          else     this.moveStep = 'folder';
        } else if (key.length === 1 && key >= ' ') {
          this.moveInput += key;
          this.moveCompletions = [];
        }
        return true;
      }

      // profile or folder step — arrow nav + Enter
      const navSize = this.moveItems.length;
      if (key === '\x1b') {
        if (this.moveStep === 'folder') { this.moveStep = 'profile'; this.moveItems = this._buildMoveItems(); this.moveSelIdx = 0; this.moveScroll = 0; }
        else { this.mode = null; }
        return true;
      }
      if (key === '\x1b[A' || key === 'k') { this.moveSelIdx = Math.max(0, this.moveSelIdx - 1); return true; }
      if (key === '\x1b[B' || key === 'j') { this.moveSelIdx = Math.min(navSize - 1, this.moveSelIdx + 1); return true; }
      if (key === '\r') {
        const item = this.moveItems[this.moveSelIdx];
        if (!item) return true;
        if (item.type === 'profile') { this._enterFolderStep(item.configDirPath); return true; }
        if (item.type === 'new')     { this.moveStep = 'input'; this.moveInput = '~/'; this.moveCompletions = []; return true; }
        this._doMove(item.dirName);
      }
      return true;
    }

    // Search input
    if (this.mode === 'search') {
      if (key === '\x1b') {
        this.mode = null; this.search = ''; this.rebuild();
      } else if (key === '\r') {
        this.mode = null;
      } else if (key === '\x7f') {
        this.search = this.search.slice(0, -1); this.rebuild();
      } else if (key.length === 1 && key >= ' ') {
        this.search += key; this.rebuild();
      }
      return true;
    }

    // Normal mode
    const total = this.sessionItems().length;
    const move  = (delta) => {
      this.selIdx = Math.max(0, Math.min(total - 1, this.selIdx + delta));
      this.ensureVisible();
    };

    if (key === 'q' || key === '\x03') return false;  // quit

    if      (key === '/')               this.mode = 'search';
    else if (key === '\x1b')            { this.search = ''; this.rebuild(); }
    else if (key === '\r') {
      const s = this.selectedSession();
      if (s) {
        const result = openSession(s);
        this.setStatus(result.ok
          ? `Opened "${s.title || s.sessionId.slice(0, 8)}" in new tab`
          : result.msg, result.ok ? 2500 : 5000);
      }
    }
    else if (key === 'd') { if (this.selectedSession()) this.mode = 'delete'; }
    else if (key === 'm') {
      if (this.selectedSession()) this._enterMove();
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

    this.render();

    process.stdin.on('data', key => {
      if (this.handleKey(key) === false) {
        this.cleanup();
        process.exit(0);
      }
      this.render();
    });

    process.on('exit', () => this.cleanup());
    process.on('SIGTERM', () => { this.cleanup(); process.exit(0); });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (match) console.log(match[0].replace(/\/\*\*|\*\//g, '').replace(/^ \* ?/gm, '').trim());
}

function main() {
  const opts = parseArgs();

  if (opts.version) { console.log(VERSION); return; }
  if (opts.help)    { printHelp(); return; }

  const sessions = loadSessions(opts);

  if (opts.json) {
    const out = sessions.map(({ jsonlPath: _j, configDirPath: _c, ...rest }) => rest);
    console.log(JSON.stringify(out, null, 2));
  } else if (opts.list || !process.stdout.isTTY) {
    printList(sessions);
  } else {
    new TUI(sessions, opts.filterPath).start();
  }
}

main();
