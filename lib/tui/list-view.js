'use strict';

// The main screen: the session list in a frame, the Tags panel (above the list,
// or a sidebar on wide screens), the preview, and the "f" popup.
//
// Geometry is computed from the app's state alone (never from the last frame
// drawn), so rendering and mouse hit-testing always agree.

const { screen, theme, COLOR, G, bold, dim, inv, fg, trunc, pad, selectedLine, hoverLine, hoverSpan, selectedColors, groupTitle } = require('../ansi');
const { strWidth } = require('../text');
const { fmtDate, fmtAgo, fmtSize, shortenPath, shortConfig } = require('../format');
const { readRecentMessages } = require('../sessions');
const { sessionStats, fmtTokens } = require('../stats');
const { pins } = require('../pins');
const { settings } = require('../settings');

const { moveTo } = screen;

// Tags sidebar width, and the narrowest screen that still shows it.
const SIDEBAR_W = 22;
const SIDEBAR_MIN_SCREEN = 100;
// The Tags panel above the list wraps onto at most this many lines.
const TAG_PANEL_MAX_LINES = 3;
// The list keeps at least this many rows; the Tags panel and preview shrink first.
const MIN_LIST_ROWS = 3;
const TAG_GAP = 3; // spaces between tag columns
const CONTENT_SEARCH_MIN = 2;

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

class ListView {
  /** @param {import('./app').App} app */
  constructor(app) {
    this.app = app;
    this._previewCache = new Map(); // "path:mtime" → recent messages
    this._stats = new Map();        // path → { mtime, stats, loading }
    this._sideScroll = 0;
  }

  // ── Geometry ────────────────────────────────────────────────────────────────
  // Screen rows: title bar, [Tags panel], frame top, column titles, the list
  // from listTop, the preview, the frame bottom, the footer. With the "side"
  // tags layout on a wide screen, the Tags panel is a column on the left instead.

  get sidebarW() {
    const a = this.app;
    return a.hasTags && settings.get('tagsLayout') === 'side' && a.w >= SIDEBAR_MIN_SCREEN ? SIDEBAR_W : 0;
  }
  /** Lines of tags the panel above the list may use: up to 3, fewer on short screens, 0 (hidden) when there's no room. */
  get tagPanelLines() {
    if (!this.app.hasTags || this.sidebarW) return 0;
    const room = this.app.h - 4 - 2 - 1 - MIN_LIST_ROWS;
    return Math.max(0, Math.min(TAG_PANEL_MAX_LINES, room - 1));
  }
  /** Rows of the Tags panel above the list (its lines plus two borders), or 0. */
  get tagPanelH() {
    const max = this.tagPanelLines;
    return max ? this.tagLines(this.app.w, max).shown.length + 2 : 0;
  }
  get listTop() { return 4 + this.tagPanelH; }
  /** Rows of the preview (with its divider): 40% of the screen, less if the list would get too short, 0 if it doesn't fit. */
  get previewH() {
    const a = this.app;
    if (!a.preview) return 0;
    const fits = a.h - this.listTop - 1 - MIN_LIST_ROWS;
    const rows = Math.min(Math.max(4, Math.floor((a.h - 2) * 0.4)), fits);
    return rows >= 3 ? rows : 0;
  }
  get listH() { return this.app.h - this.listTop - 1 - this.previewH; } // rows up to the frame bottom at h-1

  /** Tag entries in display order: All, then tags by count. */
  tagEntries() {
    const a = this.app;
    return [{ name: null, label: 'All', count: a.tagTotal }, ...a.tags.map(t => ({ ...t, label: t.name }))];
  }

  /**
   * The tags laid out in the Tags panel for a screen `W` wide, as a grid filled
   * row by row so they line up in columns. Like `ls`, each column is as wide as
   * its own widest "name count", and it uses as many columns as fit.
   * Returns { lines, shown, first, above, below, colW } where `shown` are the
   * lines on screen (scrolled so the active tag is in view), `above`/`below`
   * count the tags hidden before and after them, and `colW` are the column widths.
   */
  tagLines(W, maxLines = TAG_PANEL_MAX_LINES) {
    const entries = this.tagEntries();
    const room   = W - 4; // the panel's borders and a space each side
    const widths = entries.map(e => Math.min(room, strWidth(`${e.label} ${e.count}`)));
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
    const activeLine = Math.max(0, lines.findIndex(l => l.some(e => e.name === this.app.tag)));
    const first = Math.max(0, Math.min(activeLine, lines.length - maxLines));
    const shown = lines.slice(first, first + maxLines);
    const count = ls => ls.reduce((n, l) => n + l.length, 0);
    return {
      lines, shown, colW, first,
      above: count(lines.slice(0, first)),
      below: count(lines.slice(first + shown.length)),
    };
  }

  /** Rows of the sidebar's tag list, and its scroll offset keeping the active tag in view. */
  _sidebarRows() {
    const entries = this.tagEntries();
    const rows    = this.app.h - 4; // between the panel's top (row 2) and bottom (row H-1) edges
    const active  = Math.max(0, entries.findIndex(e => e.name === this.app.tag));
    this._sideScroll = Math.min(Math.max(0, this._sideScroll, active - rows + 1), active);
    return { entries, rows, scroll: this._sideScroll };
  }

  /** Where each visible tag is on screen: [{ entry, row, from, to }] (columns, inclusive). */
  tagCells() {
    const a = this.app;
    const cells = [];
    if (this.sidebarW) {
      const { entries, rows, scroll } = this._sidebarRows();
      for (let r = 0; r < rows && scroll + r < entries.length; r++) {
        cells.push({ entry: entries[scroll + r], row: 3 + r, from: 1, to: this.sidebarW });
      }
    } else if (this.tagPanelLines) {
      const { shown, colW } = this.tagLines(a.w, this.tagPanelLines);
      shown.forEach((entries, i) => {
        let col = 3;
        entries.forEach((e, k) => {
          if (k) col += TAG_GAP;
          const count = String(e.count);
          const label = trunc(e.label, colW[k] - count.length - 1);
          cells.push({ entry: e, row: 3 + i, from: col, to: col + strWidth(`${label} ${count}`) - 1, label, colW: colW[k] });
          col += colW[k];
        });
      });
    }
    return cells;
  }

  /** Where the "f" popup sits: { top, left, width, height } (screen rows/columns). */
  findPopupBox() {
    const { w: W, h: H } = this.app;
    const width = Math.min(64, W - 6);
    return { top: Math.max(3, Math.floor(H / 2) - 3), left: Math.floor((W - width) / 2) + 1, width, height: 4 };
  }

  /** What's clickable at (x, y): "tag:<name>", "row:<item index>", or null. */
  hitAt(x, y) {
    const a = this.app;
    if (a.mode === 'search' && a.searchKind === 'grep') {
      const box = this.findPopupBox();
      if (y >= box.top && y < box.top + box.height && x >= box.left && x < box.left + box.width) return null;
    }
    const tag = this.tagCells().find(c => y === c.row && x >= c.from && x <= c.to);
    if (tag) return `tag:${tag.entry.name}`;
    const row = y - this.listTop;
    if (x <= this.sidebarW || row < 0 || row >= this.listH) return null;
    const index = a.scrollTop + row;
    return a.items[index]?.type === 'session' ? `row:${index}` : null;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /**
   * The session list in a frame: column titles, rows, and the preview below a
   * divider. Tags are a sidebar to its left, or a panel above.
   */
  render(out, W, H) {
    const a = this.app;
    const side  = this.sidebarW;
    if (side) this._renderSidebar(out, side, H);
    const left  = side + 1;             // column of the frame's left edge
    const inner = W - side - 2;
    // With two panels, the one that has focus gets a bright border.
    const line  = side && !a.tagsFocused ? t => fg('96', t) : dim;
    const edge  = (row, content) => out.push(moveTo(row, left), line(G.v), content, moveTo(row, W), line(G.v));

    if (this.tagPanelH) this._renderTagPanel(out, W);
    out.push(moveTo(this.listTop - 2, left), line(G.tl + G.h.repeat(inner) + G.tr));
    edge(this.listTop - 1, this._columnTitles(inner));

    const listH = this.listH;
    for (let r = 0; r < listH; r++) {
      const index = a.scrollTop + r;
      const item = a.items[index];
      if (!item) { edge(this.listTop + r, ''); continue; }
      if (item.type === 'config') { edge(this.listTop + r, this._profileHeader(item, inner)); continue; }
      edge(this.listTop + r, this._sessionRow(item.session, item.session === a.selectedSession(), inner, a.hover === `row:${index}`));
    }

    if (a.preview && this.previewH) {
      const top = this.listTop + listH;
      out.push(moveTo(top, left), line(G.lt + G.h.repeat(inner) + G.rt));
      const s = a.selectedSession();
      const lines = s ? this._previewLines(s, inner, this.previewH - 1) : [];
      for (let r = 0; r < this.previewH - 1; r++) edge(top + 1 + r, lines[r] || '');
    }
    out.push(moveTo(H - 1, left), line(G.bl + G.h.repeat(inner) + G.br));
    if (a.mode === 'search' && a.searchKind === 'grep') this._renderFindPopup(out);
  }

  /** "Tags" panel: one tag per row with its count, the active one highlighted. */
  _renderSidebar(out, side, H) {
    const a = this.app;
    const inner   = side - 2;
    const focused = a.tagsFocused;
    const line = focused ? t => fg('96', t) : dim;
    out.push(moveTo(2, 1), line(`${G.tl}${G.h} `) + bold(focused ? fg('96', 'Tags') : 'Tags') + line(' ' + G.h.repeat(Math.max(0, inner - 7)) + G.tr));
    const cells = this.tagCells();
    for (let r = 0; r < H - 4; r++) {
      const row = 3 + r;
      const e = cells[r]?.entry;
      out.push(moveTo(row, 1), line(G.v));
      if (e) {
        const count = String(e.count);
        const label = trunc(e.label, inner - count.length - 3);
        const gap   = ' '.repeat(Math.max(1, inner - 2 - strWidth(label) - count.length));
        if (e.name === a.tag && focused) {
          const c = selectedColors();
          const body = `${bold(fg('96', label))}${gap}${fg(c.muted, count)} `;
          out.push(COLOR && !theme.basic ? `\x1b[${theme.selectedBg}m${fg('96', G.bar)}${body}\x1b[49m` : inv(`${G.bar}${label}${gap}${count} `));
        } else if (e.name === a.tag) {
          out.push(`${fg('96', G.bar)}${bold(fg('96', label))}${gap}${dim(count)} `);
        } else {
          const body = ` ${e.name ? fg('95', label) : label}${gap}${dim(count)} `;
          out.push(a.hover === `tag:${e.name}` ? hoverSpan(body) : body);
        }
      }
      out.push(moveTo(row, side), line(G.v));
    }
    out.push(moveTo(H - 1, 1), line(G.bl + G.h.repeat(inner) + G.br));
  }

  /**
   * "Tags" panel above the list: the tags in aligned columns, the active one
   * bold, colored and underlined. "▲ n more" / "▼ n more" on the borders when
   * some tags are scrolled out of view.
   */
  _renderTagPanel(out, W) {
    const a = this.app;
    const inner = W - 2;
    const { shown, above, below } = this.tagLines(W, this.tagPanelLines);
    const border = (left, title, note, right) => {
      const noteText = note ? ` ${note} ` : '';
      const fill = Math.max(0, inner - (title ? strWidth(title) + 3 : 0) - strWidth(noteText) - 1);
      return dim(left + (title ? `${G.h} ` : '')) + (title ? bold(title) + dim(' ') : '') +
        dim(G.h.repeat(fill)) + (note ? fg('93', noteText) : '') + dim(G.h + right);
    };
    out.push(moveTo(2, 1), border(G.tl, 'Tags', above ? `${G.up} ${above} more` : '', G.tr));

    const cells = this.tagCells();
    shown.forEach((_, i) => {
      const row = 3 + i;
      let text = ' ', col = 2;
      for (const c of cells.filter(c => c.row === row)) {
        text += ' '.repeat(c.from - 1 - col);
        const e = c.entry;
        const count = String(e.count);
        // The active tag: bold and colored, with its name underlined.
        let cell = e.name === a.tag
          ? bold(fg('96', `\x1b[4m${c.label}\x1b[24m ${count}`))
          : `${e.name ? fg('95', c.label) : c.label} ${dim(count)}`;
        if (e.name !== a.tag && a.hover === `tag:${e.name}`) cell = hoverSpan(cell);
        text += cell;
        col = c.to;
      }
      out.push(moveTo(row, 1), dim(G.v), text, moveTo(row, W), dim(G.v));
    });
    out.push(moveTo(2 + shown.length + 1, 1), border(G.bl, '', below ? `${G.down} ${below} more` : '', G.br));
  }

  /** Width of the "[profile] " tag shown before titles while searching, or 0. */
  _prefixW() {
    return this.app.search ? this.app.cfgTagW + 1 : 0;
  }

  /** Column widths for a row of `W` columns; `prefix` is the [profile] tag shown while searching. */
  _columns(W, prefix = 0) {
    const meta  = 15; // "13M" padded to 5, two spaces, "55m ago" padded to 8
    const avail = Math.max(12, W - 4 - prefix - 4 - meta - 1); // 4: edge/selection bar, mark, pin, space
    const title = Math.floor(avail * 0.55);
    return { title, project: avail - title };
  }

  _columnTitles(W) {
    const prefix = this._prefixW();
    const c = this._columns(W, prefix);
    return dim(`    ${pad(prefix >= 8 ? 'PROFILE' : '', prefix)}${pad('SESSION', c.title)}  ${pad('FOLDER', c.project)}  ${'SIZE'.padStart(5)}  ${'UPDATED'.padStart(8)}`);
  }

  /** "── .claude-work · 4 sessions ─────" */
  _profileHeader(group, W) {
    const count = `${G.dot} ${group.count} session${group.count === 1 ? '' : 's'}`;
    const rule  = G.h.repeat(Math.max(0, W - strWidth(group.label) - strWidth(count) - 6));
    return dim(`${G.h}${G.h} `) + bold(fg('96', group.label)) + ' ' + dim(`${count} ${rule}`);
  }

  /** "▌● api/fix-login   ~/projects/api   3.2M   2h ago" */
  _sessionRow(s, isSelected, W, isHover = false) {
    const a = this.app;
    const mark     = a.marked.has(s.jsonlPath) ? G.mark : ' ';
    const title    = s.title || (s.firstMessage ? `(${s.firstMessage})` : '(untitled)');
    const meta     = `${fmtSize(s.size).padStart(5)}  ${fmtAgo(s.lastModified).padStart(8)}`;
    // While searching, the profile of each session.
    const prefix   = this._prefixW();
    const cfgTag   = prefix ? pad(`[${shortConfig(s.configDir)}]`, prefix) : '';
    const pin      = pins.has(s.sessionId) ? G.pin : ' ';
    const cols     = this._columns(W, prefix);
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

  /** The "f" popup: a text field, then progress and the number of matches. The list behind filters live. */
  _renderFindPopup(out) {
    const a = this.app;
    const { top, left, width } = this.findPopupBox();
    const inner = width - 2;
    const line  = t => fg('96', t);
    const cs    = a.contentSearch;
    const found = a.contentMatches.size;
    const status = a.search.trim().length < CONTENT_SEARCH_MIN ? dim('Type at least 2 characters')
      : cs ? fg('93', `Searching ${cs.done}/${cs.total} sessions…`) + dim(`  ${found} found`)
      : `${bold(String(found))} session${found === 1 ? '' : 's'} found`;
    const body  = (text) => text + ' '.repeat(Math.max(0, inner - 2 - strWidth(stripAnsi(text))));
    const field = trunc(a.searchField.text, inner - 4);
    const title = ' Find in conversations ';
    out.push(
      moveTo(top, left), line(G.tl + G.h) + bold(fg('96', title)) + line(G.h.repeat(Math.max(0, inner - 1 - title.length)) + G.tr),
      moveTo(top + 1, left), line(G.v), ' ', body(`${fg('93', G.prompt)} ${field}`), ' ', line(G.v),
      moveTo(top + 2, left), line(G.v), ' ', body(status), ' ', line(G.v),
      moveTo(top + 3, left), line(G.bl + G.h.repeat(inner) + G.br),
    );
  }

  /** Screen [row, col] of the cursor in the "f" popup. */
  findCursor() {
    const { top, left } = this.findPopupBox();
    return [top + 1, left + 4 + strWidth(this.app.searchField.before)];
  }

  // ── Preview ─────────────────────────────────────────────────────────────────

  /** Forgets cached previews (after the sessions were re-read). */
  clearCache() { this._previewCache.clear(); }

  /**
   * Token stats for a session, computed in the background (one parse per file
   * at a time); the last known stats meanwhile, or null.
   */
  _statsFor(s) {
    const mtime = s.lastModified.valueOf();
    const entry = this._stats.get(s.jsonlPath);
    if (entry && (entry.mtime === mtime || entry.loading)) return entry.stats;
    const next = { mtime, stats: entry?.stats ?? null, loading: true };
    this._stats.set(s.jsonlPath, next);
    sessionStats(s.jsonlPath).then(stats => {
      next.stats = stats;
      next.loading = false;
      this.app.renderLater();
    }, () => { next.loading = false; });
    return next.stats;
  }

  /** `text` around the first match of `query`, the match highlighted, at most `width` columns. */
  _snippet(text, query, width) {
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return trunc(text, width);
    const match = text.slice(i, i + query.length);
    const room  = Math.max(0, width - strWidth(match));
    // At least a third of the room before the match; more when the text after it is short.
    let before = text.slice(0, i);
    const keepBefore = Math.max(Math.floor(room / 3), room - strWidth(text.slice(i + query.length)));
    if (strWidth(before) > keepBefore) {
      const chars = [...before];
      while (chars.length && strWidth(chars.join('')) > keepBefore - 1) chars.shift();
      before = G.ell + chars.join('');
    }
    const after = trunc(text.slice(i + query.length), Math.max(0, room - strWidth(before)));
    return `${before}${bold(fg('93', match))}${after}`;
  }

  /**
   * The preview: date, size and id; token usage; while finding text ("f"),
   * the matching messages with the text highlighted; then the latest messages,
   * one line each with a blank line between.
   */
  _previewLines(s, W, H) {
    const a = this.app;
    const key = `${s.jsonlPath}:${s.lastModified.valueOf()}`;
    if (!this._previewCache.has(key)) this._previewCache.set(key, readRecentMessages(s.jsonlPath));
    const width = Math.max(10, W - 8);
    const tag = role => role === 'user' ? fg('92', 'you ') : fg('96', 'cc  ');
    const info = t => dim(trunc(t, W - 1));

    const head = [info(`  ${fmtDate(s.lastModified)} ${G.dot} ${fmtSize(s.size)} ${G.dot} ${s.sessionId}`)];
    const st = this._statsFor(s);
    head.push(info(!st ? '  tokens: counting…'
      : st.replies === 0 ? '  tokens: none recorded'
      : `  tokens: ${fmtTokens(st.input + st.cacheWrite + st.cacheRead)} in (${fmtTokens(st.cacheRead)} from cache) ${G.dot} ` +
        `${fmtTokens(st.output)} out ${G.dot} ${st.replies} replies${st.models.length ? ` ${G.dot} ${st.models.join(', ')}` : ''}`));

    const query = a.search.trim();
    const found = a.searchKind === 'grep' && query ? a.contentDetails.get(s.jsonlPath) : null;
    if (found) {
      head.push('', fg('93', trunc(`  matches for "${query}":`, W - 1)));
      for (const m of found) head.push(`  ${tag(m.role)} ${this._snippet(m.text, query, width)}`);
    }

    const lines = this._previewCache.get(key).flatMap(m => ['', `  ${tag(m.role)} ${trunc(m.text, width)}`]);
    const body = lines.slice(-Math.max(0, H - head.length - 1));
    if (body[0] === '') body.shift();
    return [...head, '', ...(body.length ? body : [dim('  (no messages)')])];
  }
}

module.exports = { ListView, CONTENT_SEARCH_MIN, MIN_LIST_ROWS };
