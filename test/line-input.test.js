'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LineInput } = require('../lib/tui/line-input');

describe('LineInput', () => {
  const type = (f, ...keys) => { for (const k of keys) f.handle(k); return f; };
  test('edits in the middle with arrows, backspace and delete', () => {
    const f = type(new LineInput('keycloak/fix-login'), '\x1b[H', '\x1b[3~', 'K', '\x1b[F', '\x7f', 'N');
    assert.equal(f.text, 'Keycloak/fix-logiN');
    type(f, '\x1b[D', '\x1b[D', '!');
    assert.equal(f.text, 'Keycloak/fix-log!iN');
    assert.equal(f.before, 'Keycloak/fix-log!');
  });
  test('Ctrl-W deletes the previous word, Ctrl-U clears to start', () => {
    const f = type(new LineInput('reward/fix-login'), '\x17');
    assert.equal(f.text, 'reward/fix-');
    type(f, '\x1b[1;5D', '\x15');
    assert.equal(f.text, 'fix-');
  });
  test('ignores non-editing keys, handles multi-byte chars', () => {
    const f = new LineInput('tên');
    assert.equal(f.handle('\x1b[A'), false);
    type(f, '\x1b[D', '\x7f');
    assert.equal(f.text, 'tn');
  });
});
