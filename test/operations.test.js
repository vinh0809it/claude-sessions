'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { deleteSessionFiles, emptyTrash, moveSession, renameSession } = require('../lib/operations');
const { readSession } = require('../lib/sessions');

describe('moveSession', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  function makeSession(configDir, projectDirName, sessionId = 'sess') {
    const projectDir = path.join(root, configDir, 'projects', projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeJsonl(jsonlPath, [{ cwd: '/some/project', type: 'user', message: { content: 'hi' }, timestamp: 1 }]);
    return { jsonlPath, sessionId, configDir, configDirPath: path.join(root, configDir), project: '/some/project' };
  }

  test('moves jsonl to target config dir and updates session fields', () => {
    const session = makeSession('src-a', '-proj', 's1');
    const targetConfig = path.join(root, 'dst-a');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj');

    assert.ok(fs.existsSync(session.jsonlPath), 'file exists at new path');
    assert.ok(session.jsonlPath.includes('dst-a'), 'jsonlPath updated to target config');
    assert.equal(session.configDir, 'dst-a');
    assert.equal(session.configDirPath, targetConfig);
  });

  test('preserves source dir name when targetProjectDirName is null', () => {
    const session = makeSession('src-b', '-keep-dir', 's2');
    const targetConfig = path.join(root, 'dst-b');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, null);

    assert.ok(session.jsonlPath.includes('-keep-dir'), 'dir name preserved');
  });

  test('writes .project-path hint when targetRawPath provided', () => {
    const session = makeSession('src-c', '-proj2', 's3');
    const targetConfig = path.join(root, 'dst-c');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });
    const rawPath = '/home/user/real-project';

    moveSession(session, targetConfig, '-proj2', rawPath);

    const hintFile = path.join(path.dirname(session.jsonlPath), '.project-path');
    assert.ok(fs.existsSync(hintFile));
    assert.equal(fs.readFileSync(hintFile, 'utf8'), rawPath);
  });

  test('does not write .project-path when targetRawPath is null', () => {
    const session = makeSession('src-d', '-proj3', 's4');
    const targetConfig = path.join(root, 'dst-d');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj3', null);

    const hintFile = path.join(path.dirname(session.jsonlPath), '.project-path');
    assert.ok(!fs.existsSync(hintFile), '.project-path not written');
  });

  test('moves companion dir alongside the jsonl file', () => {
    const session      = makeSession('src-e', '-proj4', 's5');
    const companionDir = session.jsonlPath.replace('.jsonl', '');
    fs.mkdirSync(companionDir, { recursive: true });
    fs.writeFileSync(path.join(companionDir, 'artifact.txt'), 'data');
    const targetConfig = path.join(root, 'dst-e');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj4');

    const newCompanion = session.jsonlPath.replace('.jsonl', '');
    assert.ok(fs.existsSync(newCompanion), 'companion dir moved');
    assert.ok(fs.existsSync(path.join(newCompanion, 'artifact.txt')), 'companion contents intact');
  });
});

describe('renameSession', () => {
  test('appends a custom-title record that readSession picks up', () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 's.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'hi' } })); // no trailing newline
      const s = { jsonlPath: f, sessionId: 's' };
      renameSession(s, '  my name ');
      assert.equal(s.title, 'my name');
      assert.equal(readSession(f).title, 'my name');
      assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2);
    } finally { rmTmp(root); }
  });

  test('rejects empty title', () => {
    assert.throws(() => renameSession({ jsonlPath: '/x', sessionId: 'x' }, '   '), /empty/);
  });
});

describe('deleteSessionFiles + emptyTrash', () => {
  test('moves jsonl and companion dir to trash, emptyTrash frees it', () => {
    const root = makeTmp([]);
    try {
      const cfg = path.join(root, '.claude');
      const jsonlPath = path.join(cfg, 'projects', '-p', 'abc.jsonl');
      writeJsonl(jsonlPath, [{ type: 'user', message: { content: 'hi' } }]);
      fs.mkdirSync(path.join(cfg, 'projects', '-p', 'abc'));
      fs.writeFileSync(path.join(cfg, 'projects', '-p', 'abc', 'x.txt'), 'data');

      deleteSessionFiles({ jsonlPath, configDirPath: cfg });

      assert.ok(!fs.existsSync(jsonlPath));
      assert.ok(fs.existsSync(path.join(cfg, '.claude-sessions-trash', '-p', 'abc.jsonl')));
      assert.ok(fs.existsSync(path.join(cfg, '.claude-sessions-trash', '-p', 'abc', 'x.txt')));
      assert.ok(emptyTrash([cfg]) > 0);
      assert.ok(!fs.existsSync(path.join(cfg, '.claude-sessions-trash')));
    } finally { rmTmp(root); }
  });
});
