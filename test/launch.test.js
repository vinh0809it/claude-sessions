'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { detectTerminal, resolveProjectPath, wtArgs } = require('../lib/launch');

describe('resolveProjectPath', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  test('returns hint file path when present and directory exists', () => {
    const sessionDir   = path.join(root, 'hint-test');
    const realProject  = path.join(root, 'real-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'abc.jsonl');
    writeJsonl(jsonlPath, [{ cwd: '/stale/path', timestamp: 1 }]);
    fs.writeFileSync(path.join(sessionDir, '.project-path'), realProject, 'utf8');

    assert.equal(resolveProjectPath({ jsonlPath, project: '/stale/path' }), realProject);
  });

  test('ignores hint file when path does not exist on disk', () => {
    const sessionDir   = path.join(root, 'bad-hint');
    const realProject  = path.join(root, 'real-proj-2');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'abc2.jsonl');
    writeJsonl(jsonlPath, [{ cwd: realProject, timestamp: 1 }]);
    // hint points to a path that does not exist
    fs.writeFileSync(path.join(sessionDir, '.project-path'), '/ghost/path', 'utf8');

    // should fall through to sibling / session.project
    const result = resolveProjectPath({ jsonlPath, project: realProject });
    assert.equal(result, realProject);
  });

  test('uses sibling session cwd when no hint file', () => {
    const sessionDir   = path.join(root, 'sibling-test');
    const realProject  = path.join(root, 'sibling-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const mainJsonl = path.join(sessionDir, 'main.jsonl');
    const sibJsonl  = path.join(sessionDir, 'sibling.jsonl');
    writeJsonl(mainJsonl, [{ cwd: '/stale', timestamp: 1 }]);
    writeJsonl(sibJsonl,  [{ cwd: realProject, timestamp: 2 }]);

    assert.equal(resolveProjectPath({ jsonlPath: mainJsonl, project: '/stale' }), realProject);
  });

  test('falls back to session.project when it exists and no siblings', () => {
    const sessionDir   = path.join(root, 'fallback-test');
    const realProject  = path.join(root, 'fallback-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'solo.jsonl');
    writeJsonl(jsonlPath, [{ cwd: realProject, timestamp: 1 }]);

    assert.equal(resolveProjectPath({ jsonlPath, project: realProject }), realProject);
  });

  test('falls back to home dir when all paths are missing', () => {
    const sessionDir = path.join(root, 'missing-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'ghost.jsonl');
    writeJsonl(jsonlPath, [{ cwd: '/does/not/exist', timestamp: 1 }]);

    assert.equal(
      resolveProjectPath({ jsonlPath, project: '/also/does/not/exist' }),
      os.homedir()
    );
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
