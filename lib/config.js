'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expandHome } = require('./paths');

const USAGE = `\
claude-sessions — Terminal UI for Claude Code sessions

Usage:
  claude-sessions [folder]        TUI, optionally filtered by folder path
  claude-sessions --list [folder] Plain list output
  claude-sessions --named-only    Only /rename'd sessions
  claude-sessions --json          JSON output
  claude-sessions -d <path>       Scan a specific config dir
  claude-sessions --empty-trash   Permanently remove deleted sessions
  claude-sessions --no-cache      Ignore the metadata cache
  claude-sessions --version       Print version
  claude-sessions -h              Help

TUI keys:
  ↑ ↓  j k         Navigate
  PgUp PgDn        Page up / down
  g G              Jump to top / bottom
  /                Search titles, first messages, folders (↑↓ select, Enter open, Tab keep filter)
  f                Find text inside conversations
  ← →  h l         Choose a tag (title prefix before "/"); side layout: ← to the Tags column, ↑↓, →
  Esc              Clear search, tag and marks
  Enter            Open session (new tab if supported, else here)
  o                Open session in this terminal
  p                Toggle preview of recent messages
  r                Rename session
  s                Cycle sort: date / size / name
  Space            Mark session (for bulk delete)
  n                New session
  m                Move session to another config / folder
  d                Delete session(s) to trash
  u                Undo the last delete
  t                Trash: restore, permanently delete one (x) or all (X)
  ,                Settings (saved to ~/.config/claude-sessions/config.json)
  ?                Help
  q  Ctrl-C        Quit

Environment variables (override the matching settings):
  CLAUDE_SESSIONS_TERMINAL    Force terminal: kitty | wezterm | tmux | iterm2 | apple-terminal | ptyxis | gnome-terminal | windows-terminal | here
  CLAUDE_SESSIONS_OPEN_CMD    Custom open command (placeholders: %cmd% %title% %project%)
  CLAUDE_CONFIG_DIR           Also scanned when set
  CLAUDE_SESSIONS_MOUSE=0     Turn off mouse support (wheel, click, double-click to open)
  NO_COLOR                    Disable colors`;

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    dir: null, namedOnly: false, json: false, list: false, help: false, version: false,
    filterPath: null, emptyTrash: false, noCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '-d' || a === '--dir')     opts.dir = argv[++i];
    else if (a === '--named-only')            opts.namedOnly = true;
    else if (a === '--json')                  opts.json = true;
    else if (a === '--list')                  opts.list = true;
    else if (a === '--empty-trash')           opts.emptyTrash = true;
    else if (a === '--no-cache')              opts.noCache = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '-h' || a === '--help')    opts.help = true;
    else if (!a.startsWith('-'))              opts.filterPath = path.resolve(expandHome(a));
  }
  return opts;
}

function hasProjects(dir) {
  try { return fs.statSync(path.join(dir, 'projects')).isDirectory(); } catch { return false; }
}

/**
 * Every Claude Code config dir: ~/.claude, ~/.claude-*, and $CLAUDE_CONFIG_DIR.
 * Named profiles come first, the default ~/.claude last.
 */
function discoverConfigDirs() {
  const home = os.homedir();
  let dirs = [];
  try {
    dirs = fs.readdirSync(home)
      .filter(n => n === '.claude' || n.startsWith('.claude-'))
      .map(n => path.join(home, n));
  } catch {}
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  return [...new Set(dirs)]
    .filter(hasProjects)
    .sort((a, b) => {
      const na = path.basename(a), nb = path.basename(b);
      if (na === '.claude') return 1;
      if (nb === '.claude') return -1;
      return na.localeCompare(nb);
    });
}

module.exports = { USAGE, parseArgs, discoverConfigDirs };
