'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./support/helpers');
const { App } = require('../lib/tui/app');

const session = (i, title) => ({
  configDir: '.claude', configDirPath: '/c', project: '/p', sessionId: `s${i}`, title,
  firstMessage: 'hi', lastModified: new Date(Date.now() - i * 60000), size: 100, jsonlPath: `/c/s${i}.jsonl`,
});
const TAGS = ['reward', 'keycloak', 'personal', 'crm', 'dts', 'business', 'agent-gateway', 'learning'];
const app = (w, h) => {
  const a = new App(TAGS.map((t, i) => session(i, `${t}/x`)), {});
  a.w = w; a.h = h;
  return a;
};

describe('tags panel layout', () => {
  test('columns are as wide as their own widest tag (like ls)', () => {
    const { lines, colW } = app(80, 30)._tagLines(80);
    lines.forEach(line => line.forEach((e, k) => assert.ok(`${e.label} ${e.count}`.length <= colW[k])));
    assert.ok(colW.reduce((a, b) => a + b, 0) + 3 * (colW.length - 1) <= 80 - 4);
    assert.ok(Math.min(...colW) < Math.max(...colW)); // not one width for all
  });

  test('scrolls to keep the active tag in view and counts what is hidden', () => {
    const a = app(30, 30);
    a._selectTag('learning');
    const { shown, above, below } = a._tagLines(30, 1);
    assert.ok(shown[0].some(e => e.name === 'learning'));
    assert.ok(above > 0 && below > 0);
    assert.equal(above + below + shown[0].length, TAGS.length + 1); // + All
  });

  test('short screens: the panel shrinks, then hides; the list keeps 3 rows', () => {
    for (const h of [8, 10, 12, 14, 30]) {
      const a = app(60, h);
      assert.ok(a.listH >= 3, `h=${h} listH=${a.listH}`);
      assert.ok(a.tagPanelLines <= 3);
    }
    assert.equal(app(60, 8).tagPanelLines, 0);
  });

  test('the preview gives way to the list on short screens', () => {
    const a = app(60, 9);
    a.preview = true;
    assert.ok(a.listH >= 3);
  });
});
