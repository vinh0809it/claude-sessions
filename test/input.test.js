'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { InputDecoder, PASTE, pastedText } = require('../lib/tui/input');

/** Keys from feeding `chunks` one after another, with the lone-ESC flush awaited. */
async function keysOf(...chunks) {
  const keys = [];
  const d = new InputDecoder(k => keys.push(...k));
  for (const c of chunks) d.feed(c);
  await new Promise(r => setTimeout(r, 50));
  return keys;
}

describe('InputDecoder', () => {
  test('splits keys, keeps escape sequences and multi-byte characters whole', async () => {
    assert.deepEqual(await keysOf('ab\x1b[A\x1b[5~\r\x7ftên😀'), ['a', 'b', '\x1b[A', '\x1b[5~', '\r', '\x7f', 't', 'ê', 'n', '😀']);
    assert.deepEqual(await keysOf('j\x1b[<64;10;5Mk'), ['j', '\x1b[<64;10;5M', 'k']);
  });

  test('a lone ESC becomes Escape after a pause; ESC + key is Alt+key', async () => {
    assert.deepEqual(await keysOf('\x1b'), ['\x1b']);
    assert.deepEqual(await keysOf('\x1bd'), ['\x1bd']);
    assert.deepEqual(await keysOf('\x1b', 'f'), ['\x1b', 'f']); // Escape, then f in a later read
  });

  test('sequences split at every byte decode the same', async () => {
    const whole = 'x\x1b[<35;10;8M\x1b[1;5D\x1bOH\x1b[200~a\rb\x1b[201~\x1b]11;rgb:1e1e/1e1e/2e2e\x07y';
    const expected = await keysOf(whole);
    assert.deepEqual(expected, ['x', '\x1b[<35;10;8M', '\x1b[1;5D', '\x1bOH', PASTE + 'a\rb', 'y']);
    for (let i = 1; i < whole.length; i++) {
      assert.deepEqual(await keysOf(whole.slice(0, i), whole.slice(i)), expected, `split at ${i}`);
    }
  });

  test('pasted text is one key, never commands', async () => {
    const [k] = await keysOf('\x1b[200~foo\rdy\x1b[201~');
    assert.equal(pastedText(k), 'foo\rdy');
    assert.equal(pastedText('d'), null);
  });

  test('drops OSC replies and X10 mouse reports', async () => {
    assert.deepEqual(await keysOf('\x1b]11;rgb:ffff/ffff/ffff\x1b\\q'), ['q']);
    assert.deepEqual(await keysOf('\x1b[M#dy', 'k'), ['k']); // coordinates "d", "y" are not keys
  });
});
