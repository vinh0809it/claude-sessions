'use strict';

const { screen, fg, dim, pad } = require('../ansi');

const { moveTo, clearLine } = screen;

const HELP = [
  ['↑↓ / j k', 'Navigate'],          ['PgUp PgDn', 'Page up / down'],
  ['g / G', 'Top / bottom'],         ['/', 'Search titles, first messages, folders'],
  ['f', 'Find text inside conversations (↑↓ select, Enter open, Tab keep filter)'],
  ['← → / h l', 'Choose a tag (side layout: ← to the Tags column, ↑↓ choose, → back)'],
  ['Esc', 'Clear search, tag and marks'], ['Enter', 'Open (new tab if supported, else here)'],
  ['o', 'Open in this terminal'],    ['p', 'Toggle preview'],
  ['F', 'Fork: resume as a new session, leaving this one as it is'],
  ['*', 'Pin / unpin (pinned stay on top)'],
  ['r', 'Rename'],                   ['s', 'Sort: date / size / name'],
  ['Space', 'Mark for bulk delete'], ['n', 'New session'],
  ['m', 'Move to profile / folder'], ['d', 'Delete marked or selected (to trash)'],
  ['u', 'Undo the last delete'],     ['t', 'Trash: restore, permanent delete, delete all'],
  ['q / Ctrl-C', 'Quit'],
  [',', 'Settings'],
  ['Mouse', 'Wheel scrolls, click selects, double-click opens'],
];

/** The key list; any key or click closes it. */
class HelpScreen {
  constructor(settingsFile) { this.settingsFile = settingsFile; }
  handleKey()   { return false; }
  clickRow()    { return false; }
  itemAt()      { return -1; }
  hints()       { return '  Press any key to close help'; }

  render(out) {
    HELP.forEach(([k, d], i) => out.push(moveTo(i + 3, 1), clearLine, `  ${fg('93', pad(k, 14))}${d}`));
    out.push(moveTo(HELP.length + 4, 1), dim(`  Settings (,) are saved in ${this.settingsFile}`));
  }
}

module.exports = { HelpScreen };
