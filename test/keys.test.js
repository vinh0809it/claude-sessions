'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
describe('parseMouse', () => {
  const { parseMouse } = require('../lib/tui/keys');
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
