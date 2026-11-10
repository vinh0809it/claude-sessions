'use strict';

// Terminal escape sequences and text styling.
//
// Each style helper resets only its own attribute, so a row background survives
// nested colors. NO_COLOR (https://no-color.org) drops colors but keeps
// bold, dim and inverse.

const ESC = '\x1b';
const COLOR = !process.env.NO_COLOR;

const screen = {
  clearLine:  `${ESC}[2K`,
  clearToEnd: `${ESC}[K`,
  clear:      `${ESC}[2J`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  altBuffer:  `${ESC}[?1049h`,
  mainBuffer: `${ESC}[?1049l`,
  reset:      `${ESC}[0m`,
  moveTo:     (row, col) => `${ESC}[${row};${col}H`,
};

const bold = s => `${ESC}[1m${s}${ESC}[22m`;
const dim  = s => `${ESC}[2m${s}${ESC}[22m`;
const inv  = s => `${ESC}[7m${s}${ESC}[27m`;
const fg   = (code, s) => COLOR ? `${ESC}[${code}m${s}${ESC}[22;39m` : s;
const bg   = (code, s) => COLOR ? `${ESC}[${code}m${s}${ESC}[49m` : s;

const trunc = (s, n) => n > 0 && s.length > n ? s.slice(0, n - 1) + '…' : s;
const pad   = (s, n) => s.padEnd(n).slice(0, n);

const SELECTED_BG = `${ESC}[48;5;236m`;

/**
 * A selected line: dark background with an accent bar, or inverse video when
 * colors are off. `styled` must color every visible part explicitly so the line
 * stays readable on light themes; `plain` is the same text without styling.
 */
function selectedLine(styled, plain, width) {
  return COLOR
    ? `${SELECTED_BG}${fg('96', '▌')}${styled}${screen.clearToEnd}${screen.reset}`
    : inv(pad(` ${plain}`, width));
}

/** "Enter=open  /=search" → each key in bold, its label dimmed. */
function styleHints(s) {
  return s.replace(/(\S+)=(.+?)(?=  |$)/g, (_, key, label) => `${bold(key)} ${dim(label)}`);
}

/**
 * "keycloak/fix-login" → the group prefix gets its own color so related
 * sessions stand out. `style` lets plain-output callers pass their own helper.
 */
function groupTitle(title, color, style = fg) {
  const i = title.indexOf('/');
  return i > 0
    ? style('95', title.slice(0, i + 1)) + style(color, title.slice(i + 1))
    : style(color, title);
}

module.exports = {
  COLOR, screen,
  bold, dim, inv, fg, bg, trunc, pad,
  selectedLine, styleHints, groupTitle,
};
