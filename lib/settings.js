'use strict';

// User settings, editable from the TUI (",") and stored as JSON in
// $XDG_CONFIG_HOME/claude-sessions/config.json (%APPDATA% on Windows).
// An environment variable, when set, overrides the stored value.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TERMINALS = ['auto', 'here', 'kitty', 'wezterm', 'tmux', 'iterm2', 'apple-terminal',
                   'ptyxis', 'gnome-terminal', 'windows-terminal'];

/**
 * type: 'choice' (one of `choices`), 'bool' or 'text'.
 * `env` names the variable that overrides it; `fromEnv` converts its value.
 */
const SETTINGS = [
  {
    key: 'terminal', label: 'Open sessions in', type: 'choice', choices: TERMINALS, default: 'auto',
    env: 'CLAUDE_SESSIONS_TERMINAL',
    help: 'auto: a new tab when the terminal supports it, else here. here: always this terminal.',
  },
  {
    key: 'mouse', label: 'Mouse', type: 'bool', default: true,
    env: 'CLAUDE_SESSIONS_MOUSE', fromEnv: v => v !== '0',
    help: 'Wheel scrolls, click selects, double-click opens. Hold Shift to select text.',
  },
  {
    key: 'tagsLayout', label: 'Tags layout', type: 'choice', choices: ['top', 'side'], default: 'top',
    help: 'top: a panel above the list that wraps onto more lines. side: a column on the left (wide screens).',
  },
  {
    key: 'sort', label: 'Sort on start', type: 'choice', choices: ['date', 'size', 'name'], default: 'date',
    help: 'How the list is sorted when the tool opens (s cycles it).',
  },
  {
    key: 'preview', label: 'Preview on start', type: 'bool', default: false,
    help: 'Show recent messages of the selected session when the tool opens (p toggles it).',
  },
  {
    key: 'openCommand', label: 'Custom open command', type: 'text', default: '',
    env: 'CLAUDE_SESSIONS_OPEN_CMD',
    help: 'Replaces the built-in tab opening. Placeholders: %cmd% %title% %project%. Empty: built-in.',
  },
];

function defaultFile(env = process.env) {
  const base = process.platform === 'win32' && env.APPDATA
    ? env.APPDATA
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'claude-sessions', 'config.json');
}

/** A stored value that fits its setting's type, else undefined. The file is user-editable. */
function validate(def, value) {
  if (def.type === 'bool')   return typeof value === 'boolean' ? value : undefined;
  if (def.type === 'text')   return typeof value === 'string' ? value : undefined;
  if (def.type === 'choice') return def.choices.includes(value) ? value : undefined;
  return undefined;
}

class Settings {
  constructor(file = defaultFile(), env = process.env) {
    this.file = file;
    this.env  = env;
    this.values = {};
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const def of SETTINGS) {
        const v = validate(def, stored?.[def.key]);
        if (v !== undefined) this.values[def.key] = v;
      }
    } catch {} // missing or unreadable: defaults
  }

  definition(key) { return SETTINGS.find(d => d.key === key); }

  /** The environment variable overriding `key`, or null. */
  envOverride(key) {
    const def = this.definition(key);
    return def.env && this.env[def.env] !== undefined && this.env[def.env] !== '' ? def.env : null;
  }

  get(key) {
    const def = this.definition(key);
    const envName = this.envOverride(key);
    if (envName) return def.fromEnv ? def.fromEnv(this.env[envName]) : this.env[envName];
    return key in this.values ? this.values[key] : def.default;
  }

  /** Stores a value and writes the file atomically. Throws when it can't be saved. */
  set(key, value) {
    const def = this.definition(key);
    if (validate(def, value) === undefined) throw new Error(`invalid value for ${key}`);
    const values = { ...this.values, [key]: value };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.values = values;
  }
}

module.exports = { SETTINGS, TERMINALS, Settings, settings: new Settings() };
