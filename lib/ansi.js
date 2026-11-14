'use strict';

// Terminal escape sequences and text styling.
//
// Each style helper resets only its own attribute, so a row background survives
// nested colors. NO_COLOR (https://no-color.org) drops colors but keeps
// bold, dim and inverse.

const { groupOf } = require('./format');
const { isUtf8, ELLIPSIS, trunc, pad } = require('./text');

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
  // Mouse reporting in SGR encoding: presses, wheel and motion (for hover).
  mouseOn:    `${ESC}[?1003h${ESC}[?1006h`,
  mouseOff:   `${ESC}[?1006l${ESC}[?1003l`,
  // Pointer shape (OSC 22, kitty): push our own shape, change it, pop it on exit.
  pointerPush:  `${ESC}]22;>default${ESC}\\`,
  pointerShape: shape => `${ESC}]22;${shape}${ESC}\\`,
  pointerPop:   `${ESC}]22;<${ESC}\\`,
  // Pasted text arrives between markers instead of as keystrokes (see tui/input.js).
  pasteOn:    `${ESC}[?2004h`,
  pasteOff:   `${ESC}[?2004l`,
  // A frame drawn between these appears at once (terminals without support ignore them).
  syncStart:  `${ESC}[?2026h`,
  syncEnd:    `${ESC}[?2026l`,
  reset:      `${ESC}[0m`,
  moveTo:     (row, col) => `${ESC}[${row};${col}H`,
};

// Frame and marker glyphs; plain ASCII when the locale isn't UTF-8.
const G = isUtf8() ? {
  h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', lt: '├', rt: '┤',
  bar: '▌', mark: '●', pin: '★', up: '▲', down: '▼', dot: '·', prompt: '›', cross: '✗', ell: ELLIPSIS,
} : {
  h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', lt: '+', rt: '+',
  bar: '>', mark: '*', pin: '+', up: '^', down: 'v', dot: '-', prompt: '>', cross: 'x', ell: ELLIPSIS,
};

const bold = s => `${ESC}[1m${s}${ESC}[22m`;
const dim  = s => `${ESC}[2m${s}${ESC}[22m`;
const inv  = s => `${ESC}[7m${s}${ESC}[27m`;
const fg   = (code, s) => COLOR ? `${ESC}[${code}m${s}${ESC}[22;39m` : s;
const bg   = (code, s) => COLOR ? `${ESC}[${code}m${s}${ESC}[49m` : s;

// How the selected line is drawn. Updated once the terminal's background is
// known (see tui/theme.js); `light` picks text colors that read on it, `basic`
// (16-color terminals) uses inverse video instead of a tinted background.
const theme = { light: false, basic: false, selectedBg: '48;5;236', hoverBg: '48;5;235' };

/** Text colors on the selected line: muted text and session titles. */
const selectedColors = () => theme.light
  ? { muted: '90', title: '1;32' }
  : { muted: '37', title: '1;92' };

/**
 * A selected line: tinted background with an accent bar, or inverse video when
 * colors are off. `styled` must color every visible part explicitly so it reads
 * on the tint; `plain` is the same text without styling.
 */
function selectedLine(styled, plain, width) {
  return COLOR && !theme.basic
    ? `${ESC}[${theme.selectedBg}m${fg('96', G.bar)}${styled}${screen.clearToEnd}${screen.reset}`
    : inv(pad(` ${plain}`, width));
}

/** A line under the mouse pointer: a faint background, fainter than the selection. */
function hoverLine(styled) {
  return COLOR && !theme.basic ? `${ESC}[${theme.hoverBg}m${styled}${screen.clearToEnd}${screen.reset}` : styled;
}

/** A short span under the mouse pointer (a tag), on the same faint background. */
function hoverSpan(text) {
  return COLOR && !theme.basic ? `${ESC}[${theme.hoverBg}m${text}${ESC}[49m` : text;
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
  const group = groupOf(title);
  return group
    ? style('95', group + '/') + style(color, title.slice(group.length + 1))
    : style(color, title);
}

module.exports = {
  COLOR, G, screen,
  bold, dim, inv, fg, bg, trunc, pad,
  theme, selectedColors, selectedLine, hoverLine, hoverSpan, styleHints, groupTitle,
};
