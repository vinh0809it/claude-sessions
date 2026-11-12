'use strict';

// The selected line's background, derived from the terminal's own background so
// it stays visible on any theme: a little lighter on dark backgrounds, a little
// darker on light ones.
//
// The background is read with OSC 11 ("\x1b]11;?"), which kitty, WezTerm, tmux,
// VTE (GNOME Terminal, Ptyxis), iTerm2, Windows Terminal and xterm answer.
// Terminals that don't answer keep the default.

// Any OSC reply ("\x1b]…" ended by BEL or ST). Stripped from input so a late
// reply is never read as keystrokes.
const OSC_REPLY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const QUERY_TIMEOUT_MS = 150;

const DEFAULT_THEME = { light: false, selectedBg: '48;5;236' };

/** RGB (0–255) from an OSC 11 reply such as "\x1b]11;rgb:1e1e/1e1e/2e2e\x07". */
function parseBackgroundReply(reply) {
  const m = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const channel = hex => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255);
  return { r: channel(m[1]), g: channel(m[2]), b: channel(m[3]) };
}

/**
 * Asks the terminal for its background color. stdin must be in raw mode.
 * Resolves to RGB, or null when the terminal doesn't answer in time.
 */
function queryBackground(stdin = process.stdin, stdout = process.stdout, timeoutMs = QUERY_TIMEOUT_MS) {
  return new Promise(resolve => {
    let reply = '';
    const done = (rgb) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      resolve(rgb);
    };
    const onData = (chunk) => {
      reply += chunk;
      if (/\x07|\x1b\\/.test(reply)) done(parseBackgroundReply(reply));
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.on('data', onData);
    stdout.write('\x1b]11;?\x07');
  });
}

/** Nearest xterm-256 color (6×6×6 cube or gray ramp). */
function rgbTo256({ r, g, b }) {
  const levels  = [0, 95, 135, 175, 215, 255];
  const nearest = v => levels.reduce((best, l, i) => Math.abs(l - v) < Math.abs(levels[best] - v) ? i : best, 0);
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)];
  const cube = { code: 16 + 36 * ri + 6 * gi + bi, rgb: [levels[ri], levels[gi], levels[bi]] };
  const grayIdx = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = { code: 232 + grayIdx, rgb: Array(3).fill(8 + 10 * grayIdx) };
  const dist = c => (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
  return dist(gray) < dist(cube) ? gray.code : cube.code;
}

/** Selection colors for a terminal background `rgb` (null → defaults). */
function themeFor(rgb, env = process.env) {
  if (!rgb) return { ...DEFAULT_THEME };
  const light  = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.5;
  const target = light ? 0 : 255;
  const t      = light ? 0.10 : 0.13;
  const tint   = {
    r: Math.round(rgb.r + (target - rgb.r) * t),
    g: Math.round(rgb.g + (target - rgb.g) * t),
    b: Math.round(rgb.b + (target - rgb.b) * t),
  };
  const truecolor = /^(truecolor|24bit)$/i.test(env.COLORTERM || '');
  return {
    light,
    selectedBg: truecolor ? `48;2;${tint.r};${tint.g};${tint.b}` : `48;5;${rgbTo256(tint)}`,
  };
}

module.exports = { OSC_REPLY_RE, DEFAULT_THEME, parseBackgroundReply, queryBackground, rgbTo256, themeFor };
