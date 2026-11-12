'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { detectTerminal, configDirEnv, resolveProjectPath, wtArgs } = require('../lib/launch');
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
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'linux'), 'here'); // WSL
  });
});

describe('wtArgs', () => {
  test('opens a cmd tab with the profile set, escaping ";" for wt', () => {
    const args = wtArgs({ title: 'fix; login', cwd: 'C:\\Users\\Jo Doe\\app', configDirPath: 'C:\\Users\\Jo Doe\\.claude', args: ['-r', 'abc'] });
    assert.deepEqual(args, ['-w', '0', 'nt', '--title', 'fix\\; login', '-d', 'C:\\Users\\Jo Doe\\app',
      'cmd', '/k', 'set CLAUDE_CONFIG_DIR=C:\\Users\\Jo Doe\\.claude&& claude -r abc']);
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
