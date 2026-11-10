'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { readSession, readRecentMessages, scanConfigDir, sortSessions, listProjectFolders } = require('../lib/sessions');
const { encodePathToDir } = require('../lib/paths');

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

  test('skips meta records and <system-reminder> wrappers for firstMessage', () => {
    const f = path.join(root, 'session5.jsonl');
    writeJsonl(f, [
      { type: 'user', isMeta: true, message: { content: 'meta stuff' }, cwd: '/p' },
      { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', message: { content: [{ type: 'text', text: '<command-name>/rename</command-name>' }, { type: 'text', text: 'real question' }] } },
    ]);
    assert.equal(readSession(f).firstUserMessage, 'real question');
  });

  test('keeps user prompts that merely start with "<" (pasted HTML)', () => {
    const f = path.join(root, 'session6.jsonl');
    writeJsonl(f, [{ type: 'user', message: { content: '<div>why is this broken</div>' } }]);
    assert.equal(readSession(f).firstUserMessage, '<div>why is this broken</div>');
  });

  test('large file: takes the last custom-title from the tail', () => {
    const f = path.join(root, 'big.jsonl');
    const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'z'.repeat(1000) }] } };
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'old' },
      { type: 'user', message: { content: 'first' }, cwd: '/p', timestamp: 1 },
      ...Array(800).fill(filler),
      { type: 'custom-title', customTitle: 'new' },
      ...Array(10).fill(filler),
    ]);
    assert.ok(fs.statSync(f).size > 512 * 1024, 'file exceeds head+tail window');
    const r = readSession(f);
    assert.equal(r.title, 'new');
    assert.equal(r.firstUserMessage, 'first');
    assert.equal(r.cwd, '/p');
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

describe('readRecentMessages', () => {
  test('returns last N user/assistant texts, skipping tool results', () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 's.jsonl');
      writeJsonl(f, [
        { type: 'user', message: { content: 'q1' } },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a1' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
        { type: 'user', message: { content: 'q2' } },
      ]);
      assert.deepEqual(readRecentMessages(f, 2), [{ role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }]);
    } finally { rmTmp(root); }
  });
});

describe('scanConfigDir', () => {
  test('uses the folder path for sessions whose cwd drifted, filters by path', () => {
    const root = makeTmp([]);
    try {
      const cfg = path.join(root, '.claude');
      const proj = '/home/u/my.app';
      const dir = path.join(cfg, 'projects', encodePathToDir(proj));
      writeJsonl(path.join(dir, 'a.jsonl'), [{ type: 'user', message: { content: 'a' }, cwd: proj }]);
      writeJsonl(path.join(dir, 'b.jsonl'), [{ type: 'user', message: { content: 'b' }, cwd: '/elsewhere' }]);
      const all = scanConfigDir(cfg, null);
      assert.equal(all.length, 2);
      assert.ok(all.every(s => s.project === proj));
      assert.ok(all.every(s => typeof s.size === 'number' && s.size > 0));
      assert.equal(scanConfigDir(cfg, '/home/u/my.app').length, 2);
      assert.equal(scanConfigDir(cfg, '/home/u/my').length, 0, 'prefix of a folder name is not a match');
    } finally { rmTmp(root); }
  });
});

describe('sortSessions', () => {
  const mk = (configDir, title, size, t) => ({ configDir, title, size, lastModified: new Date(t) });
  const list = [mk('.claude-a', 'b', 1, 3), mk('.claude-a', 'a', 5, 1), mk('.claude', 'c', 9, 2)];

  test('keeps profile grouping order, sorts within', () => {
    assert.deepEqual(sortSessions(list, 'size').map(s => s.title), ['a', 'b', 'c']);
    assert.deepEqual(sortSessions(list, 'name').map(s => s.title), ['a', 'b', 'c']);
    assert.deepEqual(sortSessions(list, 'date').map(s => s.title), ['b', 'a', 'c']);
  });
});

describe('listProjectFolders', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() => { rmTmp(root); });

  test('uses the cwd that matches the folder, skips folders with unknown paths', () => {
    const cfg  = path.join(root, '.claude');
    const api  = '/work/api', vault = '/notes/vault';
    const apiDir = path.join(cfg, 'projects', encodePathToDir(api));
    // A session moved here from elsewhere keeps its old cwd; it must not name the folder.
    writeJsonl(path.join(apiDir, 'moved.jsonl'), [{ type: 'user', cwd: vault, message: { content: 'hi' } }]);
    writeJsonl(path.join(apiDir, 'native.jsonl'), [{ type: 'user', cwd: api, message: { content: 'hi' } }]);
    fs.mkdirSync(path.join(cfg, 'projects', '-only-memory', 'memory'), { recursive: true });

    const folders = listProjectFolders(cfg);
    assert.deepEqual(folders.map(f => [f.projectDirName, f.projectPath]), [[encodePathToDir(api), api]]);
  });
});
