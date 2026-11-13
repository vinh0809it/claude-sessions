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

describe('parseMouse', () => {
  const { parseMouse } = require('../lib/tui/keys');
  test('splitKeys keeps a mouse report whole', () => {
    assert.deepEqual(splitKeys('j\x1b[<64;10;5Mk'), ['j', '\x1b[<64;10;5M', 'k']);
  });
  test('wheel up / down, left click, release and other buttons', () => {
    assert.deepEqual(parseMouse('\x1b[<64;10;5M'), { x: 10, y: 5, wheel: -1, click: false, motion: false });
    assert.deepEqual(parseMouse('\x1b[<65;10;5M'), { x: 10, y: 5, wheel: 1, click: false, motion: false });
    assert.deepEqual(parseMouse('\x1b[<0;3;7M'),   { x: 3, y: 7, wheel: 0, click: true, motion: false });
    assert.equal(parseMouse('\x1b[<0;3;7m').click, false);   // release
    assert.equal(parseMouse('\x1b[<2;3;7M').click, false);   // right button
    assert.equal(parseMouse('\x1b[<68;3;7M').wheel, -1);     // wheel with Shift
    assert.equal(parseMouse('\x1b[A'), null);
  });
  test('pointer motion, with or without a button held', () => {
    assert.deepEqual(parseMouse('\x1b[<35;20;9M'), { x: 20, y: 9, wheel: 0, click: false, motion: true });
    assert.equal(parseMouse('\x1b[<32;20;9M').motion, true);
    assert.equal(parseMouse('\x1b[<32;20;9M').click, false);
  });
});
