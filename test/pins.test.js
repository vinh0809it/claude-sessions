'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp } = require('./support/helpers');
const { Pins } = require('../lib/pins');

describe('Pins', () => {
  test('toggles, saves, and keeps pins made in another window', () => {
    const root = makeTmp([]);
    try {
      const file = path.join(root, 'pins.json');
      const a = new Pins(file), b = new Pins(file);
      assert.equal(a.toggle('x'), true);
      assert.equal(b.toggle('y'), true);
      assert.deepEqual(new Pins(file).ids, new Set(['x', 'y']));
      assert.equal(a.toggle('x'), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['y']);
    } finally { rmTmp(root); }
  });

  test('a broken file is kept as .bak, not overwritten', () => {
    const root = makeTmp([]);
    try {
      const file = path.join(root, 'pins.json');
      fs.writeFileSync(file, '["x",');
      const p = new Pins(file);
      assert.equal(p.has('x'), false);
      p.toggle('y');
      assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '["x",');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['y']);
    } finally { rmTmp(root); }
  });
});
