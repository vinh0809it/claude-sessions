'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { strWidth, trunc, pad, clean, isUtf8 } = require('../lib/text');

describe('strWidth', () => {
  test('terminal columns: CJK and emoji 2, combining marks 0, symbols 1', () => {
    const cases = { abc: 3, '日本語': 6, '😀': 2, '✅': 2, '⭐': 2, '❤️': 2, '👍🏽': 2, '🇻🇳': 2,
      'é': 1, 'é': 1, '★': 1, '…': 1, '→': 1, '❤': 1 };
    for (const [s, w] of Object.entries(cases)) assert.equal(strWidth(s), w, s);
  });
});

describe('trunc / pad', () => {
  test('never split a character or exceed the width', () => {
    assert.equal(trunc('ab😀cd', 4), 'ab…');
    assert.equal(trunc('日本語のタイトル', 7), '日本語…');
    assert.equal(trunc('short', 10), 'short');
    assert.equal(pad('日本語のタイトル', 7), '日本語 ');
    assert.equal(strWidth(pad('😀x', 6)), 6);
  });
});

describe('clean', () => {
  test('strips escape sequences and control characters, collapses whitespace', () => {
    assert.equal(clean('a\x1b[31mb\x1b[0m \x1b]52;c;aGk=\x07c\x07\n\td'), 'ab c d');
    assert.equal(clean(42), '');
  });
});

describe('isUtf8', () => {
  test('from the first locale variable set', () => {
    assert.equal(isUtf8({ LANG: 'en_US.UTF-8' }, 'linux'), true);
    assert.equal(isUtf8({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }, 'linux'), false);
    assert.equal(isUtf8({}, 'linux'), true);
    assert.equal(isUtf8({ LANG: 'C' }, 'win32'), true);
  });
});
