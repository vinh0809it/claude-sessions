'use strict';

// Raw key sequences as delivered by a terminal in raw mode. Several keys have
// more than one encoding depending on the terminal (xterm, VTE, tmux, …).

const KEY = {
  ENTER:      '\r',
  TAB:        '\t',
  ESCAPE:     '\x1b',
  BACKSPACE:  ['\x7f', '\b'],
  DELETE:     '\x1b[3~',
  CTRL_C:     '\x03',
  UP:         '\x1b[A',
  DOWN:       '\x1b[B',
  PAGE_UP:    '\x1b[5~',
  PAGE_DOWN:  '\x1b[6~',
  LEFT:       ['\x1b[D', '\x02'],                       // ←, Ctrl-B
  RIGHT:      ['\x1b[C', '\x06'],                       // →, Ctrl-F
  HOME:       ['\x1b[H', '\x1bOH', '\x1b[1~', '\x01'],  // Home, Ctrl-A
  END:        ['\x1b[F', '\x1bOF', '\x1b[4~', '\x05'],  // End, Ctrl-E
  WORD_LEFT:  ['\x1b[1;5D', '\x1b[1;3D', '\x1bb'],      // Ctrl-←, Alt-←, Alt-b
  WORD_RIGHT: ['\x1b[1;5C', '\x1b[1;3C', '\x1bf'],      // Ctrl-→, Alt-→, Alt-f
  KILL_LINE:  '\x15',                                   // Ctrl-U
  KILL_WORD:  '\x17',                                   // Ctrl-W
};

/** True when `key` is `name` (a KEY entry with one or several encodings). */
function is(key, name) {
  const k = KEY[name];
  return Array.isArray(k) ? k.includes(key) : key === k;
}

/**
 * An SGR mouse report ("\x1b[<b;x;yM" press, "…m" release) as
 * { x, y, wheel: -1 | 1 | 0, click: true for a left-button press,
 *   motion: true when the pointer moved }, else null.
 * x and y are 1-based screen columns and rows.
 */
function parseMouse(key) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  if (!m) return null;
  const button = Number(m[1]) & ~(4 | 8 | 16); // drop Shift / Meta / Ctrl
  const press  = m[4] === 'M';
  return {
    x: Number(m[2]),
    y: Number(m[3]),
    wheel:  button === 64 ? -1 : button === 65 ? 1 : 0,
    click:  press && button === 0,
    motion: (button & 32) !== 0 && button < 64,
  };
}

function isPrintable(key) {
  return key.length >= 1 && !key.startsWith('\x1b') && [...key].every(ch => ch >= ' ' && ch !== '\x7f');
}

module.exports = { KEY, is, parseMouse, isPrintable };
