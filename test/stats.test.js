'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeTmp, rmTmp, writeJsonl } = require('./support/helpers');
const { sessionStats, fmtTokens } = require('../lib/stats');

const reply = (id, usage, model = 'claude-opus-5-5') => ({
  type: 'assistant', message: { id, model, usage, content: [{ type: 'text', text: 'x' }] },
});

describe('sessionStats', () => {
  test('counts each reply once, includes subagents and turns before /compact', async () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 'abc.jsonl');
      const u = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
      writeJsonl(f, [
        reply('m1', u), reply('m1', u),                       // one reply, two content blocks
        { type: 'system', subtype: 'compact_boundary' },
        reply('m2', u, 'claude-sonnet-5-5'),
        reply('m3', u),
      ]);
      writeJsonl(path.join(root, 'abc', 'subagents', 'agent-1.jsonl'), [reply('s1', u, 'claude-haiku-5-5')]);

      const s = await sessionStats(f);
      assert.equal(s.replies, 4);
      assert.deepEqual([s.input, s.cacheWrite, s.cacheRead, s.output], [40, 400, 4000, 20]);
      assert.equal(s.models[0], 'claude-opus-5-5');
      assert.equal(s.models.length, 3);
    } finally { rmTmp(root); }
  });

  test('a file without usage yields zeros', async () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 'x.jsonl');
      writeJsonl(f, [{ type: 'user', message: { content: 'hi' } }]);
      const s = await sessionStats(f);
      assert.equal(s.replies, 0);
      assert.deepEqual(s.models, []);
    } finally { rmTmp(root); }
  });
});

describe('fmtTokens', () => {
  test('short forms', () => {
    assert.deepEqual([999, 1234, 56789, 3456789, 45e6, 2.1e9].map(fmtTokens), ['999', '1.2K', '57K', '3.5M', '45M', '2.1B']);
  });
});
