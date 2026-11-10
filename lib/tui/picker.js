'use strict';

const path = require('path');
const { screen, bold, dim, fg, pad, trunc, selectedLine, COLOR } = require('../ansi');
const { expandHome, tabComplete } = require('../paths');
const { is } = require('./keys');
const { LineInput } = require('./line-input');

const { moveTo, clearLine } = screen;

/**
 * The profile → folder → typed path flow shared by "move" and "new session".
 *
 * Steps: 'profile' (skipped when there is only one), 'folder', 'input'.
 * Items are { type: 'profile' | 'folder' | 'same' | 'new', label, ... }.
 */
class Picker {
  /**
   * @param {object}   o
   * @param {string|(() => string)} o.headerLabel
   * @param {string}   [o.profileLabel]
   * @param {string}   o.inputPrompt
   * @param {() => object[]}         o.buildProfileItems
   * @param {(dir: string) => object[]} o.buildFolderItems
   * @param {(item: object) => void}  o.onConfirmItem    A folder or 'same' item was chosen
   * @param {(absPath: string) => void} o.onConfirmCustom A path was typed
   */
  constructor({ headerLabel, profileLabel = 'Select profile', inputPrompt,
                buildProfileItems, buildFolderItems, onConfirmItem, onConfirmCustom }) {
    this.headerLabel       = headerLabel;
    this.profileLabel      = profileLabel;
    this.inputPrompt       = inputPrompt;
    this.buildProfileItems = buildProfileItems;
    this.buildFolderItems  = buildFolderItems;
    this.onConfirmItem     = onConfirmItem;
    this.onConfirmCustom   = onConfirmCustom;

    this.field       = new LineInput();
    this.completions = [];
    this._showItems('profile', []);
    this.config = null;
  }

  enter() {
    this.config = null;
    this.field.set('');
    this.completions = [];
    this._showItems('profile', this.buildProfileItems());
    if (this.items.length === 1) this._enterFolderStep(this.items[0].configDirPath);
  }

  _showItems(step, items) {
    this.step   = step;
    this.items  = items;
    this.selIdx = 0;
    this.scroll = 0;
  }

  _enterFolderStep(configDirPath) {
    this.config = configDirPath;
    this._showItems('folder', this.buildFolderItems(configDirPath));
  }

  /** Returns false when the picker should close. */
  handleKey(key) {
    if (this.step === 'input') return this._handleInputKey(key);

    if (is(key, 'ESCAPE')) {
      const profiles = this.buildProfileItems();
      if (this.step === 'folder' && profiles.length > 1) { this._showItems('profile', profiles); return true; }
      return false;
    }
    if (is(key, 'UP')   || key === 'k') this.selIdx = Math.max(0, this.selIdx - 1);
    if (is(key, 'DOWN') || key === 'j') this.selIdx = Math.min(this.items.length - 1, this.selIdx + 1);

    if (is(key, 'ENTER')) {
      const item = this.items[this.selIdx];
      if (!item) return true;
      if (item.type === 'profile') this._enterFolderStep(item.configDirPath);
      else if (item.type === 'new') { this.step = 'input'; this.field.set('~/'); this.completions = []; }
      else this.onConfirmItem(item);
    }
    return true;
  }

  _handleInputKey(key) {
    if (is(key, 'ESCAPE')) {
      this.completions = [];
      this._showItems('folder', this.buildFolderItems(this.config));
    } else if (is(key, 'TAB')) {
      const { completed, matches } = tabComplete(this.field.text || '~/');
      this.field.set(completed);
      this.completions = matches.length > 1 ? matches : [];
    } else if (is(key, 'ENTER')) {
      const raw = this.field.text.trim();
      this.completions = [];
      if (raw) this.onConfirmCustom(path.resolve(expandHome(raw).replace(/[\\/]+$/, '') || path.sep));
      else this.step = 'folder';
    } else if (this.field.handle(key)) {
      this.completions = [];
    }
    return true;
  }

  /** Screen position [row, col] of the text cursor, or null outside the input step. */
  cursorPosition() {
    if (this.step !== 'input') return null;
    return [4, `  ${this.inputPrompt} `.length + [...this.field.before].length + 1];
  }

  /** Footer key hints for the current step. */
  hints() {
    if (this.step === 'profile') return '  ↑↓/jk=navigate  Enter=select profile  Esc=cancel';
    if (this.step === 'input')   return '  Tab=complete path  Enter=confirm  Esc=back';
    return '  ↑↓/jk=navigate  Enter=select  Esc=back';
  }

  render(out, W, H) {
    const header = typeof this.headerLabel === 'function' ? this.headerLabel() : this.headerLabel;
    out.push(moveTo(2, 1), clearLine, `  ${header}`);

    const divider = dim('─'.repeat(Math.max(0, W - 30)));
    const title = this.step === 'profile'
      ? bold(this.profileLabel)
      : bold('Select folder in ') + bold(fg('96', `[${path.basename(this.config)}]`));
    out.push(moveTo(3, 1), clearLine, `  ${title}  ${divider}`);

    let listStart = 4;
    if (this.step === 'input') {
      out.push(moveTo(4, 1), clearLine, `  ${fg('93', this.inputPrompt)} ${this.field.text}`);
      out.push(moveTo(5, 1), clearLine);
      if (this.completions.length > 1) {
        const cols = Math.max(1, Math.floor((W - 2) / 22));
        const rows = Math.ceil(this.completions.length / cols);
        for (let r = 0; r < Math.min(rows, H - 8); r++) {
          const names = this.completions.slice(r * cols, r * cols + cols).map(n => pad(n, 22)).join(' ');
          out.push(moveTo(r + 5, 1), clearLine, `  ${dim(names)}`);
        }
        listStart = H;
      } else {
        out.push(dim('  Tab to complete path'));
        listStart = 6;
      }
    }

    const items   = this.step === 'input' ? [] : this.items;
    const visible = Math.max(0, H - listStart - 1);
    if (this.selIdx < this.scroll) this.scroll = this.selIdx;
    if (this.selIdx >= this.scroll + visible) this.scroll = this.selIdx - visible + 1;
    if (this.scroll < 0) this.scroll = 0;

    for (let r = 0; r < visible; r++) {
      out.push(moveTo(listStart + r, 1), clearLine);
      const item = items[this.scroll + r];
      if (!item) continue;
      const isSelected = this.scroll + r === this.selIdx;
      const label = item.type === 'same'    ? (isSelected && COLOR ? fg('37', item.label) : dim(item.label))
                  : item.type === 'new'     ? fg('93', item.label)
                  : item.type === 'profile' ? bold(fg('96', item.label))
                  : fg('33', item.label);
      out.push(isSelected ? selectedLine(`   ${label}`, `   ${trunc(item.label, W - 5)}`, W) : `    ${label}`);
    }
  }
}

module.exports = { Picker };
