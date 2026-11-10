'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fmtAgo } = require('../lib/format');

describe('fmtAgo', () => {
  test('picks the largest whole unit', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const ago = mins => fmtAgo(now - mins * 60000, now);
    assert.deepEqual([ago(0), ago(5), ago(125), ago(60 * 24 * 3), ago(60 * 24 * 65), ago(60 * 24 * 800)],
      ['just now', '5m ago', '2h ago', '3d ago', '2mo ago', '2y ago']);
  });
});
