'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { parseArgs } = require('../lib/config');

describe('parseArgs', () => {
  test('expands ~ in the folder filter', () => {
    assert.equal(parseArgs(['~/x']).filterPath, path.join(os.homedir(), 'x'));
  });
  test('flags', () => {
    const o = parseArgs(['--empty-trash', '--no-cache', '--named-only']);
    assert.ok(o.emptyTrash && o.noCache && o.namedOnly);
  });
});
