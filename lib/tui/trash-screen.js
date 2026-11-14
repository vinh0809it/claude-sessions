'use strict';

const { screen, G, bold, dim, fg, pad, trunc, selectedLine, hoverLine, selectedColors, groupTitle } = require('../ansi');
const { fmtAgo, fmtSize, shortenPath, shortConfig } = require('../format');
const { is } = require('./keys');

const { moveTo, clearLine } = screen;

const FIRST_ROW = 4;

/**
 * Deleted sessions, most recent first. Enter restores the selected one; x
 * deletes it permanently and X deletes everything in the trash, each after a
 * y/n confirmation.
 */
class TrashScreen {
  /**
   * @param {object}   o
   * @param {() => object[]} o.load          Lists the trash (see operations.listTrash)
   * @param {(entry) => void} o.restore      Restores one entry; throws on failure
   * @param {(entry) => void} o.deleteForever Permanently removes one entry
   * @param {() => number} o.deleteAll       Permanently removes everything; returns bytes freed
   */
  constructor({ load, restore, deleteForever, deleteAll }) {
    this.load = load;
    this.restore = restore;
    this.deleteForever = deleteForever;
    this.deleteAll = deleteAll;
    this.entries = [];
    this.selIdx = 0;
    this.scroll = 0;
    this.confirming = null; // 'one' or 'all' while asking y/n
    this.message = '';
    this.hover = -1;
  }

  enter() {
    this.entries = this.load();
    this.selIdx = 0;
    this.scroll = 0;
    this.confirming = null;
    this.message = '';
  }

  get selected() { return this.entries[this.selIdx] ?? null; }

  moveSelection(delta) {
    this.selIdx = Math.max(0, Math.min(this.entries.length - 1, this.selIdx + delta));
    this.confirming = null;
  }

  /** Returns false when the screen should close. */
  handleKey(key) {
    if (this.confirming) {
      const what = this.confirming;
      this.confirming = null;
      if (key === 'y' || key === 'Y') { if (what === 'all') this._deleteEverything(); else this._deleteSelected(); }
      return true;
    }
    if (is(key, 'ESCAPE') || key === 't' || key === 'q') return false;
    if (is(key, 'UP') || key === 'k') this.moveSelection(-1);
    else if (is(key, 'DOWN') || key === 'j') this.moveSelection(+1);
    else if (is(key, 'PAGE_UP')) this.moveSelection(-10);
    else if (is(key, 'PAGE_DOWN')) this.moveSelection(+10);
    else if (is(key, 'ENTER') || key === 'r') this._restoreSelected();
    else if (key === 'x' && this.selected) this.confirming = 'one';
    else if (key === 'X' && this.entries.length) this.confirming = 'all';
    return true;
  }

  itemAt(row) {
    const i = this.scroll + row - FIRST_ROW;
    return row >= FIRST_ROW && row < FIRST_ROW + (this._rows || 0) && i < this.entries.length ? i : -1;
  }

  clickRow(row, double) {
    const i = this.itemAt(row);
    if (i < 0) return;
    this.selIdx = i;
    this.confirming = null;
    if (double) this._restoreSelected();
  }

  _restoreSelected() {
    const e = this.selected;
    if (!e) return;
    try {
      this.restore(e);
      this.message = `Restored "${trunc(e.title || e.firstMessage || e.sessionId, 40)}"`;
      this._reload();
    } catch (err) {
      this.message = `${G.cross} Restore failed: ${err.message}`;
    }
  }

  _deleteSelected() {
    const e = this.selected;
    if (!e) return;
    try {
      const freed = this.deleteForever(e);
      this.message = `Permanently deleted, freed ${fmtSize(freed)}`;
      this._reload();
    } catch (err) {
      this.message = `${G.cross} Delete failed: ${err.message}`;
    }
  }

  _deleteEverything() {
    try {
      const n = this.entries.length;
      const freed = this.deleteAll();
      this.message = `Permanently deleted ${n} session${n === 1 ? '' : 's'}, freed ${fmtSize(freed)}`;
      this._reload();
    } catch (err) {
      this.message = `${G.cross} Delete failed: ${err.message}`;
    }
  }

  _reload() {
    this.entries = this.load();
    this.selIdx = Math.min(this.selIdx, Math.max(0, this.entries.length - 1));
  }

  hints() {
    const size = fmtSize(this.confirming === 'all' ? this.entries.reduce((n, e) => n + e.size, 0) : this.selected?.size || 0);
    if (this.confirming === 'all') return `  Permanently delete all ${this.entries.length} sessions in the trash (${size})?  y=delete  Esc=cancel`;
    if (this.confirming === 'one') return `  Permanently delete this session (${size})?  y=delete  Esc=cancel`;
    return '  ↑↓=select  Enter=restore  x=permanent delete  X=delete all  Esc=close';
  }

  render(out, W, H) {
    const total = this.entries.reduce((n, e) => n + e.size, 0);
    out.push(moveTo(2, 1), clearLine,
      `  ${bold('Trash')}  ${dim(`${this.entries.length} session${this.entries.length === 1 ? '' : 's'} · ${fmtSize(total)}`)}`);
    out.push(moveTo(3, 1), clearLine);

    const rows = Math.max(0, H - FIRST_ROW - 2);
    this._rows = rows;
    if (this.selIdx < this.scroll) this.scroll = this.selIdx;
    if (this.selIdx >= this.scroll + rows) this.scroll = this.selIdx - rows + 1;

    if (!this.entries.length) out.push(moveTo(FIRST_ROW, 1), clearLine, dim('   The trash is empty.'));
    const meta = 18; // "  1.2M  deleted 3d ago"-ish, padded
    const titleW = Math.max(10, Math.floor((W - 6 - meta) * 0.5));
    const folderW = Math.max(6, W - 6 - meta - titleW - 10);
    for (let r = 0; r < rows; r++) {
      const i = this.scroll + r;
      const e = this.entries[i];
      out.push(moveTo(FIRST_ROW + r, 1), clearLine);
      if (!e) continue;
      const isSelected = i === this.selIdx;
      const c = selectedColors();
      const muted = t => isSelected ? fg(c.muted, t) : dim(t);
      const title  = pad(trunc(e.title || (e.firstMessage ? `(${e.firstMessage})` : e.sessionId), titleW), titleW);
      const folder = pad(trunc(shortenPath(e.project), folderW), folderW);
      const prof   = pad(`[${shortConfig(e.configDir)}]`, 9);
      const when   = `${fmtSize(e.size).padStart(5)}  ${fmtAgo(e.deletedAt).padStart(8)}`;
      const styled = '  ' + (e.title ? groupTitle(title, isSelected ? c.title : '92') : muted(title)) +
        `  ${fg('33', folder)}  ${fg('96', prof)}${muted(when)}`;
      out.push(isSelected ? selectedLine(styled, `  ${title}  ${folder}  ${prof}${when}`, W)
        : i === this.hover ? hoverLine(` ${styled}`) : ` ${styled}`);
    }
    if (this.message) {
      const isError = this.message.startsWith(G.cross);
      out.push(moveTo(H - 1, 1), clearLine, isError ? fg('91', `  ${this.message}`) : fg('93', `  ${this.message}`));
    }
  }
}

module.exports = { TrashScreen };
