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
// for a reply that never comes) from freezing the UI. osascript gets longer:
// the first run waits for the user to answer macOS's Automation prompt.
const SPAWN_TIMEOUT_MS = 5000;
const OSASCRIPT_TIMEOUT_MS = 30000;

// TERM values of terminals other than kitty and the VTE ones (GNOME Terminal,
// Ptyxis). TERM is set by the terminal the shell really runs in, so it tells
// apart variables inherited from the terminal that launched it.
const OTHER_TERM = /^(alacritty|foot|xterm-ghostty|wezterm|rxvt|st-|konsole|contour|linux)/;

/**
 * kitty | wezterm | tmux | iterm2 | apple-terminal | ptyxis | gnome-terminal |
 * windows-terminal | here (`here` = run in the current terminal).
 */
function detectTerminal(env = process.env, platform = process.platform) {
  if (env.CLAUDE_SESSIONS_TERMINAL) return env.CLAUDE_SESSIONS_TERMINAL;
  // Terminals pass their variables on to everything started from them, so a VS
  // Code, Alacritty or GNU screen opened from a kitty shell still has
  // KITTY_WINDOW_ID. Multiplexers are the innermost layer and come first; then
  // TERM and TERM_PROGRAM, which the terminal we really run in sets itself.
  if (env.TMUX)             return 'tmux';
  if (env.STY || env.ZELLIJ) return 'here'; // screen, zellij: an outer terminal's tab command can't reach in
  if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'here';
  const term = env.TERM || '';
  if (term === 'xterm-kitty') return env.KITTY_WINDOW_ID !== undefined ? 'kitty' : 'here'; // no id: over ssh
  switch (env.TERM_PROGRAM) {
    case undefined: case '': case 'kitty': break;
    case 'iTerm.app':      return 'iterm2';
    case 'Apple_Terminal': return 'apple-terminal';
    case 'WezTerm':        return env.WEZTERM_PANE !== undefined ? 'wezterm' : 'here';
    default:               return 'here'; // vscode, ghostty, …: no tab command
  }
  if (OTHER_TERM.test(term)) return 'here';
  // kitty with TERM changed in its config (VTE_VERSION: a VTE terminal opened from kitty).
  if (env.KITTY_WINDOW_ID !== undefined && !env.VTE_VERSION) return 'kitty';
  if (env.WEZTERM_PANE    !== undefined && !env.VTE_VERSION) return 'wezterm';
  if (env.VTE_VERSION && env.PTYXIS_VERSION) return 'ptyxis';
  if (env.VTE_VERSION && (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE)) return 'gnome-terminal';
  // WSL also sees WT_SESSION, but there `wt` would open a Windows shell, not Linux.
  if (env.WT_SESSION && platform === 'win32') return 'windows-terminal';
  return 'here';
}

/** POSIX shell single-quoting. */
function shellEsc(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** AppleScript string literal. */
function appleStr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

/** Runs a tab-opening command. `missing` is set when the command isn't installed. */
function trySpawn(cmd, args, timeout = SPAWN_TIMEOUT_MS) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout });
  if (r.error) {
    if (r.error.code === 'ENOENT') return { ok: false, missing: true, msg: `${cmd}: not found` };
    const reason = r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message;
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
/**
 * @param {object} [o]
 * @param {boolean} [o.fork]  Resume into a new session id, leaving the original as it is
 * @returns {LaunchPlan}
 */
function resumePlan(session, { fork = false } = {}) {
  const title = session.title || session.sessionId.slice(0, 8);
  return {
    cwd:           resolveProjectPath(session),
    args:          ['-r', session.sessionId, ...(fork ? ['--fork-session'] : [])],
    configDirPath: session.configDirPath,
    title:         fork ? `fork: ${title}` : title,
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

function isExecutableFile(p) {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
}

/**
 * Absolute path of the claude executable: PATH first, then the installer's own
 * locations. Those matter because installs often reach claude through a shell
 * alias or an rc file (e.g. ~/.zshrc) that a spawned process or a new tab's
 * `bash -c` never sees. Returns null when not found.
 */
function findClaude(env = process.env, home = os.homedir(), windows = IS_WINDOWS) {
  if (windows) {
    // The native installer's location, which isn't always added to PATH.
    const native = path.join(home, '.local', 'bin', 'claude.exe');
    if (fs.existsSync(native)) return native;
    // Otherwise let cmd resolve it (it may be an npm .cmd shim), but only if it
    // exists: cmd just prints "not recognized" and exits, which looks like success.
    return spawnSync('where', ['claude'], { stdio: 'ignore', env }).status === 0 ? 'claude' : null;
  }
  const candidates = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'claude')),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
  ];
  return candidates.find(isExecutableFile) || null;
}

const CLAUDE_NOT_FOUND = '`claude` not found (looked in PATH, ~/.claude/local, ~/.local/bin)';

/**
 * A POSIX shell command that runs the plan and then leaves an interactive shell.
 * It carries this process's PATH so a new tab finds what our shell finds.
 */
function planShellCmd(plan, claudeBin) {
  const claude = [shellEsc(claudeBin), ...plan.args].join(' ');
  const dir = configDirEnv(plan.configDirPath);
  const env = dir ? `CLAUDE_CONFIG_DIR=${shellEsc(dir)} ` : 'unset CLAUDE_CONFIG_DIR; ';
  return `export PATH=${shellEsc(process.env.PATH || '')}; cd ${shellEsc(plan.cwd)} && ${env}${claude}; exec "\${SHELL:-bash}"`;
}

/**
 * The plan as a cmd.exe command line. Values are double-quoted, which keeps
 * & ^ ( ) literal; cmd expands %VAR% even inside quotes and a quote can't be
 * escaped, so paths with % or " are refused (throws).
 */
function cmdLine(plan, claudeBin = 'claude') {
  const dir = configDirEnv(plan.configDirPath) || '';
  for (const p of [dir, claudeBin]) {
    if (/[%"]/.test(p)) throw new Error(`can't pass a path containing % or " to cmd: ${p}`);
  }
  const claude = claudeBin === 'claude' ? claudeBin : `"${claudeBin}"`;
  // `set "X="` with no value removes X.
  return `set "CLAUDE_CONFIG_DIR=${dir}"&& ${claude} ${plan.args.join(' ')}`.trim();
}

/** `wt new-tab` arguments. wt treats ';' as a command separator, so it is escaped. Throws like cmdLine. */
function wtArgs(plan, claudeBin = 'claude') {
  const escSemi = v => String(v).replace(/;/g, '\\;');
  return ['-w', '0', 'nt', '--title', escSemi(plan.title), '-d', escSemi(plan.cwd), 'cmd', '/k', escSemi(cmdLine(plan, claudeBin))];
}

/**
 * Runs the custom open command. It may start a terminal that only returns once
 * its window closes (e.g. `alacritty -e …`), so it runs in the background and
 * counts as opened when it is still running after a second, or exited 0.
 *
 * POSIX: run by bash; %cmd% is a POSIX shell command, all values shell-quoted.
 * Windows: run by `cmd /c`; %cmd% is a cmd command line and values are
 * double-quoted, so use `start` in the template to open a window.
 */
function runOpenCommand(template, plan, claudeBin, windows = IS_WINDOWS) {
  if (windows) {
    let command;
    try { command = template.replace(/%cmd%/g, () => cmdLine(plan, claudeBin)); }
    catch (e) { return { ok: false, msg: e.message }; }
    command = command
      .replace(/%title%/g,   () => `"${plan.title.replace(/["%]/g, '')}"`)
      .replace(/%project%/g, () => `"${plan.cwd}"`);
    const r = spawnSync('cmd', ['/c', command], { stdio: 'ignore', windowsHide: true, timeout: SPAWN_TIMEOUT_MS });
    return r.status === 0 ? { ok: true } : { ok: false, msg: `Custom open command failed (${r.error?.code || `exit ${r.status}`})` };
  }
  const command = template
    .replace(/%cmd%/g,     () => shellEsc(planShellCmd(plan, claudeBin)))
    .replace(/%title%/g,   () => shellEsc(plan.title))
    .replace(/%project%/g, () => shellEsc(plan.cwd));
  const wrapper = `( ${command}\n) </dev/null >/dev/null 2>&1 & p=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $p 2>/dev/null || { wait $p; exit; }; sleep 0.1; done`;
  const r = spawnSync('bash', ['-c', wrapper], { stdio: 'ignore' });
  return r.status === 0 ? { ok: true } : { ok: false, msg: `Custom open command failed (exit ${r.status})` };
}

/**
 * A script file that runs `shellCmd` with bash and deletes itself, for
 * terminals that type a command into the user's login shell (Terminal.app,
 * iTerm2): the login shell then only sees `/bin/bash '<path>'`, which fish and
 * nu read the same as bash, instead of our POSIX quoting.
 */
function writeLaunchScript(shellCmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'open.sh');
  fs.writeFileSync(file, `rm -rf ${shellEsc(dir)}\n${shellCmd}\n`, { mode: 0o700 });
  return file;
}

/**
 * Opens the plan in a new tab. Returns { ok: true } (with `where: 'window'` when
 * it opened a window instead); { here: true } when the
 * terminal has no tab support and the caller should use runHere(); or
 * { ok: false, msg } on failure, with `fatal` when running here can't work either.
 *
 * `terminal` is a terminal name, or 'auto' to detect it; `openCommand`, when
 * set, replaces the built-in tab opening (placeholders %cmd% %title% %project%).
 */
function launchInTab(plan, { terminal = 'auto', openCommand = '' } = {}) {
  const target = terminal === 'auto' ? detectTerminal() : terminal;
  if (target === 'here') return { here: true }; // "here" wins over a custom open command
  const claudeBin = findClaude();
  if (!claudeBin) return { ok: false, fatal: true, msg: CLAUDE_NOT_FOUND };
  if (openCommand) return runOpenCommand(openCommand, plan, claudeBin);

  const result = openTab(target, plan, claudeBin);
  // A detected terminal whose CLI isn't installed (e.g. a Flatpak build): run here.
  return result.missing ? { here: true } : result;
}

/**
 * The command that opens `plan` in a new tab of `terminal`, as [cmd, args, timeout],
 * or null when the terminal has no tab command. Throws when the plan can't be
 * expressed for it (see cmdLine). The shell command runs in an interactive bash
 * (`-i`), so variables exported in ~/.bashrc (API keys, proxies) reach claude
 * as they would in a tab opened by hand. Terminal.app and iTerm2 don't need it:
 * their command runs from the user's own login shell, whose environment it inherits.
 */
function tabCommand(terminal, plan, claudeBin, env = process.env) {
  const shellCmd = () => planShellCmd(plan, claudeBin);
  switch (terminal) {
    case 'kitty':
      return ['kitty', ['@', 'launch', '--type=tab', `--tab-title=${plan.title}`, 'bash', '-i', '-c', shellCmd()]];
    case 'wezterm':
      return [env.WEZTERM_EXECUTABLE || 'wezterm', ['cli', 'spawn', '--', 'bash', '-i', '-c', shellCmd()]];
    case 'tmux':
      // argv form (tmux ≥ 3.0): tmux's default-shell (maybe fish) never parses it.
      return ['tmux', ['new-window', '-n', plan.title.slice(0, 20), '--', 'bash', '-i', '-c', shellCmd()]];
    case 'iterm2':
      return ['osascript', ['-e',
        `tell application "iTerm2" to tell current window to create tab with default profile command ${appleStr('/bin/bash ' + shellEsc(writeLaunchScript(shellCmd())))}`],
        OSASCRIPT_TIMEOUT_MS];
    case 'apple-terminal':
      return ['osascript', ['-e', `tell application "Terminal" to do script ${appleStr('/bin/bash ' + shellEsc(writeLaunchScript(shellCmd())))}`],
        OSASCRIPT_TIMEOUT_MS];
    case 'ptyxis':
      return ['ptyxis', ['--tab', '-d', plan.cwd, '-T', plan.title, '--', 'bash', '-i', '-c', shellCmd()]];
    case 'gnome-terminal':
      return ['gnome-terminal', ['--tab', `--working-directory=${plan.cwd}`, '--', 'bash', '-i', '-c', shellCmd()]];
    case 'windows-terminal':
      return ['wt', wtArgs(plan, claudeBin)];
    default:
      return null;
  }
}

function openTab(terminal, plan, claudeBin) {
  let command;
  try { command = tabCommand(terminal, plan, claudeBin); }
  catch (e) { return { ok: false, msg: e.message }; }
  if (!command) return { here: true };
  const result = trySpawn(...command);
  // Terminal.app's `do script` opens a window, not a tab.
  return result.ok && terminal === 'apple-terminal' ? { ok: true, where: 'window' } : result;
}

function claudeEnv(configDirPath) {
  const { CLAUDE_CONFIG_DIR: _, ...env } = process.env;
  const dir = configDirEnv(configDirPath);
  return dir ? { ...env, CLAUDE_CONFIG_DIR: dir } : env;
}

/** Runs claude in the current terminal and waits for it to exit. */
function runHere(plan) {
  const claudeBin = findClaude();
  if (!claudeBin) return { ok: false, msg: CLAUDE_NOT_FOUND };
  const r = spawnSync(claudeBin, plan.args, {
    cwd:   plan.cwd,
    env:   claudeEnv(plan.configDirPath),
    stdio: 'inherit',
    shell: IS_WINDOWS && claudeBin === 'claude', // may be a .cmd shim, which needs the shell
  });
  if (r.error) return { ok: false, msg: r.error.code === 'ENOENT' ? CLAUDE_NOT_FOUND : r.error.message };
  return { ok: true };
}

module.exports = {
  detectTerminal, configDirEnv, findClaude, resolveProjectPath, resumePlan, newPlan, wtArgs, launchInTab, runHere,
  tabCommand, runOpenCommand,
};
