'use strict';

// Regressions in the session browser's state handling (no terminal involved).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./support/helpers');
const { App, asPaste } = require('../lib/tui/app');
const { PASTE } = require('../lib/tui/input');

const session = (i, title = `s${i}`) => ({
  configDir: '.claude', configDirPath: '/c', project: '/p', sessionId: `id${i}`, title,
  firstMessage: 'hi', lastModified: new Date(Date.now() - i * 60000), size: 100, jsonlPath: `/c/id${i}.jsonl`,
});
const app = (n, { w = 100, h = 30 } = {}) => {
  const a = new App(Array.from({ length: n }, (_, i) => session(i)), {});
  a.w = w; a.h = h;
  a.render = () => {}; // no terminal
  a.rebuild();
  return a;
};
const click = (x, y) => `\x1b[<0;${x};${y}M`;

describe('App', () => {
  test('the delete prompt names the marked session, not the one under the cursor', () => {
    const a = app(3);
    a.handleKey(' ');                       // marks s0, moves to s1
    a.handleKey('d');
    assert.equal(a.selectedSession().title, 's1');
    assert.match(a._footerText(100), /"s0"/);
  });

  test('narrowing the list never leaves it scrolled past its end', () => {
    const a = app(200);
    a.selIdx = 150; a.ensureVisible();
    a._startSearch('text');
    for (const ch of 's19') a.handleKey(ch);  // s19, s190…s199: 11 matches
    assert.equal(a.sessions.length, 11);
    assert.equal(a.scrollTop, 0);
    assert.equal(a.selIdx, 0);
  });

  test('the selection follows its session when the list changes', () => {
    const a = app(5);
    a.selectById('id3');
    a.all = [session(9), ...a.all];
    a.rebuild();
    assert.equal(a.selectedSession().sessionId, 'id3');
  });

  test('typing in the "f" popup drops the previous matches at once', () => {
    const a = app(3);
    a._startSearch('grep');
    a.contentMatches = new Set(['/c/id1.jsonl']);
    a.search = 'old'; a.searchField.set('old'); a.rebuild();
    assert.equal(a.sessions.length, 1);
    a.handleKey('x');
    assert.equal(a.sessions.length, 0);
  });

  test('clicks inside the "f" popup do not reach the list behind it', () => {
    const a = app(20);
    a._startSearch('grep');
    const { top, left } = a.view.findPopupBox();
    const before = a.selIdx;
    a.handleKey(click(left + 2, top + 1));
    a.handleKey(click(left + 2, top + 1));
    assert.equal(a.selIdx, before);
    assert.equal(a.mode, 'search');
  });

  test('a click on a too-small screen is ignored, not a crash', () => {
    const a = app(5, { w: 30, h: 6 });
    const before = a.selIdx;
    assert.doesNotThrow(() => a._onKeys([click(5, 4), click(5, 4), 'd', 'y']));
    assert.equal(a.mode, null);
    assert.equal(a.selIdx, before);
    assert.equal(a.all.length, 5);
  });

  test('turning the mouse off clears the hover highlight for good', () => {
    const a = app(5);
    a.handleKey(`\x1b[<35;10;${a.view.listTop + 1}M`);
    assert.ok(a.hover);
    a._mouseOff();
    a._updateHover();
    assert.equal(a.hover, null);
  });

  test('pasted text goes into the search field, never runs as keys', () => {
    const a = app(3);
    a._startSearch('text');
    a.handleKey(`${PASTE}foo\rdy`);
    assert.equal(a.mode, 'search');
    assert.equal(a.searchField.text, 'foo dy');
    a.searchField.set('');
    a.handleKey(`${PASTE}bar\n`); // a pasted line keeps no trailing space
    assert.equal(a.searchField.text, 'bar');
  });

  test('a burst of characters with Enter inside is taken as a paste', () => {
    assert.deepEqual(asPaste(['f', 'o', 'o', '\r', 'd', 'y']), [`${PASTE}foo\rdy`]);
    assert.deepEqual(asPaste(['j', 'j', 'j', '\r']), ['j', 'j', 'j', '\r']); // keys, then Enter
    assert.deepEqual(asPaste(['\x1b[A', '\r', 'd', 'y']), ['\x1b[A', '\r', 'd', 'y']);
  });
});
