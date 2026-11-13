'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp } = require('./support/helpers');
const { fileContains, searchFiles } = require('../lib/content-search');

describe('content search', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() => { rmTmp(root); });

  test('finds text case-insensitively, including across a chunk boundary', async () => {
    const f = path.join(root, 'big.jsonl');
    // "Kiểm tra" straddles the 1 MiB chunk boundary, with multi-byte characters in it.
    const pad = 'x'.repeat(1024 * 1024 - 3);
    fs.writeFileSync(f, pad + 'Kiểm tra POS endpoint');
    assert.equal(await fileContains(f, 'kiểm tra pos'), true);
    assert.equal(await fileContains(f, 'not here'), false);
  });

  test('reports each matching file and stops when aborted', async () => {
    const a = path.join(root, 'a.jsonl'), b = path.join(root, 'b.jsonl');
    fs.writeFileSync(a, '{"text":"keycloak token"}');
    fs.writeFileSync(b, '{"text":"nothing"}');
    const found = [];
    await searchFiles([a, b, path.join(root, 'missing.jsonl')], 'TOKEN', { onMatch: p => found.push(p) });
    assert.deepEqual(found, [a]);

    const ctrl = new AbortController(); ctrl.abort();
    const none = [];
    await searchFiles([a], 'token', { signal: ctrl.signal, onMatch: p => none.push(p) });
    assert.deepEqual(none, []);
  });
});
