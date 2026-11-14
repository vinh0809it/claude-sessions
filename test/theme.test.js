'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isBasicColor, parseBackgroundReply, rgbTo256, themeFor } = require('../lib/tui/theme');

describe('parseBackgroundReply', () => {
  test('reads 16-bit and 8-bit channels, BEL or ST terminated', () => {
    assert.deepEqual(parseBackgroundReply('\x1b]11;rgb:1e1e/1e1e/2e2e\x07'), { r: 30, g: 30, b: 46 });
    assert.deepEqual(parseBackgroundReply('\x1b]11;rgb:ff/ff/ff\x1b\\'), { r: 255, g: 255, b: 255 });
  });
  test('null for anything else', () => {
    assert.equal(parseBackgroundReply('j'), null);
  });
});

describe('themeFor', () => {
  test('16-color terminals get inverse video, not a tint', () => {
    assert.equal(isBasicColor({ TERM: 'linux' }), true);
    assert.equal(isBasicColor({ TERM: 'xterm' }), true);
    assert.equal(isBasicColor({ TERM: 'xterm', COLORTERM: 'truecolor' }), false);
    assert.equal(isBasicColor({ TERM: 'xterm-256color' }), false);
    assert.equal(isBasicColor({}), false); // Windows: no TERM
    assert.equal(themeFor({ r: 0, g: 0, b: 0 }, { TERM: 'linux' }).basic, true);
  });
  test('unknown background: the default selection', () => {
    assert.deepEqual(themeFor(null, {}), { light: false, basic: false, selectedBg: '48;5;236', hoverBg: '48;5;235' });
  });
  test('dark background: a lighter tint, truecolor when supported', () => {
    assert.deepEqual(themeFor({ r: 30, g: 30, b: 46 }, { COLORTERM: 'truecolor' }),
      { light: false, basic: false, selectedBg: '48;2;59;59;73', hoverBg: '48;2;44;44;59' });
  });
  test('a background equal to the default selection still gets a visible tint', () => {
    assert.notEqual(themeFor({ r: 48, g: 48, b: 48 }, {}).selectedBg, '48;5;236');
  });
  test('light background: a darker tint and light-theme text colors', () => {
    const t = themeFor({ r: 255, g: 255, b: 255 }, {});
    assert.equal(t.light, true);
    assert.equal(t.selectedBg, `48;5;${rgbTo256({ r: 230, g: 230, b: 230 })}`);
  });
});
