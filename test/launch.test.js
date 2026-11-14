'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { detectTerminal, configDirEnv, findClaude, resolveProjectPath, wtArgs, tabCommand, runOpenCommand } = require('../lib/launch');
const { encodePathToDir } = require('../lib/paths');

describe('resolveProjectPath', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  // A projects/ folder named the way Claude Code names it for `project`.
  const folderFor = (project) => path.join(root, 'projects', encodePathToDir(project));

  test('uses the .project-path hint when that directory exists', () => {
    const project = path.join(root, 'hinted');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(root, 'projects', 'anything');
    writeJsonl(path.join(dir, 'a.jsonl'), [{ cwd: '/stale/path' }]);
    fs.writeFileSync(path.join(dir, '.project-path'), project, 'utf8');

    assert.equal(resolveProjectPath({ jsonlPath: path.join(dir, 'a.jsonl') }), project);
  });

  test('uses the cwd of a session that belongs to the folder, not one moved in', () => {
    const project = path.join(root, 'native');
    const other   = path.join(root, 'elsewhere');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const dir = folderFor(project);
    writeJsonl(path.join(dir, 'moved.jsonl'),  [{ cwd: other }]);
    writeJsonl(path.join(dir, 'native.jsonl'), [{ cwd: project }]);

    assert.equal(resolveProjectPath({ jsonlPath: path.join(dir, 'moved.jsonl') }), project);
  });

  test('null when the directory is gone (resuming elsewhere would start a new session)', () => {
    const project = path.join(root, 'deleted-project');
    const dir = folderFor(project);
    writeJsonl(path.join(dir, 'ghost.jsonl'), [{ cwd: project }]);

    assert.equal(resolveProjectPath({ jsonlPath: path.join(dir, 'ghost.jsonl') }), null);
  });

  test('null when only moved-in sessions exist and there is no hint', () => {
    const elsewhere = path.join(root, 'elsewhere-2');
    fs.mkdirSync(elsewhere, { recursive: true });
    const dir = path.join(root, 'projects', '-no-match');
    writeJsonl(path.join(dir, 'x.jsonl'), [{ cwd: elsewhere }]);

    assert.equal(resolveProjectPath({ jsonlPath: path.join(dir, 'x.jsonl') }), null);
  });
});

describe('detectTerminal', () => {
  const kitty = { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '2', KITTY_PID: '7805' };
  const gnome = { TERM: 'xterm-256color', VTE_VERSION: '8001', GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/x' };
  const cases = [
    ['nothing known', {}, 'here'],
    ['kitty', kitty, 'kitty'],
    ['kitty with TERM changed in its config', { TERM: 'xterm-256color', KITTY_WINDOW_ID: '1' }, 'kitty'],
    ['kitty over ssh (no window id)', { TERM: 'xterm-kitty' }, 'here'],
    ['tmux in kitty', { ...kitty, TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, 'tmux'],
    ['GNU screen in kitty', { ...kitty, TERM: 'screen', STY: '123.pts-1' }, 'here'],
    ['zellij in kitty', { ...kitty, TERM: 'xterm-256color', ZELLIJ: '0' }, 'here'],
    ['VS Code started from kitty', { ...kitty, TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }, 'here'],
    ['kitty started from VS Code', { ...kitty, TERM_PROGRAM: 'vscode' }, 'kitty'],
    ['JetBrains terminal started from kitty', { ...kitty, TERM: 'xterm-256color', TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, 'here'],
    ['ghostty started from kitty', { ...kitty, TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty' }, 'here'],
    ['alacritty started from kitty', { ...kitty, TERM: 'alacritty' }, 'here'],
    ['GNOME Terminal', gnome, 'gnome-terminal'],
    ['GNOME Terminal without VTE_VERSION (inherited)', { GNOME_TERMINAL_SCREEN: 'x' }, 'here'],
    ['alacritty started from GNOME Terminal', { ...gnome, TERM: 'alacritty' }, 'here'],
    ['Ptyxis', { TERM: 'xterm-256color', VTE_VERSION: '8001', PTYXIS_VERSION: '48.1' }, 'ptyxis'],
    ['Ptyxis started from kitty', { TERM: 'xterm-256color', KITTY_WINDOW_ID: '1', VTE_VERSION: '8001', PTYXIS_VERSION: '48.1' }, 'ptyxis'],
    ['kitty started from Ptyxis', { ...kitty, VTE_VERSION: '8001', PTYXIS_VERSION: '48.1' }, 'kitty'],
    ['tmux in Ptyxis', { TMUX: 'x', PTYXIS_VERSION: '48.1', VTE_VERSION: '8001' }, 'tmux'],
    ['WezTerm', { TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '0' }, 'wezterm'],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, 'iterm2'],
    ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }, 'apple-terminal'],
    ['override wins', { TMUX: 'x', CLAUDE_SESSIONS_TERMINAL: 'here' }, 'here'],
  ];
  for (const [name, env, expected] of cases) {
    test(name, () => assert.equal(detectTerminal(env, 'linux'), expected));
  }
  test('Windows Terminal on Windows only (WSL sees WT_SESSION too)', () => {
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'win32'), 'windows-terminal');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'linux'), 'here');
  });
});

describe('wtArgs', () => {
  test('opens a cmd tab with the profile set, escaping ";" for wt', () => {
    const args = wtArgs({ title: 'fix; login', cwd: 'C:\\Users\\Jo Doe\\app', configDirPath: 'C:\\Users\\Jo Doe\\.claude-work', args: ['-r', 'abc'] });
    assert.deepEqual(args, ['-w', '0', 'nt', '--title', 'fix\\; login', '-d', 'C:\\Users\\Jo Doe\\app',
      'cmd', '/k', 'set "CLAUDE_CONFIG_DIR=C:\\Users\\Jo Doe\\.claude-work"&& claude -r abc']);
  });
  test('quotes an absolute claude path and keeps & literal inside quotes', () => {
    const args = wtArgs({ title: 't', cwd: 'C:\\app', configDirPath: 'C:\\R&D\\.claude-work', args: [] },
      'C:\\Users\\Jo Doe\\.local\\bin\\claude.exe');
    assert.equal(args.at(-1), 'set "CLAUDE_CONFIG_DIR=C:\\R&D\\.claude-work"&& "C:\\Users\\Jo Doe\\.local\\bin\\claude.exe"');
  });
  test('refuses % in a path (cmd would expand it)', () => {
    assert.throws(() => wtArgs({ title: 't', cwd: 'C:\\app', configDirPath: 'C:\\100%\\.claude-work', args: [] }), /%/);
  });
});

describe('tabCommand', () => {
  const plan = { title: "it's", cwd: '/tmp/my proj', configDirPath: '/nonexistent/.claude-work', args: ['-r', 'abc'] };
  const bashC = (args) => { const i = args.indexOf('bash'); return args.slice(i, i + 3); };

  test('POSIX terminals run an interactive bash, so ~/.bashrc exports reach claude', () => {
    for (const t of ['kitty', 'wezterm', 'tmux', 'ptyxis', 'gnome-terminal']) {
      const [, args] = tabCommand(t, plan, '/bin/claude', {});
      assert.deepEqual(bashC(args), ['bash', '-i', '-c'], t);
      assert.match(args.at(-1), /cd '\/tmp\/my proj' && CLAUDE_CONFIG_DIR='\/nonexistent\/.claude-work' '\/bin\/claude' -r abc; exec/);
    }
  });
  test('tmux gets argv after --, so its default-shell never parses our quoting', () => {
    const [cmd, args] = tabCommand('tmux', plan, '/bin/claude', {});
    assert.equal(cmd, 'tmux');
    assert.deepEqual(args.slice(0, 4), ['new-window', '-n', "it's", '--']);
  });
  test('WezTerm uses WEZTERM_EXECUTABLE when set (macOS app bundle)', () => {
    assert.equal(tabCommand('wezterm', plan, '/bin/claude', { WEZTERM_EXECUTABLE: '/Applications/WezTerm.app/x/wezterm' })[0],
      '/Applications/WezTerm.app/x/wezterm');
    assert.equal(tabCommand('wezterm', plan, '/bin/claude', {})[0], 'wezterm');
  });
  test('Terminal.app/iTerm2 type only "/bin/bash <script>"; the script runs the plan and removes itself',
    { skip: process.platform === 'win32' }, () => {
      const root = makeTmp(['proj']);
      try {
        const marker = path.join(root, 'ran');
        const claude = path.join(root, 'claude');
        fs.writeFileSync(claude, `#!/bin/sh\npwd > '${marker}'\necho "$@" >> '${marker}'\n`, { mode: 0o755 });
        const p = { ...plan, cwd: path.join(root, 'proj') };
        for (const t of ['apple-terminal', 'iterm2']) {
          const [cmd, args, timeout] = tabCommand(t, p, claude, {});
          assert.equal(cmd, 'osascript');
          assert.ok(timeout >= 30000);
          const script = /\/bin\/bash '([^']+)'/.exec(args[1])[1];
          assert.ok(fs.existsSync(script));
          const r = require('child_process').spawnSync('bash', [script], { env: { ...process.env, SHELL: '/bin/true' } });
          assert.equal(r.status, 0, t);
          assert.equal(fs.readFileSync(marker, 'utf8'), `${p.cwd}\n-r abc\n`);
          assert.ok(!fs.existsSync(path.dirname(script)), 'script removed');
        }
      } finally { rmTmp(root); }
    });
  test('no tab command for "here" or unknown terminals', () => {
    assert.equal(tabCommand('here', plan, '/bin/claude', {}), null);
  });
});

describe('runOpenCommand (POSIX)', { skip: process.platform === 'win32' }, () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() => { rmTmp(root); });
  const plan = () => ({ title: 'T $x', cwd: root, configDirPath: '/nonexistent/.claude-work', args: [] });

  test('substitutes quoted placeholders', () => {
    const out = path.join(root, 'out');
    assert.deepEqual(runOpenCommand(`printf '%s|%s' %title% %project% > '${out}'`, plan(), '/bin/claude', false), { ok: true });
    assert.equal(fs.readFileSync(out, 'utf8'), `T $x|${root}`);
  });
  test('a command that keeps running (a terminal window) does not block', () => {
    const t0 = Date.now();
    assert.deepEqual(runOpenCommand('sleep 30', plan(), '/bin/claude', false), { ok: true });
    assert.ok(Date.now() - t0 < 3000);
  });
  test('a failing command is reported', () => {
    assert.equal(runOpenCommand('exit 3', plan(), '/bin/claude', false).ok, false);
  });
});

describe('configDirEnv', () => {
  const home = '/home/me';
  test('leaves it unset for the default ~/.claude, where the normal login lives', () => {
    assert.equal(configDirEnv('/home/me/.claude', {}, home), null);
  });
  test('sets it for other profiles', () => {
    assert.equal(configDirEnv('/home/me/.claude-work', {}, home), '/home/me/.claude-work');
  });
  test('keeps it when the user already sets it to that profile', () => {
    assert.equal(configDirEnv('/home/me/.claude', { CLAUDE_CONFIG_DIR: '/home/me/.claude/' }, home), '/home/me/.claude');
  });
  test('unsets an inherited value that points at another profile', () => {
    assert.equal(configDirEnv('/home/me/.claude', { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' }, home), null);
  });
});

describe('findClaude', () => {
  let root;
  before(() => { root = makeTmp(['bin', 'home/.claude/local', 'empty']); });
  after(() => { rmTmp(root); });
  const exe = (p) => { fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };

  test('prefers PATH', { skip: process.platform === 'win32' }, () => {
    const onPath = exe(path.join(root, 'bin', 'claude'));
    exe(path.join(root, 'home', '.claude', 'local', 'claude'));
    assert.equal(findClaude({ PATH: path.join(root, 'bin') }, path.join(root, 'home')), onPath);
  });
  test('falls back to ~/.claude/local (installs that only add a shell alias)', { skip: process.platform === 'win32' }, () => {
    const local = path.join(root, 'home', '.claude', 'local', 'claude');
    assert.equal(findClaude({ PATH: path.join(root, 'empty') }, path.join(root, 'home')), local);
  });
  test('null when nowhere to be found', { skip: process.platform === 'win32' }, () => {
    assert.equal(findClaude({ PATH: path.join(root, 'empty') }, path.join(root, 'empty')), null);
  });
  test('Windows: the native install location first', () => {
    const home = path.join(root, 'winhome');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude.exe'), '');
    assert.equal(findClaude({}, home, true), path.join(home, '.local', 'bin', 'claude.exe'));
  });
});
