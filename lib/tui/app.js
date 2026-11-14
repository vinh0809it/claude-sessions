'use strict';

const fs   = require('fs');
const path = require('path');
const { screen, theme, COLOR, bold, dim, inv, fg, bg, trunc, pad, selectedLine, hoverLine, hoverSpan, selectedColors, styleHints, groupTitle } = require('../ansi');
const { fmtDate, fmtAgo, fmtSize, shortenPath, shortConfig, groupOf } = require('../format');
const { projectDirNameFor } = require('../paths');
const { discoverConfigDirs } = require('../config');
const { loadSessions, readRecentMessages, listProjectFolders, SORTS, sortSessions } = require('../sessions');
const { deleteSessionFiles, listTrash, restoreFromTrash, deleteForever, emptyTrash, moveSession, renameSession } = require('../operations');
const { searchFiles } = require('../content-search');
const { sessionStats, fmtTokens } = require('../stats');
const { pins } = require('../pins');
const { resumePlan, newPlan, launchInTab, runHere } = require('../launch');
const { is, splitKeys, parseMouse } = require('./keys');
const { LineInput } = require('./line-input');
const { Picker } = require('./picker');
const { OSC_REPLY_RE, queryBackground, themeFor } = require('./theme');
const { SettingsScreen } = require('./settings-screen');
const { TrashScreen } = require('./trash-screen');
const { settings } = require('../settings');

const { moveTo, clearLine } = screen;
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const HELP = [
  ['↑↓ / j k', 'Navigate'],          ['PgUp PgDn', 'Page up / down'],
  ['g / G', 'Top / bottom'],         ['/', 'Search titles, first messages, folders'],
  ['f', 'Find text inside conversations (↑↓ select, Enter open, Tab keep filter)'],
  ['← → / h l', 'Choose a tag (side layout: ← to the Tags column, ↑↓ choose, → back)'],
  ['Esc', 'Clear search, tag and marks'], ['Enter', 'Open (new tab if supported, else here)'],
  ['o', 'Open in this terminal'],    ['p', 'Toggle preview'],
  ['F', 'Fork: resume as a new session, leaving this one as it is'],
  ['*', 'Pin / unpin (pinned stay on top)'],
  ['r', 'Rename'],                   ['s', 'Sort: date / size / name'],
  ['Space', 'Mark for bulk delete'], ['n', 'New session'],
  ['m', 'Move to profile / folder'], ['d', 'Delete marked or selected (to trash)'],
  ['u', 'Undo the last delete'],     ['t', 'Trash: restore, permanent delete, delete all'],
  ['q / Ctrl-C', 'Quit'],
  [',', 'Settings'],
  ['Mouse', 'Wheel scrolls, click selects, double-click opens'],
];

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

// Tags sidebar width, and the narrowest screen that still shows it.
const SIDEBAR_W = 22;
const SIDEBAR_MIN_SCREEN = 100;
// The Tags panel above the list wraps onto at most this many lines.
const TAG_PANEL_MAX_LINES = 3;
// The list keeps at least this many rows; the Tags panel and preview shrink first.
const MIN_LIST_ROWS = 3;
const TAG_GAP = 3; // spaces between tag columns

// "f" searches inside conversations once the query is this long, after a pause in typing.
const CONTENT_SEARCH_MIN = 2;
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
 * with sessions ({ type: 'session' }). `selIdx` counts sessions only.
 * `tags` are the title prefixes ("keycloak/…") among sessions matching the
 * search, with counts; `tag` is the active one, or null for all sessions.
 * `mode` is null (browsing) or one of: search, rename, delete, move, new, help.
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
    this.selIdx     = 0;
    this.scrollTop  = 0;
    this.statusMsg  = '';
    this.statusIsError = false;
    this.hover      = null;  // what the mouse pointer is over (see _hoverAt)
    this.focus      = 'list'; // 'list' or 'tags' (the sidebar, when shown)
    this._pointerAt = null;
    this.w = process.stdout.columns || 80;
    this.h = process.stdout.rows    || 24;

    this.searchField   = new LineInput();
    this.renameField   = new LineInput();
    this._statusTimer  = null;
    this._previewCache = new Map();
    this.settingsScreen = new SettingsScreen(settings, (key, value) => this._applySetting(key, value));
    const configDirs = () => this.opts.dir ? [path.resolve(this.opts.dir)] : discoverConfigDirs();
    this.trashScreen = new TrashScreen({
      load: () => listTrash(configDirs()),
      restore: (entry) => { restoreFromTrash(entry); this.reloadAll(); },
      deleteForever,
      deleteAll: () => { this.lastDeleted = []; return emptyTrash(configDirs()); },
    });
    this.lastDeleted     = [];          // trash entries of the last delete, for undo
    this.contentMatches  = new Set();   // jsonlPaths whose conversation contains the search
    this.contentDetails  = new Map();   // jsonlPath → the matching messages, for the preview
    this._statsCache     = new Map();   // "path:mtime" → token stats, or 'loading'
    this.contentSearch   = null;        // { query, done, total } while searching conversations
    this.movePicker    = this._createMovePicker();
    this.newPicker     = this._createNewPicker();
    this.rebuild();
  }

  /** Whether any session has a tag; the tag bar is shown only then. */
  get hasTags()  { return this._hasTags; }
  // Screen rows: title bar, [Tags panel], frame top, column titles, the list
  // from listTop, the preview, the frame bottom, the footer. With the "side"
  // tags layout on a wide screen, the Tags panel is a column on the left instead.
  get sidebarW() {
    return this.hasTags && settings.get('tagsLayout') === 'side' && this.w >= SIDEBAR_MIN_SCREEN ? SIDEBAR_W : 0;
  }
  /**
   * How many lines of tags the panel above the list may use: up to
   * TAG_PANEL_MAX_LINES, fewer on short screens, 0 (hidden) when there's no room.
   */
  get tagPanelLines() {
    if (!this.hasTags || this.sidebarW) return 0;
    const room = this.h - 4 - 2 - 1 - MIN_LIST_ROWS; // title, frame top + titles, panel borders, frame bottom… see listTop
    return Math.max(0, Math.min(TAG_PANEL_MAX_LINES, room - 1));
  }
  /** Rows of the Tags panel above the list (its lines plus two borders), or 0. */
  get tagPanelH() {
    const max = this.tagPanelLines;
    return max ? this._tagLines(this.w, max).shown.length + 2 : 0;
  }
  get listTop()  { return 4 + this.tagPanelH; }
  get tagsFocused() { return this.focus === 'tags' && this.sidebarW > 0; }
  /** Rows of the preview (with its divider): 40% of the screen, less if the list would get too short, 0 if it doesn't fit. */
  get previewH() {
    if (!this.preview) return 0;
    const fits = this.h - this.listTop - 1 - MIN_LIST_ROWS;
    const rows = Math.min(Math.max(4, Math.floor((this.h - 2) * 0.4)), fits);
    return rows >= 3 ? rows : 0;
  }
  get listH()    { return this.h - this.listTop - 1 - this.previewH; }  // rows up to the frame bottom at h-1

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    Object.assign(theme, themeFor(await queryBackground()));

    process.stdout.on('resize', () => {
      this.w = process.stdout.columns;
      this.h = process.stdout.rows;
      this.ensureVisible();
      this.render();
    });

    this._onData = chunk => {
      let changed = false;
      for (const key of splitKeys(chunk.replace(OSC_REPLY_RE, ''))) {
        const result = this.handleKey(key);
        if (result === false) { this.cleanup(); process.exit(0); }
        if (result !== IDLE) changed = true;
      }
      if (changed) this.render();
    };
    process.stdin.on('data', this._onData);
    process.on('exit', () => this.cleanup());
    process.on('SIGTERM', () => { this.cleanup(); process.exit(0); });
    this._mouseOn();
    setInterval(() => this._refreshIfChanged(), REFRESH_MS);
    this.render();
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
    this._mouseOn();
    this.reloadAll();
  }

  cleanup() {
    this._mouseOff();
    process.stdout.write(screen.showCursor + screen.mainBuffer);
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
    this.hover = null;
  }

  // ── List state ──────────────────────────────────────────────────────────────

  rebuild() {
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

    this.items = [];
    let group = null;
    const shown = this.tag ? searched.filter(s => groupOf(s.title) === this.tag) : searched;
    // Width of the "[profile]" tag shown while searching, so the columns line up.
    this._cfgTagW = Math.max(0, ...this.all.map(s => shortConfig(s.configDir).length)) + 2;
    for (const s of sortSessions(shown, this.sort, id => pins.has(id))) {
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
    this.all = loadSessions({ ...this.opts, quiet: true });
    this._previewCache.clear();
    this.rebuild();
    this.selectById(keep);
  }

  setStatus(msg, ms = STATUS_MS) {
    this._showStatus(msg, ms, false);
  }

  /** An error in the footer: red, marked with ✗, and shown longer. */
  setError(msg) {
    this._showStatus(msg, ERROR_MS, true);
  }

  _showStatus(msg, ms, isError) {
    this.statusMsg = msg;
    this.statusIsError = isError;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { this.statusMsg = ''; this.render(); }, ms);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  _open(plan, forceHere = false) {
    if (!plan.cwd || !fs.existsSync(plan.cwd)) {
      this.setError(`Project folder not found: ${plan.cwd || shortenPath(this.selectedSession()?.project || '')}`);
      return;
    }
    const result = forceHere ? { here: true }
      : launchInTab(plan, { terminal: settings.get('terminal'), openCommand: settings.get('openCommand') });
    if (result.ok) { this.setStatus(`Opened "${plan.title}" in new tab`); return; }
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
    const targetConfig = this.movePicker.config;
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
    const failed = [];
    this.lastDeleted = [];
    for (const s of targets) {
      try {
        const trashed = deleteSessionFiles(s);
        this.lastDeleted.push({
          configDirPath: s.configDirPath, folderName: path.basename(path.dirname(s.jsonlPath)),
          sessionId: s.sessionId, jsonlPath: trashed,
        });
      } catch (e) { failed.push(e.message); }
    }
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

  // ── Background work ────────────────────────────────────────────────────────

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
    this.render();
    await searchFiles(files, query, {
      signal: abort.signal,
      onMatch: (file, matches) => {
        this.contentMatches.add(file);
        this.contentDetails.set(file, matches);
        if (!this._suspended) this._rebuildKeepingSelection();
      },
      onProgress: (done) => {
        if (!this.contentSearch) return;
        this.contentSearch.done = done;
        const now = Date.now(); // show progress a few times a second, not on every file
        if (!this._suspended && now - (this._progressAt || 0) > 200) { this._progressAt = now; this.render(); }
      },
    });
    if (abort.signal.aborted) return;
    this.contentSearch = null;
    if (!this._suspended) this.render();
  }

  _rebuildKeepingSelection() {
    const keep = this.selectedSession()?.sessionId;
    this.rebuild();
    this.selectById(keep);
    this.render();
  }

  /** Picks up new, changed and removed sessions (e.g. one being written by Claude right now). */
  _refreshIfChanged() {
    if (this._suspended || (this.mode !== null && this.mode !== 'search')) return;
    const fresh = loadSessions({ ...this.opts, quiet: true });
    const signature = list => list.map(s => `${s.jsonlPath}|${+s.lastModified}|${s.size}|${s.title || ''}`).join('\n');
    if (signature(fresh) === signature(this.all)) return;
    this.all = fresh;
    this._previewCache.clear();
    this._rebuildKeepingSelection();
  }

  _togglePin() {
    const s = this.selectedSession();
    if (!s) return;
    try {
      const pinned = pins.toggle(s.sessionId);
      this._rebuildKeepingSelection();
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
    this.selIdx = 0;
    this.scrollTop = 0;
    this.rebuild();
  }

  /** A setting changed in the settings screen: apply what takes effect now. */
  _applySetting(key, value) {
    if (key === 'mouse') { if (value) this._mouseOn(); else this._mouseOff(); }
    if (key === 'tagsLayout') { this.focus = 'list'; this.ensureVisible(); }
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
        if (!fs.existsSync(absPath)) return `Folder not found: ${shortenPath(absPath)} (create it first)`;
        let folderName;
        try { folderName = projectDirNameFor(this.movePicker.config, absPath); }
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

  // ── Input ───────────────────────────────────────────────────────────────────

  /** Returns false to quit. */
  handleKey(key) {
    const mouse = parseMouse(key);
    if (mouse) return this._handleMouse(mouse);
    switch (this.mode) {
      case 'help':   this.mode = null; return true;
      case 'delete': this.mode = null; if (key === 'y' || key === 'Y') this._doDelete(); return true;
      case 'move':   if (this.movePicker.handleKey(key) === false) this.mode = null; return true;
      case 'new':    if (this.newPicker.handleKey(key) === false) this.mode = null; return true;
      case 'settings': if (this.settingsScreen.handleKey(key) === false) this.mode = null; return true;
      case 'trash':    if (this.trashScreen.handleKey(key) === false) this.mode = null; return true;
      case 'search': this._handleSearchKey(key); return true;
      case 'rename': this._handleRenameKey(key); return true;
      default:       return this._handleBrowseKey(key);
    }
  }

  /** Returns IDLE when only the pointer moved and nothing needs redrawing. */
  _handleMouse({ x, y, wheel, click, motion }) {
    this._pointerAt = { x, y };
    if (motion) return this._updateHover() ? true : IDLE;
    this._handleButton(x, y, wheel, click);
    this._updateHover();
    return true;
  }

  /** What the pointer is over and can be clicked: "row:<item>", "tag:<name>", "set:<i>", "pick:<i>", or null. */
  _hoverAt(x, y) {
    if (this.mode === 'move' || this.mode === 'new') {
      const i = (this.mode === 'move' ? this.movePicker : this.newPicker).itemAt(y);
      return i >= 0 ? `pick:${i}` : null;
    }
    if (this.mode === 'settings') {
      const i = this.settingsScreen.itemAt(y);
      return i >= 0 ? `set:${i}` : null;
    }
    if (this.mode === 'trash') {
      const i = this.trashScreen.itemAt(y);
      return i >= 0 ? `trash:${i}` : null;
    }
    if (this.mode !== null && this.mode !== 'search') return null;
    const hit = (this._tagHits || []).find(h => y === h.row && x >= h.from && x <= h.to);
    if (hit) return `tag:${hit.name}`;
    const row = y - this.listTop;
    if (x <= this.sidebarW || row < 0 || row >= this.listH) return null;
    const index = this.scrollTop + row;
    return this.items[index]?.type === 'session' ? `row:${index}` : null;
  }

  /** Recomputes what's under the pointer and updates the pointer shape. Returns true if it changed. */
  _updateHover() {
    const hover = this._pointerAt ? this._hoverAt(this._pointerAt.x, this._pointerAt.y) : null;
    if (hover === this.hover) return false;
    this.hover = hover;
    const index = (prefix) => hover?.startsWith(prefix) ? Number(hover.slice(prefix.length)) : -1;
    this.movePicker.hover = this.newPicker.hover = index('pick:');
    this.settingsScreen.hover = index('set:');
    this.trashScreen.hover = index('trash:');
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

    if (this.mode === 'move' || this.mode === 'new') {
      const picker = this.mode === 'move' ? this.movePicker : this.newPicker;
      if (wheel) picker.moveSelection(wheel * WHEEL_STEP);
      else if (click && picker.clickRow(y, double) === false) this.mode = null;
      return;
    }
    if (this.mode === 'settings') {
      if (wheel) this.settingsScreen.moveSelection(wheel);
      else if (click) this.settingsScreen.clickRow(y, double);
      return;
    }
    if (this.mode === 'trash') {
      if (wheel) this.trashScreen.moveSelection(wheel * WHEEL_STEP);
      else if (click) this.trashScreen.clickRow(y, double);
      return;
    }
    if (this.mode === 'help' && click) { this.mode = null; return; }
    if (this.mode !== null && this.mode !== 'search') return;

    if (wheel) { this.moveSelection(wheel * WHEEL_STEP); return; }
    if (!click) return;
    const hit = this._tagHits.find(h => y === h.row && x >= h.from && x <= h.to);
    if (hit) { if (hit.name !== this.tag) this._selectTag(hit.name); return; }
    if (x <= this.sidebarW) return;
    const row = y - this.listTop;
    if (row < 0 || row >= this.listH) return;
    const index = this.scrollTop + row;
    if (this.items[index]?.type !== 'session') return;
    this.selIdx = this.items.slice(0, index).filter(i => i.type === 'session').length;
    if (double) { this.mode = null; this._openSelected(); }
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
      this.rebuild();
      this._scheduleContentSearch();
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
    // With the sidebar shown, ← and Tab move to it; with tabs on the frame
    // edge (narrow screens), ← → step through the tags.
    const sidebar = this.sidebarW > 0;

    if      (key === '/')                   this._startSearch('text');
    else if (key === 'f')                   this._startSearch('grep');
    else if (key === '?')                   this.mode = 'help';
    else if (key === ',')                   { this.settingsScreen.enter(); this.mode = 'settings'; }
    else if (is(key, 'ESCAPE'))             { this.search = ''; this.tag = null; this.marked.clear(); this._scheduleContentSearch(); this.rebuild(); }
    else if (key === 'u')                   this._undoDelete();
    else if (key === 't')                   { this.trashScreen.enter(); this.mode = 'trash'; }
    else if (is(key, 'ENTER'))              this._openSelected();
    else if (key === 'o')                   this._openSelected(true);
    else if (key === 'F')                   { if (s) this._open(resumePlan(s, { fork: true })); }
    else if (key === '*')                   this._togglePin();
    else if (key === 'p')                   { this.preview = !this.preview; this.ensureVisible(); }
    else if (key === 's')                   this._cycleSort();
    else if (key === 'r')                   { if (s) { this.renameField.set(s.title || ''); this.mode = 'rename'; } }
    else if (key === ' ')                   this._toggleMark();
    else if (key === 'd')                   { if (this._deleteTargets().length) this.mode = 'delete'; }
    else if (key === 'n')                   { this.newPicker.enter(); this.mode = 'new'; }
    else if (key === 'm')                   { if (s) { this.movePicker.enter(); this.mode = 'move'; } else this.setStatus('No session selected.'); }
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
    const out = [screen.hideCursor, screen.altBuffer, screen.clear, moveTo(1, 1)];
    if (W < MIN_W || H < MIN_H) {
      const note = [`Terminal too small (${W}×${H})`, `Make it at least ${MIN_W}×${MIN_H}`, 'q quits'];
      note.forEach((t, i) => out.push(moveTo(Math.max(1, Math.floor(H / 2) - 1 + i), Math.max(1, Math.floor((W - t.length) / 2) + 1)), trunc(t, W)));
      process.stdout.write(out.join(''));
      return;
    }

    const filterInfo = this.filterPath ? `  path:${shortenPath(this.filterPath)}` : '';
    const cs = this.contentSearch;
    const searchInfo = !this.search ? ''
      : this.searchKind === 'grep'
        ? `  find in chats:${this.search}${cs ? `  (searching ${cs.done}/${cs.total}…)` : `  (${this.contentMatches.size} found)`}`
        : `  search:${this.search}`;
    const sortInfo   = this.sort !== 'date' ? `  sort:${this.sort}` : '';
    out.push(bg('44', bold(fg('97', pad(trunc(`  claude-sessions${filterInfo}${searchInfo}${sortInfo}`, W), W)))));

    if (this.mode === 'move')      this.movePicker.render(out, W, H);
    else if (this.mode === 'new')  this.newPicker.render(out, W, H);
    else if (this.mode === 'help') this._renderHelp(out);
    else if (this.mode === 'settings') this.settingsScreen.render(out, W);
    else if (this.mode === 'trash') this.trashScreen.render(out, W, H);
    else this._renderFramedList(out, W, H);
    if (this.mode === 'search' && this.searchKind === 'grep') this._renderFindPopup(out, W, H);

    out.push(moveTo(H, 1), clearLine, this._renderFooter(W));
    const cursor = this._cursorPosition();
    if (cursor) out.push(moveTo(cursor[0], Math.min(W, cursor[1])), screen.showCursor);
    process.stdout.write(out.join(''));
  }

  /** Where the "f" popup sits: { top, left, width } (screen rows/columns). */
  _findPopupBox(W, H) {
    const width = Math.min(64, W - 6);
    return { top: Math.max(3, Math.floor(H / 2) - 3), left: Math.floor((W - width) / 2) + 1, width };
  }

  /** The "f" popup: a text field, then progress and the number of matches. The list behind filters live. */
  _renderFindPopup(out, W, H) {
    const { top, left, width } = this._findPopupBox(W, H);
    const inner = width - 2;
    const line  = t => fg('96', t);
    const cs    = this.contentSearch;
    const query = this.search.trim();
    const status = query.length < CONTENT_SEARCH_MIN ? dim('Type at least 2 characters')
      : cs ? fg('93', `Searching ${cs.done}/${cs.total} sessions…`) + dim(`  ${this.contentMatches.size} found`)
      : `${bold(String(this.contentMatches.size))} session${this.contentMatches.size === 1 ? '' : 's'} found`;
    const body = (text, len) => text + ' '.repeat(Math.max(0, inner - 2 - len));
    const field = trunc(this.searchField.text, inner - 4);
    const title = ' Find in conversations ';
    out.push(
      moveTo(top, left), line('╭─') + bold(fg('96', title)) + line('─'.repeat(Math.max(0, inner - 1 - title.length)) + '╮'),
      moveTo(top + 1, left), line('│'), ' ', body(`${fg('93', '›')} ${field}`, 2 + field.length), ' ', line('│'),
      moveTo(top + 2, left), line('│'), ' ', body(status, stripAnsi(status).length), ' ', line('│'),
      moveTo(top + 3, left), line('╰' + '─'.repeat(inner) + '╯'),
    );
  }

  _renderHelp(out) {
    HELP.forEach(([k, d], i) => out.push(moveTo(i + 3, 1), clearLine, `  ${fg('93', pad(k, 14))}${d}`));
    out.push(moveTo(HELP.length + 4, 1),
      dim(`  Settings (,) are saved in ${settings.file}`));
  }

  /** Tag entries in display order: All, then tags by count. */
  _tagEntries() {
    return [{ name: null, label: 'All', count: this.tagTotal }, ...this.tags.map(t => ({ ...t, label: t.name }))];
  }

  /**
   * The session list in a frame: column titles, rows, and the preview below a
   * divider. Tags are a sidebar to its left, or tabs on its top edge.
   * `_tagHits` records where each visible tag is, for mouse clicks.
   */
  _renderFramedList(out, W, H) {
    this._tagHits = [];
    for (let row = 2; row < H; row++) out.push(moveTo(row, 1), clearLine);

    const side  = this.sidebarW;
    if (side) this._renderSidebar(out, side, H);
    const left  = side + 1;             // column of the frame's left edge
    const inner = W - side - 2;
    // With two panels, the one that has focus gets a bright border.
    const line  = side && !this.tagsFocused ? t => fg('96', t) : dim;
    const edge  = (row, content) => out.push(moveTo(row, left), line('│'), content, moveTo(row, W), line('│'));

    if (this.tagPanelH) this._renderTagPanel(out, W);
    out.push(moveTo(this.listTop - 2, left), line('╭' + '─'.repeat(inner) + '╮'));
    edge(this.listTop - 1, this._columnTitles(inner));

    const visible = this.items.slice(this.scrollTop, this.scrollTop + this.listH);
    let sessionIdx = this.items.slice(0, this.scrollTop).filter(i => i.type === 'session').length;
    for (let r = 0; r < this.listH; r++) {
      const item = visible[r];
      if (!item) { edge(this.listTop + r, ''); continue; }
      if (item.type === 'config') { edge(this.listTop + r, this._profileHeader(item, inner)); continue; }
      const hovered = this.hover === `row:${this.scrollTop + r}`;
      edge(this.listTop + r, this._sessionRow(item.session, sessionIdx === this.selIdx, inner, hovered));
      sessionIdx++;
    }

    if (this.preview) {
      const top = this.listTop + this.listH;
      out.push(moveTo(top, left), line('├' + '─'.repeat(inner) + '┤'));
      const s = this.selectedSession();
      const lines = s ? this._previewLines(s, inner, this.previewH - 1) : [];
      for (let r = 0; r < this.previewH - 1; r++) edge(top + 1 + r, lines[r] || '');
    }
    out.push(moveTo(H - 1, left), line('╰' + '─'.repeat(inner) + '╯'));
  }

  /** "Tags" panel: one tag per row with its count, the active one highlighted; scrolls to keep it in view. */
  _renderSidebar(out, side, H) {
    const inner   = side - 2;
    const entries = this._tagEntries();
    const rows    = H - 4; // between the panel's top (row 2) and bottom (row H-1) edges
    const active  = Math.max(0, entries.findIndex(e => e.name === this.tag));
    this._sideScroll = Math.min(Math.max(0, this._sideScroll || 0, active - rows + 1), active);

    const focused = this.tagsFocused;
    const line = focused ? t => fg('96', t) : dim;
    out.push(moveTo(2, 1), line('╭─ ') + bold(focused ? fg('96', 'Tags') : 'Tags') + line(' ' + '─'.repeat(Math.max(0, inner - 7)) + '╮'));
    for (let r = 0; r < rows; r++) {
      const row = 3 + r;
      const e = entries[this._sideScroll + r];
      out.push(moveTo(row, 1), line('│'));
      if (e) {
        const count = String(e.count);
        const label = trunc(e.label, inner - count.length - 3);
        const gap   = ' '.repeat(Math.max(1, inner - 2 - label.length - count.length));
        if (e.name === this.tag && focused) {
          const c = selectedColors();
          const body = `${bold(fg('96', label))}${gap}${fg(c.muted, count)} `;
          out.push(COLOR ? `\x1b[${theme.selectedBg}m${fg('96', '▌')}${body}\x1b[49m` : inv(`▌${label}${gap}${count} `));
        } else if (e.name === this.tag) {
          out.push(`${fg('96', '▌')}${bold(fg('96', label))}${gap}${dim(count)} `);
        } else {
          const body = ` ${e.name ? fg('95', label) : label}${gap}${dim(count)} `;
          out.push(this.hover === `tag:${e.name}` ? hoverSpan(body) : body);
        }
        this._tagHits.push({ name: e.name, row, from: 1, to: side });
      }
      out.push(moveTo(row, side), line('│'));
    }
    out.push(moveTo(H - 1, 1), line('╰' + '─'.repeat(inner) + '╯'));
  }

  /**
   * The tags laid out in the Tags panel for a screen `W` wide, as a grid filled
   * row by row so they line up in columns. Like `ls`, each column is as wide as
   * its own widest "name count", and it uses as many columns as fit.
   * Returns { lines, shown, above, below, colW } where `shown` are the lines on
   * screen (scrolled so the active tag is in view), `above`/`below` count the
   * tags hidden before and after them, and `colW` are the column widths.
   */
  _tagLines(W, maxLines = TAG_PANEL_MAX_LINES) {
    const entries = this._tagEntries();
    const room   = W - 4; // the panel's borders and a space each side
    const widths = entries.map(e => Math.min(room, `${e.label} ${e.count}`.length));
    const columnWidths = (cols) => {
      const colW = Array(cols).fill(0);
      widths.forEach((w, i) => { colW[i % cols] = Math.max(colW[i % cols], w); });
      return colW;
    };
    let cols = Math.max(1, entries.length);
    while (cols > 1 && columnWidths(cols).reduce((a, b) => a + b, 0) + TAG_GAP * (cols - 1) > room) cols--;
    const colW  = columnWidths(cols);
    const lines = [];
    for (let i = 0; i < entries.length; i += cols) lines.push(entries.slice(i, i + cols));
    const activeLine = Math.max(0, lines.findIndex(l => l.some(e => e.name === this.tag)));
    const first = Math.max(0, Math.min(activeLine, lines.length - maxLines));
    const shown = lines.slice(first, first + maxLines);
    const count = ls => ls.reduce((n, l) => n + l.length, 0);
    return {
      lines, shown, colW,
      above: count(lines.slice(0, first)),
      below: count(lines.slice(first + shown.length)),
    };
  }

  /**
   * "Tags" panel above the list: the tags in aligned columns, the active one
   * bold, colored and underlined. "▲ n more" / "▼ n more" on the borders when
   * some tags are scrolled out of view.
   */
  _renderTagPanel(out, W) {
    const inner = W - 2;
    const { shown, above, below, colW } = this._tagLines(W, this.tagPanelLines);
    const border = (left, title, note, right) => {
      const noteText = note ? ` ${note} ` : '';
      const fill = Math.max(0, inner - title.length - noteText.length - 1);
      return dim(left + (title ? '─ ' : '')) + (title ? bold(title.slice(2, -1)) + dim(' ') : '') +
        dim('─'.repeat(fill)) + (note ? fg('93', noteText) : '') + dim('─' + right);
    };
    out.push(moveTo(2, 1), border('╭', '─ Tags ', above ? `▲ ${above} more` : '', '╮'));

    shown.forEach((entries, i) => {
      const row = 3 + i;
      let text = ' ', col = 3;
      entries.forEach((e, k) => {
        if (k) { text += ' '.repeat(TAG_GAP); col += TAG_GAP; }
        const count = String(e.count);
        const cellW = colW[k];
        const label = trunc(e.label, cellW - count.length - 1);
        const plain = `${label} ${count}`;
        // The active tag: bold and colored, with its name underlined.
        let cell = e.name === this.tag
          ? bold(fg('96', `\x1b[4m${label}\x1b[24m ${count}`))
          : `${e.name ? fg('95', label) : label} ${dim(count)}`;
        if (e.name !== this.tag && this.hover === `tag:${e.name}`) cell = hoverSpan(cell);
        this._tagHits.push({ name: e.name, row, from: col, to: col + plain.length - 1 });
        text += cell + ' '.repeat(cellW - plain.length);
        col += cellW;
      });
      out.push(moveTo(row, 1), dim('│'), text, moveTo(row, W), dim('│'));
    });
    out.push(moveTo(2 + shown.length + 1, 1), border('╰', '', below ? `▼ ${below} more` : '', '╯'));
  }

  /** Column widths for a row of `W` columns; `prefix` is the [profile] tag shown while searching. */
  _columns(W, prefix = 0) {
    const meta  = 15; // "13M" padded to 5, two spaces, "55m ago" padded to 8
    const avail = Math.max(12, W - 4 - prefix - 4 - meta - 1); // 4: edge/selection bar, mark, pin, space
    const title = Math.floor(avail * 0.55);
    return { title, project: avail - title };
  }

  _columnTitles(W) {
    const c = this._columns(W);
    return dim(`    ${pad('SESSION', c.title)}  ${pad('FOLDER', c.project)}  ${'SIZE'.padStart(5)}  ${'UPDATED'.padStart(8)}`);
  }

  /** "── .claude-work · 4 sessions ─────" */
  _profileHeader(group, W) {
    const count = `· ${group.count} session${group.count === 1 ? '' : 's'}`;
    const rule  = '─'.repeat(Math.max(0, W - group.label.length - count.length - 6));
    return dim('── ') + bold(fg('96', group.label)) + ' ' + dim(`${count} ${rule}`);
  }

  /** "▌● api/fix-login   ~/projects/api   3.2M   2h ago" */
  _sessionRow(s, isSelected, W, isHover = false) {
    const mark     = this.marked.has(s.jsonlPath) ? '●' : ' ';
    const title    = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
    const meta     = `${fmtSize(s.size).padStart(5)}  ${fmtAgo(s.lastModified).padStart(8)}`;
    // While searching, the profile of each session.
    const cfgTag   = this.search ? pad(`[${shortConfig(s.configDir)}]`, this._cfgTagW) + ' ' : '';
    const pin      = pins.has(s.sessionId) ? '★' : ' ';
    const cols     = this._columns(W, cfgTag.length);
    const titleTxt = pad(trunc(title, cols.title), cols.title);
    const projTxt  = pad(trunc(shortenPath(s.project), cols.project), cols.project);

    // On the selected line every part gets an explicit color (see selectedLine).
    const colors = selectedColors();
    const muted  = t => isSelected ? fg(colors.muted, t) : dim(t);
    const styled = fg('91', mark) + fg('93', pin) + ' ' + (cfgTag ? fg('96', cfgTag) : '') +
      (s.title ? groupTitle(titleTxt, isSelected ? colors.title : '92') : muted(titleTxt)) +
      `  ${fg('33', projTxt)}  ${muted(meta)}`;

    if (isSelected) return selectedLine(styled, `${mark}${pin} ${cfgTag}${titleTxt}  ${projTxt}  ${meta}`, W);
    return isHover ? hoverLine(` ${styled}`) : ` ${styled}`;
  }

  /**
   * Token stats for a session, computed in the background the first time
   * they're asked for (then redrawn); null until ready.
   */
  _stats(s) {
    const key = `${s.jsonlPath}:${s.lastModified.valueOf()}`;
    const cached = this._statsCache.get(key);
    if (cached === 'loading') return null;
    if (cached) return cached;
    this._statsCache.set(key, 'loading');
    sessionStats(s.jsonlPath).then(stats => {
      this._statsCache.set(key, stats);
      if (!this._suspended && this.preview) this.render();
    });
    return null;
  }

  /** `text` around the first match of `query`, the match highlighted, at most `width` wide. */
  _snippet(text, query, width) {
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return trunc(text, width);
    const start = Math.max(0, Math.min(i - Math.floor((width - query.length) / 3), text.length - width));
    const before = (start > 0 ? '…' : '') + text.slice(start + (start > 0 ? 1 : 0), i);
    const match  = text.slice(i, i + query.length);
    const after  = text.slice(i + query.length, start + width - 1);
    const end    = start + width < text.length ? '…' : '';
    return `${before}${bold(fg('93', match))}${after}${end}`;
  }

  /**
   * The preview: date, size and id; token usage; while finding text ("f"),
   * the matching messages with the text highlighted; then the latest messages,
   * one line each with a blank line between.
   */
  _previewLines(s, W, H) {
    const key = `${s.jsonlPath}:${s.lastModified.valueOf()}`;
    if (!this._previewCache.has(key)) this._previewCache.set(key, readRecentMessages(s.jsonlPath));
    const width = Math.max(10, W - 8);
    const tag = role => role === 'user' ? fg('92', 'you ') : fg('96', 'cc  ');

    const head = [dim(`  ${fmtDate(s.lastModified)} · ${fmtSize(s.size)} · ${s.sessionId}`)];
    const st = this._stats(s);
    head.push(dim(!st ? '  tokens: counting…'
      : st.replies === 0 ? '  tokens: none recorded'
      : `  tokens: ${fmtTokens(st.input + st.cacheWrite + st.cacheRead)} in (${fmtTokens(st.cacheRead)} from cache) · ` +
        `${fmtTokens(st.output)} out · ${st.replies} replies${st.models.length ? ` · ${st.models.join(', ')}` : ''}`));

    const found = this.searchKind === 'grep' && this.search ? this.contentDetails.get(s.jsonlPath) : null;
    if (found) {
      head.push('', fg('93', `  matches for "${this.search}":`));
      for (const m of found) head.push(`  ${tag(m.role)} ${this._snippet(m.text, this.search.trim(), width)}`);
    }

    const lines = this._previewCache.get(key).flatMap(m => ['', `  ${tag(m.role)} ${trunc(m.text.replace(/\s+/g, ' ').trim(), width)}`]);
    const body = lines.slice(-Math.max(0, H - head.length - 1));
    if (body[0] === '') body.shift();
    return [...head, '', ...(body.length ? body : [dim('  (no messages)')])];
  }

  _renderFooter(W) {
    if (!this.mode && this.statusMsg) {
      return this.statusIsError
        ? bold(fg('91', trunc(`  ✗ ${this.statusMsg}`, W)))
        : fg('93', trunc(`  ${this.statusMsg}`, W));
    }
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
        return `  Move ${name} to trash?  y=delete  Esc=cancel`;
      }
      case 'move':   return this.movePicker.hints();
      case 'new':    return this.newPicker.hints();
      case 'search': return this.searchKind === 'grep'
        ? '  ↑↓=select in the list  Enter=done  Esc=cancel'
        : `  SEARCH: ${this.searchField.text}   ↑↓=select  Enter=open  Tab=keep filter  Esc=cancel`;
      case 'rename': return `  RENAME: ${this.renameField.text}   Enter=save  Esc=cancel`;
      case 'help':   return '  Press any key to close help';
      case 'settings': return this.settingsScreen.hints();
      case 'trash':    return this.trashScreen.hints();
    }
    const total = this.sessionCount();
    const count = `${total} session${total === 1 ? '' : 's'}${this.marked.size ? ` · ${this.marked.size} marked` : ''}  `;
    // Screens (trash, settings, help) sit on the right, apart from the actions,
    // unless the screen is too narrow for both.
    const right = W >= 70 ? `${FOOTER_RIGHT}   ${count}` : count;
    if (this.tagsFocused) {
      return '  ↑↓=choose tag  →/Enter=back to sessions  /=search  q=quit'.padEnd(Math.max(0, W - right.length)) + right;
    }
    const tagsHint = this.sidebarW ? '←=tags' : '←→=tag';
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
    const inFooter = (label, field) => [this.h, `  ${label}: `.length + [...field.before].length + 1];
    switch (this.mode) {
      case 'search': {
        if (this.searchKind !== 'grep') return inFooter('SEARCH', this.searchField);
        const { top, left } = this._findPopupBox(this.w, this.h);
        return [top + 1, left + 4 + [...this.searchField.before].length];
      }
      case 'rename': return inFooter('RENAME', this.renameField);
      case 'move':   return this.movePicker.cursorPosition();
      case 'new':    return this.newPicker.cursorPosition();
      case 'settings': return this.settingsScreen.cursorPosition();
      default:       return null;
    }
  }
}

module.exports = { App };
