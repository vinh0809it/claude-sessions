'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { findInConversation, searchFiles } = require('../lib/content-search');

const user = text => ({ type: 'user', message: { content: text } });
const claude = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolOutput = text => ({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });

describe('findInConversation', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() => { rmTmp(root); });

  test('matches what you and Claude wrote, case-insensitively, not tool output', async () => {
    const f = path.join(root, 'a.jsonl');
    writeJsonl(f, [user('check the hold endpoint'), toolOutput('ERROR in hold endpoint log'), claude('The Hold Endpoint returns 403')]);
    assert.deepEqual(await findInConversation(f, 'hold endpoint'), [
      { role: 'user', text: 'check the hold endpoint' },
      { role: 'assistant', text: 'The Hold Endpoint returns 403' },
    ]);
    assert.deepEqual(await findInConversation(f, 'error in'), []); // only in tool output
  });

  test('finds a message spanning the chunk boundary, with multi-byte text', async () => {
    const f = path.join(root, 'big.jsonl');
    const filler = JSON.stringify(user('x'.repeat(1024 * 1024 - 40)));
    fs.writeFileSync(f, filler + '\n' + JSON.stringify(user('Kiểm tra POS endpoint')) + '\n');
    assert.equal((await findInConversation(f, 'kiểm tra pos')).length, 1);
  });

  test('stops after a few matches', async () => {
    const f = path.join(root, 'many.jsonl');
    writeJsonl(f, Array.from({ length: 10 }, (_, i) => user(`token ${i}`)));
    assert.equal((await findInConversation(f, 'token')).length, 3);
  });
});

describe('searchFiles', () => {
  test('reports matching files with their matches and stops when aborted', async () => {
    const root = makeTmp([]);
    try {
      const a = path.join(root, 'a.jsonl'), b = path.join(root, 'b.jsonl');
      writeJsonl(a, [user('keycloak token')]);
      writeJsonl(b, [user('nothing')]);
      const found = [];
      await searchFiles([a, b, path.join(root, 'missing.jsonl')], 'TOKEN', { onMatch: (p, m) => found.push([p, m.length]) });
      assert.deepEqual(found, [[a, 1]]);

      const ctrl = new AbortController(); ctrl.abort();
      const none = [];
      await searchFiles([a], 'token', { signal: ctrl.signal, onMatch: p => none.push(p) });
      assert.deepEqual(none, []);
    } finally { rmTmp(root); }
  });
});
