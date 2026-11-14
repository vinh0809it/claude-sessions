'use strict';

// Turns raw stdin chunks into keys. Escape sequences can arrive split across
// reads (ssh, slow terminals), so an unfinished one waits for the next chunk; a
// lone ESC is only taken as the Escape key once nothing follows it shortly.
//
// Besides keys, a chunk can hold:
// - pasted text, between "\x1b[200~" and "\x1b[201~" (bracketed paste, turned
//   on with screen.pasteOn): delivered as one PASTE key, never as keystrokes;
// - replies to our own queries (OSC, e.g. the background color): dropped;
// - X10 mouse reports ("\x1b[M" + 3 bytes) from terminals without SGR mouse:
//   dropped, since their coordinate bytes would otherwise read as letters.
// Alt+key ("\x1b" + key) stays one key, so it never reads as Escape then key.

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';
/** Prefix of a PASTE key: the pasted text follows it. */
const PASTE = '\x1b[paste]';
const ESC_FLUSH_MS = 30;

// One complete token at the start of the buffer.
const TOKEN = new RegExp([
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/,   // OSC reply
  /\x1b\[M[\s\S]{3}/,                     // X10 mouse report
  /\x1b\[<[0-9;]*[Mm]/,                   // SGR mouse report
  /\x1b\[[0-9;?]*[A-Za-z~]/,              // CSI key (arrows, PgUp, …)
  /\x1bO[A-Za-z]/,                        // SS3 key (Home/End on some terminals)
  /\x1b[^\x1b\[\]O]/,                     // Alt+key
  /[^\x1b]/,                              // one character
].map(r => r.source).join('|'), 'yu');

// Starts of sequences that may still be completed by the next chunk.
const UNFINISHED = /^(?:\x1b(?:\[[0-9;?<]*|\[M[\s\S]{0,2}|\][^\x07\x1b]*(?:\x1b)?|O)?)$/u;

class InputDecoder {
  /** `onKeys(keys)` also receives keys that only become known later (a lone ESC). */
  constructor(onKeys) {
    this.onKeys = onKeys;
    this.rest   = '';
    this.paste  = null; // text so far while inside a bracketed paste
    this.timer  = null;
  }

  /** Decodes a chunk and passes its keys to onKeys. */
  feed(chunk) {
    clearTimeout(this.timer);
    // An ESC left from the previous read joins this one only to finish an escape
    // sequence; before a plain key it was the Escape key (Alt+key comes in one read).
    let buf = this.rest + chunk;
    const early = [];
    if (this.rest === '\x1b' && this.paste === null && !/^[\[\]O]/.test(chunk)) { early.push(KEY_ESCAPE); buf = chunk; }
    const keys = [...early, ...this.decode(buf)];
    if (keys.length) this.onKeys(keys);
    if (this.rest === '\x1b' || (this.rest && this.paste === null)) {
      // Nothing more came: what's left is an Escape (or garbage, dropped).
      this.timer = setTimeout(() => {
        const left = this.rest;
        this.rest = '';
        if (left === '\x1b') this.onKeys([KEY_ESCAPE]);
      }, ESC_FLUSH_MS);
    }
  }

  /** The keys in `buf`; an unfinished sequence at its end is kept in this.rest. */
  decode(buf) {
    const keys = [];
    let i = 0;
    this.rest = '';
    while (i < buf.length) {
      if (this.paste !== null) {
        const end = buf.indexOf(PASTE_END, i);
        if (end < 0) {
          // Keep a possible partial end marker for the next chunk.
          const keep = partialSuffix(buf.slice(i), PASTE_END);
          this.paste += buf.slice(i, buf.length - keep);
          this.rest = buf.slice(buf.length - keep);
          return keys;
        }
        keys.push(PASTE + this.paste + buf.slice(i, end));
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      if (buf.startsWith(PASTE_START, i)) { this.paste = ''; i += PASTE_START.length; continue; }
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(buf);
      const tail = buf.slice(i);
      if (!m || (UNFINISHED.test(tail) && tail.length < 64)) {
        if (UNFINISHED.test(tail) || PASTE_START.startsWith(tail)) { this.rest = tail; return keys; }
        i++; // an unknown escape sequence: skip its ESC
        continue;
      }
      const tok = m[0];
      i += tok.length;
      if (tok.startsWith('\x1b]') || tok.startsWith('\x1b[M')) continue; // dropped (see above)
      keys.push(tok);
    }
    return keys;
  }
}

const KEY_ESCAPE = '\x1b';

/** Length of the longest suffix of `s` that is a prefix of `marker`. */
function partialSuffix(s, marker) {
  for (let n = Math.min(s.length, marker.length - 1); n > 0; n--) {
    if (marker.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

/** The text of a PASTE key, or null for other keys. */
function pastedText(key) {
  return key.startsWith(PASTE) ? key.slice(PASTE.length) : null;
}

module.exports = { InputDecoder, PASTE, pastedText };
