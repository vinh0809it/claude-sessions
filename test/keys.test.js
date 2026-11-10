'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { splitKeys } = require('../lib/tui/keys');

describe('splitKeys', () => {
  test('splits pasted text, keeps escape sequences whole', () => {
    assert.deepEqual(splitKeys('ab\x1b[A\x1b[5~\r\x7f\x1b'), ['a', 'b', '\x1b[A', '\x1b[5~', '\r', '\x7f', '\x1b']);
  });
  test('keeps multi-byte characters intact', () => {
    assert.deepEqual(splitKeys('tên😀'), ['t', 'ê', 'n', '😀']);
  });
});
