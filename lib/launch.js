'use strict';

// Starting `claude` for a session: in a new terminal tab when the terminal
// supports it, otherwise in the current one.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectPathOf } = require('./sessions');

const IS_WINDOWS = process.platform === 'win32';

// Tab commands return at once; this keeps a stuck one (e.g. `kitty @` waiting
// for a reply that never comes) from freezing the UI.
const SPAWN_TIMEOUT_MS = 5000;

/**
 * kitty | wezterm | tmux | iterm2 | apple-terminal | windows-terminal | here
 * (`here` = run in the current terminal).
 */
function detectTerminal(env = process.env, platform = process.platform) {
  if (env.CLAUDE_SESSIONS_TERMINAL) return env.CLAUDE_SESSIONS_TERMINAL;
  // tmux first: it is always the innermost layer, and a tmux started from kitty or
  // WezTerm inherits their variables even though their tab commands can't reach it.
  if (env.TMUX)                              return 'tmux';
  if (env.KITTY_WINDOW_ID !== undefined)     return 'kitty';
  if (env.WEZTERM_PANE    !== undefined)     return 'wezterm';
  if (env.TERM_PROGRAM === 'iTerm.app')      return 'iterm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'apple-terminal';
  // WSL also sees WT_SESSION, but there `wt` would open a Windows shell, not Linux.
  if (env.WT_SESSION && platform === 'win32') return 'windows-terminal';
  return 'here';
}

/** POSIX shell single-quoting. */
function shellEsc(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** AppleScript string literal. */
function appleStr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function trySpawn(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: SPAWN_TIMEOUT_MS });
  if (r.error) {
    const reason = r.error.code === 'ENOENT' ? 'not found'
      : r.error.code === 'ETIMEDOUT' ? 'timed out'
      : r.error.message;
    return { ok: false, msg: `${cmd}: ${reason}` };
  }
  return r.status === 0
    ? { ok: true }
    : { ok: false, msg: r.stderr?.toString().trim() || `${cmd} exited with ${r.status}` };
}

/**
 * The directory to resume a session in, or null when it no longer exists.
 * `claude -r <id>` only finds a session from the directory its folder belongs
 * to; anywhere else it silently starts a new session.
 */
function resolveProjectPath(session) {
  const dir = projectPathOf(path.dirname(session.jsonlPath));
  return dir && fs.existsSync(dir) ? dir : null;
}

/**
 * @typedef {object} LaunchPlan
 * @property {string|null} cwd         Directory to start claude in (null: not found)
 * @property {string[]} args           Arguments for claude
 * @property {string}   configDirPath  CLAUDE_CONFIG_DIR for the profile
 * @property {string}   title          Tab title
 */

/** @returns {LaunchPlan} */
function resumePlan(session) {
  return {
    cwd:           resolveProjectPath(session),
    args:          ['-r', session.sessionId],
    configDirPath: session.configDirPath,
    title:         session.title || session.sessionId.slice(0, 8),
  };
}

/** @returns {LaunchPlan} */
function newPlan(configDirPath, projectPath) {
  return { cwd: projectPath, args: [], configDirPath, title: path.basename(projectPath) };
}

/**
 * The CLAUDE_CONFIG_DIR to run claude with for a profile, or null to leave it
 * unset. Claude Code keeps login state in ~/.claude.json when the variable is
 * unset but in $CLAUDE_CONFIG_DIR/.claude.json when it is set, so pointing it at
 * the default ~/.claude makes a logged-in install look logged out. A value the
 * user's own environment already sets for this profile is kept.
 */
function configDirEnv(configDirPath, env = process.env, home = os.homedir()) {
  const same = (a, b) => path.resolve(a) === path.resolve(b);
  if (env.CLAUDE_CONFIG_DIR && same(env.CLAUDE_CONFIG_DIR, configDirPath)) return configDirPath;
  return same(configDirPath, path.join(home, '.claude')) ? null : configDirPath;
}

/** A POSIX shell command that runs the plan and then leaves an interactive shell. */
function planShellCmd(plan) {
  const claude = ['claude', ...plan.args].join(' ');
  const dir = configDirEnv(plan.configDirPath);
  const env = dir ? `CLAUDE_CONFIG_DIR=${shellEsc(dir)} ` : 'unset CLAUDE_CONFIG_DIR; ';
  return `cd ${shellEsc(plan.cwd)} && ${env}${claude}; exec "\${SHELL:-bash}"`;
}

/**
 * `wt new-tab` arguments. wt treats ';' as a command separator, so it is
 * escaped; cmd's `set X=v&& …` takes everything up to && as the value.
 */
function wtArgs(plan) {
  const escSemi = v => String(v).replace(/;/g, '\\;');
  // `set X=` with no value removes X in cmd.
  const command = `set CLAUDE_CONFIG_DIR=${configDirEnv(plan.configDirPath) || ''}&& claude ${plan.args.join(' ')}`.trim();
  return ['-w', '0', 'nt', '--title', escSemi(plan.title), '-d', escSemi(plan.cwd), 'cmd', '/k', escSemi(command)];
}

/**
 * Opens the plan in a new tab. Returns { ok, msg }, or { here: true } when the
 * terminal has no tab support and the caller should use runHere().
 */
function launchInTab(plan) {
  const shellCmd = planShellCmd(plan);
  const template = process.env.CLAUDE_SESSIONS_OPEN_CMD;
  if (template) {
    const command = template
      .replace(/%cmd%/g,     shellEsc(shellCmd))
      .replace(/%title%/g,   shellEsc(plan.title))
      .replace(/%project%/g, shellEsc(plan.cwd));
    const r = spawnSync('bash', ['-c', command], { stdio: 'ignore' });
    return r.status === 0 ? { ok: true } : { ok: false, msg: `Custom open command failed (exit ${r.status})` };
  }

  switch (detectTerminal()) {
    case 'kitty':
      return trySpawn('kitty', ['@', 'launch', '--type=tab', `--tab-title=${plan.title}`, 'bash', '-i', '-c', shellCmd]);
    case 'wezterm':
      return trySpawn('wezterm', ['cli', 'spawn', '--', 'bash', '-i', '-c', shellCmd]);
    case 'tmux':
      return trySpawn('tmux', ['new-window', '-n', plan.title.slice(0, 20), `bash -i -c ${shellEsc(shellCmd)}`]);
    case 'iterm2':
      return trySpawn('osascript', ['-e',
        `tell application "iTerm2" to tell current window to create tab with default profile command ${appleStr('bash -i -c ' + shellEsc(shellCmd))}`]);
    case 'apple-terminal':
      return trySpawn('osascript', ['-e', `tell application "Terminal" to do script ${appleStr(shellCmd)}`]);
    case 'windows-terminal':
      return trySpawn('wt', wtArgs(plan));
    default:
      return { here: true };
  }
}

function claudeEnv(configDirPath) {
  const { CLAUDE_CONFIG_DIR: _, ...env } = process.env;
  const dir = configDirEnv(configDirPath);
  return dir ? { ...env, CLAUDE_CONFIG_DIR: dir } : env;
}

/** Runs claude in the current terminal and waits for it to exit. */
function runHere(plan) {
  const r = spawnSync('claude', plan.args, {
    cwd:   plan.cwd,
    env:   claudeEnv(plan.configDirPath),
    stdio: 'inherit',
    shell: IS_WINDOWS, // claude may be a .cmd shim on Windows
  });
  if (r.error) return { ok: false, msg: r.error.code === 'ENOENT' ? '`claude` not found on PATH' : r.error.message };
  return { ok: true };
}

module.exports = {
  detectTerminal, configDirEnv, resolveProjectPath, resumePlan, newPlan, wtArgs, launchInTab, runHere,
};
