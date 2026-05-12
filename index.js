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

function moveSession(session, targetConfigDirPath) {
  const projectDirName   = path.basename(path.dirname(session.jsonlPath));
  const targetProjectDir = path.join(targetConfigDirPath, 'projects', projectDirName);
  fs.mkdirSync(targetProjectDir, { recursive: true });

  const targetJsonl = path.join(targetProjectDir, path.basename(session.jsonlPath));
  fs.renameSync(session.jsonlPath, targetJsonl);

  const srcDir = session.jsonlPath.replace(/\.jsonl$/, '');
  try {
    if (fs.statSync(srcDir).isDirectory()) {
      fs.renameSync(srcDir, targetJsonl.replace(/\.jsonl$/, ''));
    }
  } catch {}

  // Mutate in place so the caller's reference stays valid
  session.configDir     = path.basename(targetConfigDirPath);
  session.configDirPath = targetConfigDirPath;
  session.jsonlPath     = targetJsonl;
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
      console.log(ansi('33', `  ${s.project}`));
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
    this.mode        = null;
    this.moveTargets = [];
    this.statusMsg   = '';
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

    if (this.search) {
      // Flat list in search mode — context shown inline per item
      this.items = filtered.map(s => ({ type: 'session', session: s }));
    } else {
      this.items = [];
      let lastConfig = null, lastProject = null;
      for (const s of filtered) {
        if (s.configDir !== lastConfig) {
          this.items.push({ type: 'config', label: s.configDir });
          lastConfig = s.configDir; lastProject = null;
        }
        if (s.project !== lastProject) {
          this.items.push({ type: 'project', label: s.project });
          lastProject = s.project;
        }
        this.items.push({ type: 'session', session: s });
      }
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

  // ── Render ──────────────────────────────────────────────────────────────────

  render() {
    const W = this.w;
    const out = [hideCursor, altBuf, clrScreen, mv(1, 1)];

    // Header
    const filterInfo = this.filterPath ? `  path:${this.filterPath}` : '';
    const searchInfo = this.search     ? `  search:${this.search}`   : '';
    out.push(bgc('44', bold(fgc('97', pad(trunc(`  claude-sessions${filterInfo}${searchInfo}`, W), W)))));

    // List
    const visible = this.items.slice(this.scrollTop, this.scrollTop + this.listH);
    let si = this.items.slice(0, this.scrollTop).filter(i => i.type === 'session').length;

    for (let r = 0; r < this.listH; r++) {
      out.push(mv(r + 2, 1), clrLine);
      const item = visible[r];
      if (!item) continue;

      if (item.type === 'config') {
        out.push(bold(fgc('96', `  [${item.label}]`)));

      } else if (item.type === 'project') {
        out.push(fgc('33', trunc(`    ${item.label}`, W)));

      } else {
        const s      = item.session;
        const isSel  = si === this.selIdx;
        const dateStr = fmtDate(s.lastModified);
        const dateW   = dateStr.length + 2;

        if (this.search) {
          // Search mode: [config] project › title  date
          const cfgLabel  = shortConfig(s.configDir);
          const projLabel = path.basename(s.project);
          const prefixLen = cfgLabel.length + 4 + projLabel.length + 3; // "[x] proj › "
          const titleW    = Math.max(4, W - prefixLen - dateW);
          const title     = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
          if (isSel) {
            const plain = `  [${cfgLabel}] ${projLabel} › ${trunc(title, titleW).padEnd(titleW)}  ${dateStr}`;
            out.push(inv(pad(plain, W)));
          } else {
            out.push(
              `  ${fgc('96', `[${cfgLabel}]`)} ${fgc('33', projLabel)} ${dim('›')} ` +
              (s.title ? fgc('92', trunc(title, titleW)) : dim(trunc(title, titleW))) +
              `  ${dim(dateStr)}`
            );
          }

        } else {
          // Grouped mode: title  date
          const titleW = Math.max(4, W - 6 - dateW);
          const title  = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
          if (isSel) {
            out.push(inv(pad(`    ${trunc(title, titleW).padEnd(titleW)}  ${dateStr}`, W)));
          } else {
            out.push(
              `    ` +
              (s.title ? fgc('92', pad(trunc(title, titleW), titleW)) : dim(pad(trunc(title, titleW), titleW))) +
              `  ${dim(dateStr)}`
            );
          }
        }
        si++;
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
      const choices = this.moveTargets.map((t, i) => `${i + 1}=${t.label}`).join('   ');
      footer = `  Move to:  ${choices}   Esc=cancel`;
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

    // Move target selection
    if (this.mode === 'move') {
      if (key === '\x1b' || key === 'n') { this.mode = null; return true; }
      const idx = parseInt(key, 10) - 1;
      if (idx >= 0 && idx < this.moveTargets.length) {
        const s = this.selectedSession();
        const target = this.moveTargets[idx];
        this.mode = null;
        if (s) {
          try {
            moveSession(s, target.configDirPath);
            this.setStatus(`Moved to [${target.label}]`);
            this.rebuild();
          } catch (e) {
            this.setStatus(`Move failed: ${e.message}`, 4000);
          }
        }
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
      const s = this.selectedSession();
      if (s) {
        const targets = discoverConfigDirs()
          .filter(d => d !== s.configDirPath)
          .map(d => ({ label: shortConfig(path.basename(d)), configDirPath: d }));
        if (targets.length) { this.moveTargets = targets; this.mode = 'move'; }
        else this.setStatus('No other config profiles found.');
      }
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
