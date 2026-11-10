'use strict';

const fs   = require('fs');
const path = require('path');
const { screen, bold, dim, fg, bg, trunc, pad, selectedLine, styleHints, groupTitle } = require('../ansi');
const { fmtDate, fmtAgo, fmtSize, shortenPath, shortConfig } = require('../format');
const { projectDirNameFor } = require('../paths');
const { discoverConfigDirs } = require('../config');
const { loadSessions, readRecentMessages, listProjectFolders, SORTS, sortSessions } = require('../sessions');
const { deleteSessionFiles, moveSession, renameSession } = require('../operations');
const { resumePlan, newPlan, launchInTab, runHere } = require('../launch');
const { is, splitKeys } = require('./keys');
const { LineInput } = require('./line-input');
const { Picker } = require('./picker');

const { moveTo, clearLine } = screen;

const HELP = [
  ['↑↓ / j k', 'Navigate'],          ['PgUp PgDn', 'Page up / down'],
  ['g / G', 'Top / bottom'],         ['/', 'Search (↑↓ select, Enter open, Tab keep filter)'],
  ['Esc', 'Clear search / marks'],   ['Enter', 'Open (new tab if supported, else here)'],
  ['o', 'Open in this terminal'],    ['p', 'Toggle preview'],
  ['r', 'Rename'],                   ['s', 'Sort: date / size / name'],
  ['Space', 'Mark for bulk delete'], ['n', 'New session'],
  ['m', 'Move to profile / folder'], ['d', 'Delete marked or selected (to trash)'],
  ['q / Ctrl-C', 'Quit'],
];

const FOOTER_HINTS = ['Enter=open', '/=search', 'p=preview', 'r=rename', 'm=move', 'd=delete', '?=more', 'q=quit'];

const STATUS_MS = 2500;
const ERROR_MS  = 5000;

/**
 * The full-screen session browser.
 *
 * `items` is the rendered list: profile headers ({ type: 'config' }) interleaved
 * with sessions ({ type: 'session' }). `selIdx` counts sessions only.
 * `mode` is null (browsing) or one of: search, rename, delete, move, new, help.
 */
class App {
  constructor(sessions, opts = {}) {
    this.all        = sessions;
    this.opts       = opts;
    this.filterPath = opts.filterPath || '';
    this.mode       = null;
    this.search     = '';
    this.sort       = 'date';
    this.preview    = false;
    this.marked     = new Set(); // jsonlPath
    this.items      = [];
    this.selIdx     = 0;
    this.scrollTop  = 0;
    this.statusMsg  = '';
    this.w = process.stdout.columns || 80;
    this.h = process.stdout.rows    || 24;

    this.searchField   = new LineInput();
    this.renameField   = new LineInput();
    this._statusTimer  = null;
    this._previewCache = new Map();
    this.movePicker    = this._createMovePicker();
    this.newPicker     = this._createNewPicker();
    this.rebuild();
  }

  get previewH() { return this.preview ? Math.max(4, Math.floor((this.h - 2) * 0.4)) : 0; }
  get listH()    { return this.h - 2 - this.previewH; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

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
        if (this.handleKey(key) === false) { this.cleanup(); process.exit(0); }
      }
      this.render();
    };
    process.stdin.on('data', this._onData);
    process.on('exit', () => this.cleanup());
    process.on('SIGTERM', () => { this.cleanup(); process.exit(0); });
    this.render();
  }

  /** Hands the terminal to a child process. */
  suspend() {
    process.stdin.removeListener('data', this._onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.cleanup();
  }

  /** Takes the terminal back after suspend(). */
  resume() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this._onData);
    this.reloadAll();
  }

  cleanup() { process.stdout.write(screen.showCursor + screen.mainBuffer); }

  // ── List state ──────────────────────────────────────────────────────────────

  rebuild() {
    const q = this.search.toLowerCase();
    const matches = s =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.firstMessage || '').toLowerCase().includes(q) ||
      s.project.toLowerCase().includes(q);

    this.items = [];
    let group = null;
    for (const s of sortSessions(q ? this.all.filter(matches) : this.all, this.sort)) {
      if (s.configDir !== group?.label) {
        group = { type: 'config', label: s.configDir, count: 0 };
        this.items.push(group);
      }
      group.count++;
      this.items.push({ type: 'session', session: s });
    }
    this.selIdx = Math.min(this.selIdx, Math.max(0, this.sessionCount() - 1));
    this.ensureVisible();
  }

  sessionItems()    { return this.items.filter(i => i.type === 'session'); }
  sessionCount()    { return this.sessionItems().length; }
  selectedSession() { return this.sessionItems()[this.selIdx]?.session ?? null; }

  /** Moves the selection by `delta` sessions, clamped. */
  moveSelection(delta) {
    this.selIdx = Math.max(0, Math.min(this.sessionCount() - 1, this.selIdx + delta));
    this.ensureVisible();
  }

  selectById(sessionId) {
    if (!sessionId) return;
    const idx = this.sessionItems().findIndex(i => i.session.sessionId === sessionId);
    if (idx >= 0) { this.selIdx = idx; this.ensureVisible(); }
  }

  /** Scrolls so the selected session's row is on screen. */
  ensureVisible() {
    let seen = -1;
    const row = this.items.findIndex(i => i.type === 'session' && ++seen === this.selIdx);
    if (row === -1) return;
    if (row < this.scrollTop) this.scrollTop = row;
    if (row >= this.scrollTop + this.listH) this.scrollTop = row - this.listH + 1;
    if (this.scrollTop < 0) this.scrollTop = 0;
  }

  /** Re-reads every session from disk, keeping the selection. */
  reloadAll() {
    const keep = this.selectedSession()?.sessionId;
    this.all = loadSessions(this.opts);
    this._previewCache.clear();
    this.rebuild();
    this.selectById(keep);
  }

  setStatus(msg, ms = STATUS_MS) {
    this.statusMsg = msg;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { this.statusMsg = ''; this.render(); }, ms);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  _open(plan, forceHere = false) {
    if (!plan.cwd || !fs.existsSync(plan.cwd)) {
      this.setStatus(`Project folder not found: ${plan.cwd || shortenPath(this.selectedSession()?.project || '')}`, ERROR_MS);
      return;
    }
    const result = forceHere ? { here: true } : launchInTab(plan);
    if (!result.here) {
      this.setStatus(result.ok ? `Opened "${plan.title}" in new tab` : result.msg, result.ok ? STATUS_MS : ERROR_MS);
      return;
    }
    this.suspend();
    const run = runHere(plan);
    this.resume();
    if (!run.ok) this.setStatus(run.msg, ERROR_MS);
  }

  _openSelected(forceHere = false) {
    const s = this.selectedSession();
    if (s) this._open(resumePlan(s), forceHere);
  }

  _doMove(targetFolderName, targetRawPath = null) {
    const s = this.selectedSession();
    this.mode = null;
    if (!s) return;
    const targetConfig = this.movePicker.config;
    try {
      moveSession(s, targetConfig, targetFolderName, targetRawPath);
      this.reloadAll();
      this.selectById(s.sessionId);
      this.setStatus(`Moved to [${path.basename(targetConfig)}]`);
    } catch (e) {
      this.setStatus(`Move failed: ${e.message}`, ERROR_MS);
    }
  }

  _doNew(projectPath) {
    this.mode = null;
    if (projectPath) this._open(newPlan(this.newPicker.config, projectPath));
  }

  _doRename() {
    this.mode = null;
    const s = this.selectedSession();
    const name = this.renameField.text;
    if (!s || !name.trim()) return;
    try {
      renameSession(s, name);
      this.reloadAll();
      this.setStatus(`Renamed to "${s.title}"`);
    } catch (e) {
      this.setStatus(`Rename failed: ${e.message}`, ERROR_MS);
    }
  }

  /** Marked sessions, or the selected one when nothing is marked. */
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
    this.all = this.all.filter(s => !gone.has(s.jsonlPath) || fs.existsSync(s.jsonlPath));
    this.marked.clear();
    this.rebuild();
    this.setStatus(failed.length
      ? `Delete failed for ${failed.length}: ${failed[0]}`
      : `Moved ${targets.length} session(s) to trash — run with --empty-trash to free space`, 4000);
  }

  _toggleMark() {
    const s = this.selectedSession();
    if (!s) return;
    if (this.marked.has(s.jsonlPath)) this.marked.delete(s.jsonlPath);
    else this.marked.add(s.jsonlPath);
    this.moveSelection(+1);
  }

  _cycleSort() {
    const keep = this.selectedSession()?.sessionId;
    this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
    this.rebuild();
    this.selectById(keep);
  }

  // ── Pickers ─────────────────────────────────────────────────────────────────

  _createMovePicker() {
    return new Picker({
      headerLabel: () => {
        const s = this.selectedSession();
        const label = s?.title || s?.firstMessage?.slice(0, 60) || s?.sessionId?.slice(0, 8) || '';
        return 'Moving: ' + (label ? fg('92', `"${trunc(label, this.w - 12)}"`) : dim('(untitled)'));
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
        const s          = this.selectedSession();
        const sameConfig = configDirPath === s?.configDirPath;
        const srcFolder  = s ? path.basename(path.dirname(s.jsonlPath)) : null;
        return [
          ...(sameConfig ? [] : [{ type: 'same', label: `${s ? shortenPath(s.project) : ''}  (keep same folder)`, dirName: null }]),
          ...listProjectFolders(configDirPath)
            .filter(f => !(sameConfig && f.projectDirName === srcFolder))
            .map(f => ({ type: 'folder', label: f.displayPath, dirName: f.projectDirName })),
          { type: 'new', label: '[type a new path…]', dirName: null },
        ];
      },
      onConfirmItem: (item) => this._doMove(item.dirName),
      onConfirmCustom: (absPath) => {
        if (!fs.existsSync(absPath)) {
          this.mode = null;
          this.setStatus(`Folder not found: ${absPath} (create it first)`, ERROR_MS);
          return;
        }
        try { this._doMove(projectDirNameFor(this.movePicker.config, absPath), absPath); }
        catch (e) { this.mode = null; this.setStatus(`Move failed: ${e.message}`, ERROR_MS); }
      },
    });
  }

  _createNewPicker() {
    return new Picker({
      headerLabel: fg('92', 'New session'),
      inputPrompt: 'Path:',
      buildProfileItems: () => discoverConfigDirs().map(d => ({ type: 'profile', label: path.basename(d), configDirPath: d })),
      buildFolderItems: (configDirPath) => [
        ...listProjectFolders(configDirPath).map(f => ({
          type: 'folder', label: f.displayPath, projectPath: f.projectPath,
        })),
        { type: 'new', label: '[type a new path…]', projectPath: null },
      ],
      onConfirmItem:   (item) => { if (item.projectPath) this._doNew(item.projectPath); },
      onConfirmCustom: (absPath) => this._doNew(absPath),
    });
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  /** Returns false to quit. */
  handleKey(key) {
    switch (this.mode) {
      case 'help':   this.mode = null; return true;
      case 'delete': this.mode = null; if (key === 'y' || key === 'Y') this._doDelete(); return true;
      case 'move':   if (this.movePicker.handleKey(key) === false) this.mode = null; return true;
      case 'new':    if (this.newPicker.handleKey(key) === false) this.mode = null; return true;
      case 'search': this._handleSearchKey(key); return true;
      case 'rename': this._handleRenameKey(key); return true;
      default:       return this._handleBrowseKey(key);
    }
  }

  _handleSearchKey(key) {
    if      (is(key, 'ESCAPE'))    { this.mode = null; this.search = ''; this.rebuild(); }
    else if (is(key, 'TAB'))       { this.mode = null; }
    else if (is(key, 'ENTER'))     { this.mode = null; this._openSelected(); }
    else if (is(key, 'UP'))        this.moveSelection(-1);
    else if (is(key, 'DOWN'))      this.moveSelection(+1);
    else if (is(key, 'PAGE_UP'))   this.moveSelection(-this.listH);
    else if (is(key, 'PAGE_DOWN')) this.moveSelection(+this.listH);
    else if (this.searchField.handle(key) && this.searchField.text !== this.search) {
      this.search = this.searchField.text;
      this.rebuild();
    }
  }

  _handleRenameKey(key) {
    if      (is(key, 'ESCAPE')) this.mode = null;
    else if (is(key, 'ENTER'))  this._doRename();
    else this.renameField.handle(key);
  }

  _handleBrowseKey(key) {
    const s = this.selectedSession();
    if (key === 'q' || is(key, 'CTRL_C')) return false;

    if      (key === '/')                   { this.searchField.set(this.search); this.mode = 'search'; }
    else if (key === '?')                   this.mode = 'help';
    else if (is(key, 'ESCAPE'))             { this.search = ''; this.marked.clear(); this.rebuild(); }
    else if (is(key, 'ENTER'))              this._openSelected();
    else if (key === 'o')                   this._openSelected(true);
    else if (key === 'p')                   { this.preview = !this.preview; this.ensureVisible(); }
    else if (key === 's')                   this._cycleSort();
    else if (key === 'r')                   { if (s) { this.renameField.set(s.title || ''); this.mode = 'rename'; } }
    else if (key === ' ')                   this._toggleMark();
    else if (key === 'd')                   { if (this._deleteTargets().length) this.mode = 'delete'; }
    else if (key === 'n')                   { this.newPicker.enter(); this.mode = 'new'; }
    else if (key === 'm')                   { if (s) { this.movePicker.enter(); this.mode = 'move'; } else this.setStatus('No session selected.'); }
    else if (is(key, 'UP')   || key === 'k') this.moveSelection(-1);
    else if (is(key, 'DOWN') || key === 'j') this.moveSelection(+1);
    else if (is(key, 'PAGE_UP'))            this.moveSelection(-this.listH);
    else if (is(key, 'PAGE_DOWN'))          this.moveSelection(+this.listH);
    else if (key === 'g')                   this.moveSelection(-Infinity);
    else if (key === 'G')                   this.moveSelection(+Infinity);
    return true;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  render() {
    const W = this.w, H = this.h;
    const out = [screen.hideCursor, screen.altBuffer, screen.clear, moveTo(1, 1)];

    const filterInfo = this.filterPath ? `  path:${shortenPath(this.filterPath)}` : '';
    const searchInfo = this.search ? `  search:${this.search}` : '';
    const sortInfo   = this.sort !== 'date' ? `  sort:${this.sort}` : '';
    out.push(bg('44', bold(fg('97', pad(trunc(`  claude-sessions${filterInfo}${searchInfo}${sortInfo}`, W), W)))));

    if (this.mode === 'move')      this.movePicker.render(out, W, H);
    else if (this.mode === 'new')  this.newPicker.render(out, W, H);
    else if (this.mode === 'help') this._renderHelp(out);
    else {
      this._renderList(out, W);
      if (this.preview) this._renderPreview(out, W);
    }

    out.push(moveTo(H, 1), clearLine, this._renderFooter(W));
    const cursor = this._cursorPosition();
    if (cursor) out.push(moveTo(cursor[0], Math.min(W, cursor[1])), screen.showCursor);
    process.stdout.write(out.join(''));
  }

  _renderHelp(out) {
    HELP.forEach(([k, d], i) => out.push(moveTo(i + 3, 1), clearLine, `  ${fg('93', pad(k, 14))}${d}`));
    out.push(moveTo(HELP.length + 4, 1),
      dim('  Env: CLAUDE_SESSIONS_TERMINAL, CLAUDE_SESSIONS_OPEN_CMD, CLAUDE_CONFIG_DIR, NO_COLOR'));
  }

  _renderList(out, W) {
    const visible = this.items.slice(this.scrollTop, this.scrollTop + this.listH);
    let sessionIdx = this.items.slice(0, this.scrollTop).filter(i => i.type === 'session').length;

    for (let r = 0; r < this.listH; r++) {
      out.push(moveTo(r + 2, 1), clearLine);
      const item = visible[r];
      if (!item) continue;
      if (item.type === 'config') { out.push(this._profileHeader(item, W)); continue; }
      out.push(this._sessionRow(item.session, sessionIdx === this.selIdx, W));
      sessionIdx++;
    }
  }

  /** "── .claude-work · 4 sessions ─────" */
  _profileHeader(group, W) {
    const count = `· ${group.count} session${group.count === 1 ? '' : 's'}`;
    const rule  = '─'.repeat(Math.max(0, W - group.label.length - count.length - 6));
    return dim('── ') + bold(fg('96', group.label)) + ' ' + dim(`${count} ${rule}`);
  }

  /** "▌● api/fix-login   ~/projects/api   3.2M   2h ago" */
  _sessionRow(s, isSelected, W) {
    const mark     = this.marked.has(s.jsonlPath) ? '●' : ' ';
    const title    = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
    const meta     = `${fmtSize(s.size).padStart(5)}  ${fmtAgo(s.lastModified).padStart(8)}`;
    const cfgTag   = this.search ? `[${shortConfig(s.configDir)}] ` : '';
    const avail    = Math.max(12, W - 3 - cfgTag.length - 4 - meta.length - 1);
    const titleW   = Math.floor(avail * 0.55);
    const titleTxt = pad(trunc(title, titleW), titleW);
    const projTxt  = pad(trunc(shortenPath(s.project), avail - titleW), avail - titleW);

    // On the selected line every part gets an explicit color (see selectedLine).
    const muted  = t => isSelected ? fg('37', t) : dim(t);
    const styled = fg('91', mark) + ' ' + (cfgTag ? fg('96', cfgTag) : '') +
      (s.title ? groupTitle(titleTxt, isSelected ? '1;92' : '92') : muted(titleTxt)) +
      `  ${fg('33', projTxt)}  ${muted(meta)}`;

    return isSelected
      ? selectedLine(styled, `${mark} ${cfgTag}${titleTxt}  ${projTxt}  ${meta}`, W)
      : ` ${styled}`;
  }

  _renderPreview(out, W) {
    const top = this.listH + 2;
    out.push(moveTo(top, 1), clearLine, dim('─'.repeat(W)));
    const s = this.selectedSession();
    const lines = s ? this._previewLines(s, W, this.previewH - 1) : [];
    for (let r = 0; r < this.previewH - 1; r++) out.push(moveTo(top + 1 + r, 1), clearLine, lines[r] || '');
  }

  /** Date/size/id header, then one line per recent message with a blank line between. */
  _previewLines(s, W, H) {
    const key = `${s.jsonlPath}:${s.lastModified.valueOf()}`;
    if (!this._previewCache.has(key)) this._previewCache.set(key, readRecentMessages(s.jsonlPath));
    const width = Math.max(10, W - 8);
    const lines = this._previewCache.get(key).flatMap(m => ['',
      `  ${m.role === 'user' ? fg('92', 'you ') : fg('96', 'cc  ')} ${trunc(m.text.replace(/\s+/g, ' ').trim(), width)}`]);
    const body = lines.slice(-(H - 2));
    if (body[0] === '') body.shift();
    const head = dim(`  ${fmtDate(s.lastModified)} · ${fmtSize(s.size)} · ${s.sessionId}`);
    return [head, '', ...(body.length ? body : [dim('  (no messages)')])];
  }

  _renderFooter(W) {
    if (!this.mode && this.statusMsg) return fg('93', trunc(`  ${this.statusMsg}`, W));
    return styleHints(trunc(this._footerText(W), W))
      .replace(/^  (SEARCH|RENAME):/, (_, label) => `  ${bold(fg('93', label + ':'))}`);
  }

  /** Footer as "key=label" hints; _renderFooter styles them. */
  _footerText(W) {
    switch (this.mode) {
      case 'delete': {
        const targets = this._deleteTargets();
        const s = this.selectedSession();
        const name = targets.length > 1
          ? `${targets.length} sessions`
          : `"${trunc(s?.title || s?.firstMessage || 'this session', 35)}"`;
        return `  Move ${name} to trash?  y=yes  n/Esc=cancel`;
      }
      case 'move':   return this.movePicker.hints();
      case 'new':    return this.newPicker.hints();
      case 'search': return `  SEARCH: ${this.searchField.text}   ↑↓=select  Enter=open  Tab=keep filter  Esc=cancel`;
      case 'rename': return `  RENAME: ${this.renameField.text}   Enter=save  Esc=cancel`;
      case 'help':   return '  Press any key to close help';
    }
    const total = this.sessionCount();
    const right = `${total} session${total === 1 ? '' : 's'}${this.marked.size ? ` · ${this.marked.size} marked` : ''}  `;
    let left = '';
    for (const hint of FOOTER_HINTS) {
      if (`${left}  ${hint}`.length + right.length + 2 > W) break;
      left += `  ${hint}`;
    }
    return left + ' '.repeat(Math.max(2, W - left.length - right.length)) + right;
  }

  /** Where to show the terminal cursor while a text field is active, else null. */
  _cursorPosition() {
    const inFooter = (label, field) => [this.h, `  ${label}: `.length + [...field.before].length + 1];
    switch (this.mode) {
      case 'search': return inFooter('SEARCH', this.searchField);
      case 'rename': return inFooter('RENAME', this.renameField);
      case 'move':   return this.movePicker.cursorPosition();
      case 'new':    return this.newPicker.cursorPosition();
      default:       return null;
    }
  }
}

module.exports = { App };
