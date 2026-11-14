'use strict';

// Plain-text helpers measured in terminal columns, not UTF-16 units: CJK and
// emoji take two columns, combining marks none. Ambiguous-width symbols
// (★ ● …) count as one, as most terminals draw them.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Whether the terminal takes UTF-8: from the locale (LC_ALL, LC_CTYPE, LANG,
 * the first one set). No locale at all, or Windows: assume it does.
 */
function isUtf8(env = process.env, platform = process.platform) {
  if (platform === 'win32') return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !locale || /utf-?8/i.test(locale);
}
const ELLIPSIS = isUtf8() ? '…' : '~';

// East Asian Wide and Fullwidth ranges (Unicode 15), by first code point.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u; // drawn as emoji, so two columns
const ZERO  = /^[\p{M}\u200B-\u200F\uFE00-\uFE0F]+$/u;

/** Columns one grapheme takes. */
function graphemeWidth(g) {
  if (ZERO.test(g)) return 0;
  const cp = g.codePointAt(0);
  if (cp < 0x7f) return 1; // fast path
  if (WIDE.test(g[0] + (g[1] || '')) || EMOJI.test(g)) return 2;
  return 1;
}

/** Columns a string takes (no escape sequences in it). */
function strWidth(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length; // fast path: ASCII
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWidth(segment);
  return w;
}

/** At most `n` columns, ending in "…" when cut; never splits a grapheme. */
function trunc(s, n) {
  if (n <= 0) return '';
  if (strWidth(s) <= n) return s;
  let out = '', w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const gw = graphemeWidth(segment);
    if (w + gw > n - 1) break;
    out += segment; w += gw;
  }
  return out + ELLIPSIS;
}

/** Exactly `n` columns: padded with spaces, or cut (without "…"). */
function pad(s, n) {
  if (n <= 0) return '';
  let w = strWidth(s);
  if (w > n) {
    let out = ''; w = 0;
    for (const { segment } of segmenter.segment(s)) {
      const gw = graphemeWidth(segment);
      if (w + gw > n) break;
      out += segment; w += gw;
    }
    s = out;
  }
  return s + ' '.repeat(n - w);
}

/**
 * Text from session files made safe to draw: control characters (escape
 * sequences, bell, backspace, C1) and runs of whitespace become one space.
 */
function clean(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // CSI / OSC sequences
    .replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ')
    .trim();
}

module.exports = { isUtf8, ELLIPSIS, strWidth, trunc, pad, clean };
