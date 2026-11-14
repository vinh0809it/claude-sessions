'use strict';

const fs   = require('fs');
const path = require('path');
const { screen, theme, G, bold, fg, bg, trunc, pad, styleHints } = require('../ansi');
const { strWidth } = require('../text');
const { fmtSize, shortenPath, shortConfig, groupOf } = require('../format');
const { projectDirNameFor } = require('../paths');
const { discoverConfigDirs } = require('../config');
const { loadSessions, listProjectFolders, SORTS, sortSessions } = require('../sessions');
const { deleteSessionFiles, listTrash, restoreFromTrash, deleteForever, emptyTrash, moveSession, renameSession } = require('../operations');
const { searchFiles } = require('../content-search');
const { pins } = require('../pins');
const { resumePlan, newPlan, launchInTab, runHere } = require('../launch');
const { settings } = require('../settings');
const { is, isPrintable, parseMouse } = require('./keys');
const { InputDecoder, PASTE } = require('./input');
const { LineInput } = require('./line-input');
const { Picker } = require('./picker');
const { queryBackground, themeFor } = require('./theme');
const { SettingsScreen } = require('./settings-screen');
const { TrashScreen } = require('./trash-screen');
const { HelpScreen } = require('./help-screen');
const { ListView, CONTENT_SEARCH_MIN } = require('./list-view');

const { moveTo, clearLine } = screen;

// Footer: actions on the left (most useful first; cut on narrow screens),
// screens on the right next to the session count.
const FOOTER_HINTS = ['Enter=open', '/=search', 'f=find', 'TAGS', 'd=delete', 'r=rename', 'm=move', 'p=preview', 'q=quit'];
const FOOTER_RIGHT = 't=trash  ,=settings  ?=help';

// Mouse (setting "mouse"): wheel scrolls, click selects, double-click opens,
// click a tag to filter. While it's on, selecting text needs Shift.
const WHEEL_STEP = 3;
// kitty can change the pointer shape (OSC 22): a hand over anything clickable.
// Not through tmux, which doesn't forward it.
const POINTER_SHAPES = process.env.KITTY_WINDOW_ID !== undefined && !process.env.TMUX;
// handleKey's result for pointer motion that changed nothing: skip the redraw.
const IDLE = 'idle';
const DOUBLE_CLICK_MS = 400;

const CONTENT_SEARCH_DELAY_MS = 250;
// How often the list is checked for new or changed sessions.
const REFRESH_MS = 3000;
// Below this size the UI shows a "too small" note instead of a broken layout.
const MIN_W = 40, MIN_H = 8;

const STATUS_MS = 2500;
const ERROR_MS  = 8000;

/**
 * The full-screen session browser.
 *
 * `items` is the rendered list: profile headers ({ type: 'config' }) interleaved
 * with sessions ({ type: 'session' }); `sessions` are its sessions in order and
 * `selIdx` indexes them. `tags` are the title prefixes ("keycloak/…") among
 * sessions matching the search, with counts; `tag` is the active one, or null.
 *
 * `mode` is null (browsing), a mode on the list (search, rename, delete), or
 * a full screen from `screens` (help, settings, trash, move, new), which all
 * share one interface: handleKey/clickRow (false closes), itemAt, hints,
 * render, and optionally moveSelection and cursorPosition.
 */
class App {
  constructor(sessions, opts = {}) {
    this.all        = sessions;
    this.opts       = opts;
    this.filterPath = opts.filterPath || '';
    this.mode       = null;
    this.search     = '';
    this.searchKind = 'text'; // "text": titles, first messages, folders ("/"); "grep": inside conversations ("f")
    this.tag        = null;
    this.tags       = [];
    this.sort       = settings.get('sort');
    this.preview    = settings.get('preview');
    this.marked     = new Set(); // jsonlPath
    this.items      = [];
    this.sessions   = [];
    this.selIdx     = 0;
    this.scrollTop  = 0;
    this.statusMsg  = '';
    this.statusIsError = false;
    this.hover      = null;  // what the mouse pointer is over: "row:<i>", "tag:<name>", "pick:<i>"
    this.focus      = 'list'; // 'list' or 'tags' (the sidebar, when shown)
    this._pointerAt = null;
    this.w = process.stdout.columns || 80;
    this.h = process.stdout.rows    || 24;

    this.searchField   = new LineInput();
    this.renameField   = new LineInput();
    this._statusTimer  = null;
    this.lastDeleted     = [];          // trash entries of the last delete, for undo
    this.contentMatches  = new Set();   // jsonlPaths whose conversation contains the search
    this.contentDetails  = new Map();   // jsonlPath → the matching messages, for the preview
    this.contentSearch   = null;        // { query, done, total } while searching conversations

    const configDirs = () => this.opts.dir ? [path.resolve(this.opts.dir)] : discoverConfigDirs();
    this.screens = {
      help:     new HelpScreen(settings.file),
      settings: new SettingsScreen(settings, (key, value) => this._applySetting(key, value)),
      trash:    new TrashScreen({
        load: () => listTrash(configDirs()),
        restore: (entry) => { restoreFromTrash(entry); this.reloadAll(); },
        deleteForever,
        deleteAll: () => { this.lastDeleted = []; return emptyTrash(configDirs()); },
      }),
      move: this._createMovePicker(),
      new:  this._createNewPicker(),
    };
    this.view = new ListView(this);
    this.rebuild();
  }

  /** Whether any session has a tag; the Tags panel is shown only then. */
  get hasTags()     { return this._hasTags; }
  get tagsFocused() { return this.focus === 'tags' && this.view.sidebarW > 0; }
  get listH()       { return this.view.listH; }
  /** The full screen being shown (help, settings, …), or null on the list. */
  get screen()      { return this.screens[this.mode] || null; }
  get tooSmall()    { return this.w < MIN_W || this.h < MIN_H; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._takeTerminal();
    this._decoder = new InputDecoder(keys => this._onKeys(keys));
    this._onData = chunk => this._decoder.feed(chunk);
    process.stdin.on('data', this._onData);
    // Keys typed meanwhile still reach the decoder, which drops the reply.
    Object.assign(theme, themeFor(await queryBackground()));

    process.stdout.on('resize', () => {
      this.w = process.stdout.columns;
      this.h = process.stdout.rows;
      this.ensureVisible();
      this.render();
    });
    const quit = (code) => { this.cleanup(); process.exit(code); };
    process.on('exit', () => this.cleanup());
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => quit(0));
    process.on('uncaughtException', (e) => {
      this.cleanup(); // back on the main screen first, so the error stays visible
      console.error(e);
      process.exit(1);
    });
    setInterval(() => this._refreshIfChanged(), REFRESH_MS);
    this.render();
  }

  _onKeys(keys) {
    let changed = false;
    for (const key of asPaste(keys)) {
      const result = !this.tooSmall ? this.handleKey(key) // only quitting works on a too-small screen
        : key === 'q' || is(key, 'CTRL_C') ? false : IDLE;
      if (result === false) { this.cleanup(); process.exit(0); }
      if (result !== IDLE) changed = true;
    }
    if (changed) this.render();
  }

  /** Hands the terminal to a child process. */
  suspend() {
    this._suspended = true;
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
    this._suspended = false;
    this._takeTerminal();
    this.reloadAll();
  }

  /** Alternate screen, bracketed paste and the mouse; undone by cleanup(). */
  _takeTerminal() {
    process.stdout.write(screen.altBuffer + screen.pasteOn);
    this._mouseOn();
    this._terminalTaken = true;
  }

  /** Gives the terminal back as it was. Safe to call more than once (exit runs it again). */
  cleanup() {
    if (!this._terminalTaken) return;
    this._terminalTaken = false;
    this._mouseOff();
    process.stdout.write(screen.pasteOff + screen.reset + screen.showCursor + screen.mainBuffer);
  }

  _mouseOn() {
    if (!settings.get('mouse')) return;
    process.stdout.write(screen.mouseOn + (POINTER_SHAPES ? screen.pointerPush : ''));
    this._pointerPushed = POINTER_SHAPES;
    this._pointer = 'default';
  }

  _mouseOff() {
    process.stdout.write(screen.mouseOff + (this._pointerPushed ? screen.pointerPop : ''));
    this._pointerPushed = false;
    this._pointerAt = null;
    this.hover = null;
  }

  // ── List state ──────────────────────────────────────────────────────────────

  /**
   * Recomputes tags and the list from `all`, the search and the tag. The
   * selected session stays selected if it's still listed; otherwise the
   * selection stays at the same position (`fallback: 'clamp'`) or goes to the
   * top (`'top'`, when the filter changed).
   */
  rebuild({ fallback = 'clamp' } = {}) {
    const keep = this.selectedSession()?.sessionId;
    const q = this.search.toLowerCase();
    const matches = this.searchKind === 'grep'
      ? s => this.contentMatches.has(s.jsonlPath) // filled in by the background search
      : s => (s.title || '').toLowerCase().includes(q) ||
             (s.firstMessage || '').toLowerCase().includes(q) ||
             s.project.toLowerCase().includes(q);
    const searched = q ? this.all.filter(matches) : this.all;

    this._hasTags = this.all.some(s => groupOf(s.title));
    const counts = new Map();
    for (const s of searched) {
      const g = groupOf(s.title);
      if (g) counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (this.tag && !this.all.some(s => groupOf(s.title) === this.tag)) this.tag = null; // tag no longer exists
    if (this.tag && !counts.has(this.tag)) counts.set(this.tag, 0);
    this.tags = [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    this.tagTotal = searched.length;

    // Width of the "[profile]" tag shown while searching, so the columns line up.
    this.cfgTagW = Math.max(0, ...this.all.map(s => strWidth(shortConfig(s.configDir)))) + 2;

    this.items = [];
    this.sessions = [];
    this._rowOf = [];
    let group = null;
    const shown = this.tag ? searched.filter(s => groupOf(s.title) === this.tag) : searched;
    for (const s of sortSessions(shown, this.sort, id => pins.has(id))) {
      if (s.configDir !== group?.label) {
        group = { type: 'config', label: s.configDir, count: 0 };
        this.items.push(group);
      }
      group.count++;
      this._rowOf.push(this.items.length);
      this.sessions.push(s);
      this.items.push({ type: 'session', session: s });
    }
    const kept = keep ? this.sessions.findIndex(s => s.sessionId === keep) : -1;
    this.selIdx = kept >= 0 ? kept
      : fallback === 'top' ? 0
      : Math.min(this.selIdx, Math.max(0, this.sessions.length - 1));
    this.ensureVisible();
  }

  selectedSession() { return this.sessions[this.selIdx] ?? null; }

  /** Moves the selection by `delta` sessions, clamped. */
  moveSelection(delta) {
    this.selIdx = Math.max(0, Math.min(this.sessions.length - 1, this.selIdx + delta));
    this.ensureVisible();
  }

  selectById(sessionId) {
    const idx = this.sessions.findIndex(s => s.sessionId === sessionId);
    if (idx >= 0) { this.selIdx = idx; this.ensureVisible(); }
  }

  /** Scrolls so the selected session's row is on screen, never past the end of the list. */
  ensureVisible() {
    const listH = this.listH;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.items.length - listH));
    const row = this._rowOf?.[this.selIdx];
    if (row === undefined) return;
    if (row < this.scrollTop) this.scrollTop = row;
    if (row >= this.scrollTop + listH) this.scrollTop = row - listH + 1;
    // Show the profile header above the first session too.
    if (this.selIdx === 0) this.scrollTop = 0;
  }

  /** Re-reads every session from disk, keeping the selection. */
  reloadAll() {
    this.all = loadSessions({ ...this.opts, quiet: true });
    this.view.clearCache();
    this.rebuild();
  }

  setStatus(msg, ms = STATUS_MS) { this._showStatus(msg, ms, false); }

  /** An error in the footer: red, marked with ✗, and shown longer. */
  setError(msg) { this._showStatus(msg, ERROR_MS, true); }

  _showStatus(msg, ms, isError) {
    this.statusMsg = msg;
    this.statusIsError = isError;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { this.statusMsg = ''; this.renderLater(); }, ms);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  _open(plan, forceHere = false) {
    if (!plan.cwd || !fs.existsSync(plan.cwd)) {
      this.setError(`Project folder not found: ${plan.cwd || shortenPath(this.selectedSession()?.project || '')}`);
      return;
    }
    const result = forceHere ? { here: true }
      : launchInTab(plan, { terminal: settings.get('terminal'), openCommand: settings.get('openCommand') });
    if (result.ok) { this.setStatus(`Opened "${plan.title}" in a new ${result.where || 'tab'}`); return; }
    if (result.fatal) { this.setError(result.msg); return; }
    // No tab support, or opening one failed (e.g. kitty remote control off,
    // macOS automation denied): run it here so Enter always opens the session.
    this.suspend();
    const run = runHere(plan);
    this.resume();
    if (!run.ok) this.setError(run.msg);
    else if (!result.here) this.setError(`Couldn't open a new tab (${result.msg}), so it ran here`);
  }

  _openSelected(forceHere = false) {
    const s = this.selectedSession();
    if (s) this._open(resumePlan(s), forceHere);
  }

  _doMove(targetFolderName, targetRawPath = null) {
    const s = this.selectedSession();
    this.mode = null;
    if (!s) return;
    const targetConfig = this.screens.move.config;
    try {
      moveSession(s, targetConfig, targetFolderName, targetRawPath);
      this.reloadAll();
      this.selectById(s.sessionId);
      this.setStatus(`Moved to [${path.basename(targetConfig)}]`);
    } catch (e) {
      this.setError(`Move failed: ${e.message}`);
    }
  }

  _doNew(projectPath) {
    this.mode = null;
    if (projectPath) this._open(newPlan(this.screens.new.config, projectPath));
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
      this.setError(`Rename failed: ${e.message}`);
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
    const size = fmtSize(targets.reduce((n, s) => n + s.size, 0));
    const failed = [], trashed = [];
    for (const s of targets) {
      try {
        trashed.push({
          configDirPath: s.configDirPath, folderName: path.basename(path.dirname(s.jsonlPath)),
          sessionId: s.sessionId, jsonlPath: deleteSessionFiles(s),
        });
      } catch (e) { failed.push(e.message); }
    }
    if (trashed.length) this.lastDeleted = trashed; // keep the previous undo when nothing was deleted
    const gone = new Set(targets.map(s => s.jsonlPath));
    this.all = this.all.filter(s => !gone.has(s.jsonlPath) || fs.existsSync(s.jsonlPath));
    this.marked.clear();
    this.rebuild();
    if (failed.length) this.setError(`Delete failed for ${failed.length}: ${failed[0]}`);
    else this.setStatus(`Moved ${targets.length} session(s) (${size}) to trash — u undoes; permanently delete them in t to free the space`, 6000);
  }

  /** Puts back the sessions of the last delete. */
  _undoDelete() {
    if (!this.lastDeleted.length) { this.setStatus('Nothing to undo.'); return; }
    const failed = [];
    for (const entry of this.lastDeleted) {
      try { restoreFromTrash(entry); } catch (e) { failed.push(e.message); }
    }
    const restored = this.lastDeleted.length - failed.length;
    this.lastDeleted = [];
    this.reloadAll();
    if (failed.length) this.setError(`Restored ${restored}, ${failed.length} failed: ${failed[0]}`);
    else this.setStatus(`Restored ${restored} session(s)`);
  }

  _togglePin() {
    const s = this.selectedSession();
    if (!s) return;
    try {
      const pinned = pins.toggle(s.sessionId);
      this.rebuild();
      this.setStatus(pinned ? 'Pinned' : 'Unpinned');
    } catch (e) {
      this.setError(`Couldn't save the pin: ${e.message}`);
    }
  }

  _toggleMark() {
    const s = this.selectedSession();
    if (!s) return;
    if (this.marked.has(s.jsonlPath)) this.marked.delete(s.jsonlPath);
    else this.marked.add(s.jsonlPath);
    this.moveSelection(+1);
  }

  /** Steps through All → most used tag → … → least used tag, `delta` at a time, wrapping around. */
  _cycleTag(delta) {
    if (!this.hasTags) return;
    const order = [null, ...this.tags.map(t => t.name)];
    const i = Math.max(0, order.indexOf(this.tag));
    this._selectTag(order[(i + delta + order.length) % order.length]);
  }

  _selectTag(name) {
    this.tag = name;
    this.rebuild({ fallback: 'top' });
  }

  /** A setting changed in the settings screen: apply what takes effect now. */
  _applySetting(key, value) {
    if (key === 'mouse') { if (value) this._mouseOn(); else this._mouseOff(); }
    if (key === 'tagsLayout') { this.focus = 'list'; this.ensureVisible(); }
  }

  _cycleSort() {
    this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
    this.rebuild();
  }

  // ── Background work ────────────────────────────────────────────────────────

  /** Redraws soon, unless a child process has the terminal. For results that arrive in the background. */
  renderLater() {
    if (this._suspended || this._renderQueued) return;
    this._renderQueued = true;
    setImmediate(() => { this._renderQueued = false; if (!this._suspended) this.render(); });
  }

  /**
   * After the "f" search text changes: once typing pauses, search inside the
   * conversations of all sessions and add the matches as they're found.
   * A newer query cancels the running search.
   */
  _scheduleContentSearch() {
    clearTimeout(this._contentTimer);
    this._contentAbort?.abort();
    this.contentMatches = new Set();
    this.contentDetails = new Map();
    this.contentSearch = null;
    const query = this.search.trim();
    if (this.searchKind !== 'grep' || query.length < CONTENT_SEARCH_MIN) return;
    this._contentTimer = setTimeout(() => this._runContentSearch(query), CONTENT_SEARCH_DELAY_MS);
  }

  async _runContentSearch(query) {
    const abort = new AbortController();
    this._contentAbort = abort;
    const files = this.all.map(s => s.jsonlPath);
    this.contentSearch = { query, done: 0, total: files.length };
    this.renderLater();
    await searchFiles(files, query, {
      signal: abort.signal,
      onMatch: (file, matches) => {
        if (abort.signal.aborted) return;
        this.contentMatches.add(file);
        this.contentDetails.set(file, matches);
        this.rebuild();
        this.renderLater();
      },
      onProgress: (done) => {
        if (abort.signal.aborted || !this.contentSearch) return;
        this.contentSearch.done = done;
        const now = Date.now(); // show progress a few times a second, not on every file
        if (now - (this._progressAt || 0) > 200) { this._progressAt = now; this.renderLater(); }
      },
    });
    if (abort.signal.aborted) return;
    this.contentSearch = null;
    this.renderLater();
  }

  /** Picks up new, changed and removed sessions (e.g. one being written by Claude right now). */
  _refreshIfChanged() {
    if (this._suspended || (this.mode !== null && this.mode !== 'search')) return;
    const fresh = loadSessions({ ...this.opts, quiet: true });
    const signature = list => list.map(s => `${s.jsonlPath}|${+s.lastModified}|${s.size}|${s.title || ''}`).join('\n');
    if (signature(fresh) === signature(this.all)) return;
    this.all = fresh;
    this.view.clearCache();
    this.rebuild();
    this.render();
  }

  // ── Pickers ─────────────────────────────────────────────────────────────────

  _createMovePicker() {
    return new Picker({
      headerLabel: () => {
        const s = this.selectedSession();
        const label = s?.title || s?.firstMessage?.slice(0, 60) || s?.sessionId?.slice(0, 8) || '';
        return 'Moving: ' + (label ? fg('92', `"${trunc(label, this.w - 12)}"`) : '(untitled)');
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
        if (!fs.existsSync(absPath)) return `Folder not found: ${shortenPath(absPath)} (create it first)`;
        let folderName;
        try { folderName = projectDirNameFor(this.screens.move.config, absPath); }
        catch (e) { return e.message; }
        this._doMove(folderName, absPath);
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
      onConfirmCustom: (absPath) => {
        if (!fs.existsSync(absPath)) return `Folder not found: ${shortenPath(absPath)} (create it first)`;
        this._doNew(absPath);
      },
    });
  }

  /** Shows a full screen (help, settings, trash, move, new). */
  _openScreen(name) {
    this.screens[name].enter?.();
    this.mode = name;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  /** Returns false to quit, IDLE when nothing needs redrawing. */
  handleKey(key) {
    const mouse = parseMouse(key);
    if (mouse) return this._handleMouse(mouse);
    const scr = this.screen;
    if (scr) { if (scr.handleKey(key) === false) this.mode = null; return true; }
    switch (this.mode) {
      case 'delete': this.mode = null; if (key === 'y' || key === 'Y') this._doDelete(); return true;
      case 'search': this._handleSearchKey(key); return true;
      case 'rename': this._handleRenameKey(key); return true;
      default:       return this._handleBrowseKey(key);
    }
  }

  _handleMouse({ x, y, wheel, click, motion }) {
    if (this.tooSmall) return IDLE; // nothing to click on the "too small" note
    this._pointerAt = { x, y };
    if (motion) return this._updateHover() ? true : IDLE;
    this._handleButton(x, y, wheel, click);
    this._updateHover();
    return true;
  }

  /** What the pointer is over and can be clicked: "row:<item>", "tag:<name>", "pick:<i>", or null. */
  _hoverAt(x, y) {
    const scr = this.screen;
    if (scr) { const i = scr.itemAt(y); return i >= 0 ? `pick:${i}` : null; }
    if (this.mode !== null && this.mode !== 'search') return null;
    return this.view.hitAt(x, y);
  }

  /** Recomputes what's under the pointer and updates the pointer shape. Returns true if it changed. */
  _updateHover() {
    const hover = this._pointerAt && !this.tooSmall ? this._hoverAt(this._pointerAt.x, this._pointerAt.y) : null;
    if (hover === this.hover) return false;
    this.hover = hover;
    const picked = hover?.startsWith('pick:') ? Number(hover.slice(5)) : -1;
    for (const [name, scr] of Object.entries(this.screens)) scr.hover = name === this.mode ? picked : -1;
    const shape = hover ? 'pointer' : 'default';
    if (this._pointerPushed && shape !== this._pointer) {
      process.stdout.write(screen.pointerShape(shape));
      this._pointer = shape;
    }
    return true;
  }

  _handleButton(x, y, wheel, click) {
    const now = Date.now();
    const last = this._lastClick;
    const double = click && last && last.x === x && last.y === y && now - last.time < DOUBLE_CLICK_MS;
    if (click) this._lastClick = double ? null : { x, y, time: now };

    const scr = this.screen;
    if (scr) {
      if (wheel) scr.moveSelection?.(wheel * (this.mode === 'settings' ? 1 : WHEEL_STEP));
      else if (click && scr.clickRow(y, double) === false) this.mode = null;
      return;
    }
    if (this.mode !== null && this.mode !== 'search') return;
    if (wheel) { this.moveSelection(wheel * WHEEL_STEP); return; }
    if (!click) return;
    const hit = this.view.hitAt(x, y);
    if (hit?.startsWith('tag:')) {
      const name = hit.slice(4) === 'null' ? null : hit.slice(4);
      if (name !== this.tag) this._selectTag(name);
    } else if (hit?.startsWith('row:')) {
      this.selIdx = this._rowOf.indexOf(Number(hit.slice(4)));
      if (double) { this.mode = null; this._openSelected(); }
    }
  }

  /** Opens the search field; switching between "/" and "f" starts from an empty query. */
  _startSearch(kind) {
    if (kind !== this.searchKind) {
      this.searchKind = kind;
      this.search = '';
      this._scheduleContentSearch();
      this.rebuild();
    }
    this.searchField.set(this.search);
    this.mode = 'search';
  }

  _handleSearchKey(key) {
    if      (is(key, 'ESCAPE'))    { this.mode = null; this.search = ''; this._scheduleContentSearch(); this.rebuild(); }
    else if (is(key, 'TAB'))       { this.mode = null; }
    // In the "f" popup Enter just closes it, keeping the results to browse.
    else if (is(key, 'ENTER')) {
      this.mode = null;
      if (this.searchKind !== 'grep') this._openSelected();
      else if (this.contentMatches.size) { this.preview = true; this.ensureVisible(); } // to show where it matched
    }
    else if (is(key, 'UP'))        this.moveSelection(-1);
    else if (is(key, 'DOWN'))      this.moveSelection(+1);
    else if (is(key, 'PAGE_UP'))   this.moveSelection(-this.listH);
    else if (is(key, 'PAGE_DOWN')) this.moveSelection(+this.listH);
    else if (this.searchField.handle(key) && this.searchField.text !== this.search) {
      this.search = this.searchField.text;
      this._scheduleContentSearch(); // clears the old matches before the list is rebuilt
      this.rebuild({ fallback: 'top' });
    }
  }

  _handleRenameKey(key) {
    if      (is(key, 'ESCAPE')) this.mode = null;
    else if (is(key, 'ENTER'))  this._doRename();
    else this.renameField.handle(key);
  }

  /**
   * Keys while the Tags sidebar has focus: ↑↓ choose a tag (the list filters
   * as you go); →, Enter, Tab or Esc go back to the sessions. Returns false for
   * keys it leaves to the normal handler.
   */
  _handleTagsKey(key) {
    if (is(key, 'UP') || key === 'k') this._cycleTag(-1);
    else if (is(key, 'DOWN') || key === 'j') this._cycleTag(+1);
    else if (is(key, 'RIGHT') || key === 'l' || is(key, 'ENTER') || is(key, 'TAB') || is(key, 'ESCAPE')) this.focus = 'list';
    else if (is(key, 'LEFT') || key === 'h') { /* already at the leftmost panel */ }
    else return false;
    return true;
  }

  _handleBrowseKey(key) {
    const s = this.selectedSession();
    if (key === 'q' || is(key, 'CTRL_C')) return false;
    if (this.tagsFocused && this._handleTagsKey(key)) return true;
    // With the sidebar shown, ← and Tab move to it; otherwise ← → step through the tags.
    const sidebar = this.view.sidebarW > 0;

    if      (key === '/')                   this._startSearch('text');
    else if (key === 'f')                   this._startSearch('grep');
    else if (key === '?')                   this._openScreen('help');
    else if (key === ',')                   this._openScreen('settings');
    else if (key === 't')                   this._openScreen('trash');
    else if (key === 'n')                   this._openScreen('new');
    else if (key === 'm')                   { if (s) this._openScreen('move'); else this.setStatus('No session selected.'); }
    else if (is(key, 'ESCAPE'))             { this.search = ''; this.tag = null; this.marked.clear(); this._scheduleContentSearch(); this.rebuild(); }
    else if (key === 'u')                   this._undoDelete();
    else if (is(key, 'ENTER'))              this._openSelected();
    else if (key === 'o')                   this._openSelected(true);
    else if (key === 'F')                   { if (s) this._open(resumePlan(s, { fork: true })); }
    else if (key === '*')                   this._togglePin();
    else if (key === 'p')                   { this.preview = !this.preview; this.ensureVisible(); }
    else if (key === 's')                   this._cycleSort();
    else if (key === 'r')                   { if (s) { this.renameField.set(s.title || ''); this.mode = 'rename'; } }
    else if (key === ' ')                   this._toggleMark();
    else if (key === 'd')                   { if (this._deleteTargets().length) this.mode = 'delete'; }
    else if (sidebar && (is(key, 'LEFT') || key === 'h' || is(key, 'TAB'))) this.focus = 'tags';
    else if (!sidebar && (is(key, 'LEFT') || key === 'h'))  this._cycleTag(-1);
    else if (!sidebar && (is(key, 'RIGHT') || key === 'l')) this._cycleTag(+1);
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
    this._updateHover(); // the list may have moved under a still pointer
    const W = this.w, H = this.h;
    const out = [screen.syncStart, screen.hideCursor];
    for (let row = 1; row <= H; row++) out.push(moveTo(row, 1), clearLine);
    if (this.tooSmall) {
      const note = [`Terminal too small (${W}×${H})`, `Make it at least ${MIN_W}×${MIN_H}`, 'q quits'];
      note.forEach((t, i) => out.push(moveTo(Math.max(1, Math.floor(H / 2) - 1 + i), Math.max(1, Math.floor((W - strWidth(t)) / 2) + 1)), trunc(t, W)));
      process.stdout.write(out.join('') + screen.syncEnd);
      return;
    }

    const filterInfo = this.filterPath ? `  path:${shortenPath(this.filterPath)}` : '';
    const cs = this.contentSearch;
    const searchInfo = !this.search ? ''
      : this.searchKind === 'grep'
        ? `  find in chats:${this.search}${cs ? `  (searching ${cs.done}/${cs.total}…)` : `  (${this.contentMatches.size} found)`}`
        : `  search:${this.search}`;
    const sortInfo   = this.sort !== 'date' ? `  sort:${this.sort}` : '';
    out.push(moveTo(1, 1), bg('44', bold(fg('97', pad(`  claude-sessions${filterInfo}${searchInfo}${sortInfo}`, W)))));

    const scr = this.screen;
    if (scr) scr.render(out, W, H);
    else this.view.render(out, W, H);

    out.push(moveTo(H, 1), this._renderFooter(W));
    const cursor = this._cursorPosition();
    if (cursor) out.push(moveTo(cursor[0], Math.min(W, cursor[1])), screen.showCursor);
    process.stdout.write(out.join('') + screen.syncEnd);
  }

  _renderFooter(W) {
    if (!this.mode && this.statusMsg) {
      return this.statusIsError
        ? bold(fg('91', trunc(`  ${G.cross} ${this.statusMsg}`, W)))
        : fg('93', trunc(`  ${this.statusMsg}`, W));
    }
    // A text field in the footer: its label, the text as typed, then the hints.
    const field = this._footerField();
    if (field) {
      const head = `  ${field.label}: `;
      const text = trunc(field.input.text, Math.max(0, W - 1 - strWidth(head) - 1));
      return `  ${bold(fg('93', field.label + ':'))} ${text}` +
        styleHints(trunc(`   ${field.hints}`, Math.max(0, W - 1 - strWidth(head) - strWidth(text))));
    }
    return styleHints(trunc(this._footerText(W), W));
  }

  /** The footer's text field (search or rename), or null. */
  _footerField() {
    if (this.mode === 'search' && this.searchKind !== 'grep') {
      return { label: 'SEARCH', input: this.searchField, hints: '↑↓=select  Enter=open  Tab=keep filter  Esc=cancel' };
    }
    if (this.mode === 'rename') return { label: 'RENAME', input: this.renameField, hints: 'Enter=save  Esc=cancel' };
    return null;
  }

  /** Footer as "key=label" hints; _renderFooter styles them. */
  _footerText(W) {
    if (this.screen) return this.screen.hints();
    if (this.mode === 'delete') {
      const targets = this._deleteTargets();
      const t = targets[0];
      const name = targets.length > 1
        ? `${targets.length} sessions`
        : `"${trunc(t?.title || t?.firstMessage || 'this session', 35)}"`;
      return `  Move ${name} to trash?  y=delete  Esc=cancel`;
    }
    if (this.mode === 'search') return '  ↑↓=select in the list  Enter=done  Esc=cancel';

    const total = this.sessions.length;
    const count = `${total} session${total === 1 ? '' : 's'}${this.marked.size ? ` ${G.dot} ${this.marked.size} marked` : ''}  `;
    // Screens (trash, settings, help) sit on the right, apart from the actions,
    // unless the screen is too narrow for both.
    const right = W >= 70 ? `${FOOTER_RIGHT}   ${count}` : count;
    if (this.tagsFocused) {
      return '  ↑↓=choose tag  →/Enter=back to sessions  /=search  q=quit'.padEnd(Math.max(0, W - right.length)) + right;
    }
    const tagsHint = this.view.sidebarW ? '←=tags' : '←→=tag';
    const hints = FOOTER_HINTS.flatMap(h => h !== 'TAGS' ? [h] : this.hasTags ? [tagsHint] : []);
    let left = '';
    for (const hint of hints) {
      if (`${left}  ${hint}`.length + right.length + 2 > W) break;
      left += `  ${hint}`;
    }
    return left + ' '.repeat(Math.max(2, W - left.length - right.length)) + right;
  }

  /** Where to show the terminal cursor while a text field is active, else null. */
  _cursorPosition() {
    const field = this._footerField();
    if (field) return [this.h, strWidth(`  ${field.label}: `) + strWidth(field.input.before) + 1];
    if (this.mode === 'search') return this.view.findCursor();
    return this.screen?.cursorPosition?.() ?? null;
  }
}

/**
 * Keys from one read: when a terminal without bracketed paste delivers pasted
 * text, it comes as a burst of characters with Enter among them. Such a burst
 * becomes one PASTE key, so Enter or letters in it never run commands.
 */
function asPaste(keys) {
  if (keys.length < 4 || !keys.includes('\r') || keys.at(-1) === '\r' && keys.indexOf('\r') === keys.length - 1) return keys;
  if (!keys.every(k => k === '\r' || k === '\n' || k === '\t' || isPrintable(k))) return keys;
  return [PASTE + keys.join('')];
}

module.exports = { App, asPaste };
