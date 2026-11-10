'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp } = require('./support/helpers');
const { encodePathToDir, projectDirNameFor, tabComplete } = require('../lib/paths');

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

  test('dots, underscores and spaces also become hyphens (matches Claude Code)', () => {
    assert.equal(encodePathToDir('/home/u/.local/my_app v2'), '-home-u--local-my-app-v2');
  });

  test('windows paths', () => {
    assert.equal(encodePathToDir('C:\\Users\\me\\proj'), 'C--Users-me-proj');
  });
});

describe('projectDirNameFor', () => {
  let root;
  before(() => { root = makeTmp(['projects']); });
  after(() =>  { rmTmp(root); });

  test('short path: plain encoding', () => {
    assert.equal(projectDirNameFor(root, '/a/b.c'), '-a-b-c');
  });

  test('long path: reuses existing folder with the same 200-char prefix', () => {
    const long = '/' + 'x'.repeat(250);
    const existing = encodePathToDir(long).slice(0, 200) + '-abc123';
    fs.mkdirSync(path.join(root, 'projects', existing));
    assert.equal(projectDirNameFor(root, long), existing);
  });

  test('long path with no existing folder: throws', () => {
    assert.throws(() => projectDirNameFor(root, '/' + 'y'.repeat(250)), /too long/);
  });
});

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
