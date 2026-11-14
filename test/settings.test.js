'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp } = require('./support/helpers');
const { Settings } = require('../lib/settings');

describe('Settings', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() => { rmTmp(root); });

  test('defaults when there is no file', () => {
    const s = new Settings(path.join(root, 'none', 'config.json'), {});
    assert.equal(s.get('terminal'), 'auto');
    assert.equal(s.get('mouse'), true);
    assert.equal(s.get('openCommand'), '');
  });

  test('set() saves, and a new instance reads it back', () => {
    const file = path.join(root, 'a', 'config.json');
    new Settings(file, {}).set('terminal', 'here');
    assert.equal(new Settings(file, {}).get('terminal'), 'here');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { terminal: 'here' });
  });

  test('ignores values of the wrong type in a hand-edited file', () => {
    const file = path.join(root, 'b', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ terminal: 'nope', mouse: 'yes', sort: 'size' }));
    const s = new Settings(file, {});
    assert.equal(s.get('terminal'), 'auto');
    assert.equal(s.get('mouse'), true);
    assert.equal(s.get('sort'), 'size');
  });

  test('a broken file falls back to defaults', () => {
    const file = path.join(root, 'c', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.equal(new Settings(file, {}).get('sort'), 'date');
  });

  test('an environment variable overrides the stored value', () => {
    const file = path.join(root, 'd', 'config.json');
    new Settings(file, {}).set('mouse', true);
    const s = new Settings(file, { CLAUDE_SESSIONS_MOUSE: '0', CLAUDE_SESSIONS_TERMINAL: 'tmux' });
    assert.equal(s.get('mouse'), false);
    assert.equal(s.get('terminal'), 'tmux');
    assert.equal(s.envOverride('mouse'), 'CLAUDE_SESSIONS_MOUSE');
    assert.equal(s.envOverride('sort'), null);
  });

  test('saving keeps changes from another window and unknown keys', () => {
    const file = path.join(root, 'f', 'config.json');
    const a = new Settings(file, {}), b = new Settings(file, {});
    a.set('sort', 'size');
    b.set('preview', true);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), future: 1 }));
    a.set('mouse', false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sort: 'size', preview: true, future: 1, mouse: false });
  });

  test('saving over a broken file keeps it as .bak', () => {
    const file = path.join(root, 'g', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "sort": "size", oops');
    new Settings(file, {}).set('preview', true);
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{ "sort": "size", oops');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { preview: true });
  });

  test('rejects invalid values', () => {
    const s = new Settings(path.join(root, 'e', 'config.json'), {});
    assert.throws(() => s.set('sort', 'random'));
  });
});
