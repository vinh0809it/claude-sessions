'use strict';

const { SETTINGS } = require('../settings');
const { screen, bold, dim, fg, pad, trunc, selectedLine, hoverLine, selectedColors, COLOR } = require('../ansi');
const { shortenPath } = require('../format');
const { is } = require('./keys');
const { LineInput } = require('./line-input');

const { moveTo, clearLine } = screen;

const LABEL_W = 22;
const FIRST_ROW = 4;

/**
 * The settings list. Choices and switches change with ←/→, Enter or Space and
 * are saved at once; text settings open an inline editor. Settings overridden
 * by an environment variable are shown but can't be changed here.
 */
class SettingsScreen {
  /**
   * @param {import('../settings').Settings} settings
   * @param {(key: string, value: any) => void} onChange  Called after a value is saved
   */
  constructor(settings, onChange) {
    this.settings = settings;
    this.onChange = onChange;
    this.selIdx   = 0;
    this.editing  = null; // LineInput while a text setting is being edited
    this.message  = '';   // an error or note for the selected row
  }

  enter() { this.selIdx = 0; this.editing = null; this.message = ''; }

  get selected() { return SETTINGS[this.selIdx]; }

  moveSelection(delta) {
    this.selIdx = Math.max(0, Math.min(SETTINGS.length - 1, this.selIdx + delta));
    this.message = '';
  }

  /** Returns false when the screen should close. */
  handleKey(key) {
    if (this.editing) return this._handleEditKey(key);
    if (is(key, 'ESCAPE') || key === ',' || key === 'q') return false;
    if (is(key, 'UP')   || key === 'k') this.moveSelection(-1);
    else if (is(key, 'DOWN') || key === 'j') this.moveSelection(+1);
    else if (is(key, 'LEFT') || key === 'h') this._change(-1);
    else if (is(key, 'RIGHT') || key === 'l' || key === ' ' || is(key, 'ENTER')) this._change(+1);
    return true;
  }

  /** A click on screen row `row` selects it; a double click changes it. */
  /** Index of the setting shown on screen row `row`, or -1. */
  itemAt(row) {
    const i = row - FIRST_ROW;
    return i >= 0 && i < SETTINGS.length ? i : -1;
  }

  clickRow(row, double) {
    const i = this.itemAt(row);
    if (i < 0) return;
    if (i !== this.selIdx) { this.selIdx = i; this.message = ''; }
    if (double) this._change(+1);
  }

  _change(delta) {
    const def = this.selected;
    const envName = this.settings.envOverride(def.key);
    if (envName) { this.message = `Set by ${envName}; unset it to change this here.`; return; }
    if (def.type === 'text') { this.editing = new LineInput(this.settings.get(def.key)); this.message = ''; return; }
    const value = def.type === 'bool'
      ? !this.settings.get(def.key)
      : def.choices[(def.choices.indexOf(this.settings.get(def.key)) + delta + def.choices.length) % def.choices.length];
    this._save(def.key, value);
  }

  _handleEditKey(key) {
    if (is(key, 'ESCAPE')) this.editing = null;
    else if (is(key, 'ENTER')) {
      const value = this.editing.text.trim();
      this.editing = null;
      this._save(this.selected.key, value);
    }
    else this.editing.handle(key);
    return true;
  }

  _save(key, value) {
    try {
      this.settings.set(key, value);
      this.message = '';
      this.onChange(key, value);
    } catch (e) {
      this.message = `Couldn't save: ${e.message}`;
    }
  }

  _valueText(def) {
    const v = this.settings.get(def.key);
    if (def.type === 'bool') return v ? 'on' : 'off';
    if (def.type === 'text') return v || '(none)';
    return String(v);
  }

  /** Screen position [row, col] of the text cursor while editing, else null. */
  cursorPosition() {
    if (!this.editing) return null;
    return [FIRST_ROW + this.selIdx, 3 + LABEL_W + [...this.editing.before].length + 1];
  }

  hints() {
    return this.editing
      ? '  Enter=save  Esc=cancel'
      : '  ↑↓=select  ←→/Enter=change  Esc=close';
  }

  render(out, W) {
    out.push(moveTo(2, 1), clearLine, `  ${bold('Settings')}  ${dim(trunc(`saved to ${shortenPath(this.settings.file)}`, W - 14))}`);
    out.push(moveTo(3, 1), clearLine);
    SETTINGS.forEach((def, i) => {
      const isSelected = i === this.selIdx;
      const envName = this.settings.envOverride(def.key);
      const label = pad(def.label, LABEL_W);
      const value = isSelected && this.editing ? this.editing.text : this._valueText(def);
      const note  = envName ? `  (from ${envName})` : '';
      const room  = Math.max(4, W - 4 - LABEL_W - note.length);
      const valueTxt = trunc(value, room);
      out.push(moveTo(FIRST_ROW + i, 1), clearLine);
      if (isSelected) {
        const c = selectedColors();
        const styled = `  ${fg(c.muted, label)}${bold(fg(envName ? c.muted : '93', valueTxt))}${note ? fg(c.muted, note) : ''}`;
        out.push(selectedLine(styled, `  ${label}${valueTxt}${note}`, W));
      } else {
        const line = `   ${label}${envName ? dim(valueTxt) : fg('93', valueTxt)}${dim(note)}`;
        out.push(i === this.hover ? hoverLine(line) : line);
      }
    });

    const def = this.selected;
    const below = FIRST_ROW + SETTINGS.length + 1;
    out.push(moveTo(below, 1), clearLine, dim(`   ${trunc(def.help, W - 4)}`));
    out.push(moveTo(below + 1, 1), clearLine);
    if (this.message) out.push(COLOR ? fg('91', `   ✗ ${trunc(this.message, W - 6)}`) : `   ✗ ${this.message}`);
  }
}

module.exports = { SettingsScreen };
