'use strict';

const { is, isPrintable } = require('./keys');
const { pastedText } = require('./input');

// Word boundaries for Ctrl-←/→ and Ctrl-W, so "keycloak/fix-login" splits at / and -.
const WORD_SEP = /[\s/\-_.]/;

/**
 * A one-line text field with a movable cursor: ←/→, Home/End, Ctrl-←/→ by word,
 * Backspace/Delete at the cursor, Ctrl-U (delete to start), Ctrl-W (delete word).
 */
class LineInput {
  constructor(text = '') { this.set(text); }

  /** Replaces the text and puts the cursor at the end. */
  set(text) {
    this.chars  = [...text]; // code points, so the cursor never splits a character
    this.cursor = this.chars.length;
  }

  get text()   { return this.chars.join(''); }
  /** The text left of the cursor (its length is the cursor column). */
  get before() { return this.chars.slice(0, this.cursor).join(''); }

  /** Applies an editing key. Returns false when `key` is not one. */
  handle(key) {
    const c = this.chars;
    if      (is(key, 'LEFT'))       this.cursor = Math.max(0, this.cursor - 1);
    else if (is(key, 'RIGHT'))      this.cursor = Math.min(c.length, this.cursor + 1);
    else if (is(key, 'HOME'))       this.cursor = 0;
    else if (is(key, 'END'))        this.cursor = c.length;
    else if (is(key, 'WORD_LEFT'))  this.cursor = this._wordLeft();
    else if (is(key, 'WORD_RIGHT')) this.cursor = this._wordRight();
    else if (is(key, 'BACKSPACE'))  { if (this.cursor > 0) c.splice(--this.cursor, 1); }
    else if (is(key, 'DELETE'))     c.splice(this.cursor, 1);
    else if (is(key, 'KILL_LINE'))  { c.splice(0, this.cursor); this.cursor = 0; }
    else if (is(key, 'KILL_WORD'))  { const i = this._wordLeft(); c.splice(i, this.cursor - i); this.cursor = i; }
    else if (isPrintable(key) || pastedText(key) !== null) {
      // Pasted text goes in as one line: control characters and newlines become spaces.
      const text = pastedText(key) ?? key;
      const inserted = [...text.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ')];
      c.splice(this.cursor, 0, ...inserted);
      this.cursor += inserted.length;
    }
    else return false;
    return true;
  }

  _wordLeft() {
    let i = this.cursor;
    while (i > 0 && WORD_SEP.test(this.chars[i - 1])) i--;
    while (i > 0 && !WORD_SEP.test(this.chars[i - 1])) i--;
    return i;
  }

  _wordRight() {
    let i = this.cursor;
    const n = this.chars.length;
    while (i < n && WORD_SEP.test(this.chars[i])) i++;
    while (i < n && !WORD_SEP.test(this.chars[i])) i++;
    return i;
  }
}

module.exports = { LineInput };
