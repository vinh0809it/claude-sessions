'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  encodePathToDir,
  tabComplete,
  resolveProjectPath,
  moveSession,
  readSession,
} = require('../index.js');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp(subdirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
  for (const d of subdirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

function rmTmp(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
}

// ── encodePathToDir ───────────────────────────────────────────────────────────

describe('encodePathToDir', () => {
  test('replaces all slashes with hyphens', () => {
    assert.equal(encodePathToDir('/home/user/projects/foo'), '-home-user-projects-foo');
  });

  test('root slash becomes single hyphen', () => {
    assert.equal(encodePathToDir('/'), '-');
  });

  test('no slashes: string unchanged', () => {
    assert.equal(encodePathToDir('foo'), 'foo');
  });
});

// ── tabComplete ───────────────────────────────────────────────────────────────

describe('tabComplete', () => {
  let root;
  before(() => { root = makeTmp(['alpha', 'beta', 'gamma/delta']); });
  after(() =>  { rmTmp(root); });

  test('single match: completes and appends slash', () => {
    const { completed, matches } = tabComplete(root + '/a');
    assert.equal(completed, root + '/alpha/');
    assert.deepEqual(matches, []);
  });

  test('no match: returns input unchanged with no matches', () => {
    const { completed, matches } = tabComplete(root + '/zzz');
    assert.equal(completed, root + '/zzz');
    assert.deepEqual(matches, []);
  });

  test('trailing slash: lists single subdir and completes', () => {
    const { completed, matches } = tabComplete(root + '/gamma/');
    assert.equal(completed, root + '/gamma/delta/');
    assert.deepEqual(matches, []);
  });

  test('multiple matches with extendable common prefix: extends to common prefix', () => {
    const sub = makeTmp(['barfoo', 'barbaz']);
    try {
      const { completed, matches } = tabComplete(sub + '/ba');
      assert.equal(completed, sub + '/bar');
      assert.deepEqual(matches.sort(), ['barbaz/', 'barfoo/']);
    } finally { rmTmp(sub); }
  });

  test('multiple matches with no further common prefix: returns input unchanged, shows options', () => {
    const sub = makeTmp(['bar', 'baz']);
    try {
      const { completed, matches } = tabComplete(sub + '/ba');
      assert.equal(completed, sub + '/ba');
      assert.deepEqual(matches.sort(), ['bar/', 'baz/']);
    } finally { rmTmp(sub); }
  });

  test('non-existent base dir: returns input unchanged', () => {
    const { completed, matches } = tabComplete('/nonexistent-xyz-dir/foo');
    assert.equal(completed, '/nonexistent-xyz-dir/foo');
    assert.deepEqual(matches, []);
  });
});

// ── readSession ───────────────────────────────────────────────────────────────

describe('readSession', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  test('reads title, firstMessage, cwd, timestamp from JSONL', () => {
    const f = path.join(root, 'session1.jsonl');
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'My Title' },
      { type: 'user', message: { content: 'Hello world' }, cwd: '/some/path', timestamp: 1000 },
    ]);
    const { title, firstUserMessage, cwd, timestamp } = readSession(f);
    assert.equal(title, 'My Title');
    assert.equal(firstUserMessage, 'Hello world');
    assert.equal(cwd, '/some/path');
    assert.equal(timestamp, 1000);
  });

  test('cwd from first record that has it', () => {
    const f = path.join(root, 'session2.jsonl');
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'T', cwd: '/first-cwd', timestamp: 1 },
      { type: 'user', message: { content: 'hi' }, cwd: '/second-cwd', timestamp: 2 },
    ]);
    const { cwd } = readSession(f);
    assert.equal(cwd, '/first-cwd');
  });

  test('skips malformed lines without throwing', () => {
    const f = path.join(root, 'session3.jsonl');
    fs.writeFileSync(f, 'not json\n{"type":"custom-title","customTitle":"T2"}\nbad too\n');
    const { title } = readSession(f);
    assert.equal(title, 'T2');
  });

  test('returns nulls for unreadable file', () => {
    const { title, firstUserMessage, cwd, timestamp } = readSession('/no/such/file.jsonl');
    assert.equal(title, null);
    assert.equal(firstUserMessage, null);
    assert.equal(cwd, null);
    assert.equal(timestamp, null);
  });

  test('extracts text from array content blocks', () => {
    const f = path.join(root, 'session4.jsonl');
    writeJsonl(f, [
      { type: 'user', message: { content: [{ type: 'text', text: 'Block message' }] }, cwd: '/p', timestamp: 1 },
    ]);
    const { firstUserMessage } = readSession(f);
    assert.equal(firstUserMessage, 'Block message');
  });
});

// ── resolveProjectPath ────────────────────────────────────────────────────────

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

// ── moveSession ───────────────────────────────────────────────────────────────

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
