'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { detectTerminal, configDirEnv, findClaude, resolveProjectPath, wtArgs } = require('../lib/launch');
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
  test('falls back to opening in this terminal', () => {
    assert.equal(detectTerminal({}), 'here');
  });
  test('detects kitty, tmux, iTerm, Apple Terminal, honours override', () => {
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: '1' }), 'kitty');
    assert.equal(detectTerminal({ TMUX: '/tmp/x' }), 'tmux');
    assert.equal(detectTerminal({ TMUX: '/tmp/x', KITTY_WINDOW_ID: '1' }), 'tmux'); // tmux inside kitty
    assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }), 'apple-terminal');
    assert.equal(detectTerminal({ TMUX: 'x', CLAUDE_SESSIONS_TERMINAL: 'here' }), 'here');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'win32'), 'windows-terminal');
    assert.equal(detectTerminal({ PTYXIS_VERSION: '50.1', VTE_VERSION: '8401' }), 'ptyxis');
    assert.equal(detectTerminal({ GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/x' }), 'gnome-terminal');
    assert.equal(detectTerminal({ TMUX: 'x', PTYXIS_VERSION: '50.1' }), 'tmux');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'linux'), 'here'); // WSL
  });
});

describe('wtArgs', () => {
  test('opens a cmd tab with the profile set, escaping ";" for wt', () => {
    const args = wtArgs({ title: 'fix; login', cwd: 'C:\\Users\\Jo Doe\\app', configDirPath: 'C:\\Users\\Jo Doe\\.claude', args: ['-r', 'abc'] });
    assert.deepEqual(args, ['-w', '0', 'nt', '--title', 'fix\\; login', '-d', 'C:\\Users\\Jo Doe\\app',
      'cmd', '/k', 'set CLAUDE_CONFIG_DIR=C:\\Users\\Jo Doe\\.claude&& claude -r abc']);
  });
  test('quotes an absolute claude path (spaces in the user name)', () => {
    const args = wtArgs({ title: 't', cwd: 'C:\\app', configDirPath: 'C:\\Users\\Jo Doe\\.claude-work', args: [] },
      'C:\\Users\\Jo Doe\\.local\\bin\\claude.exe');
    assert.equal(args.at(-1), 'set CLAUDE_CONFIG_DIR=C:\\Users\\Jo Doe\\.claude-work&& "C:\\Users\\Jo Doe\\.local\\bin\\claude.exe"');
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
