'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  encodePathToDir,
  tabComplete,
  resolveProjectPath,
  moveSession,
  readSession,
  readRecentMessages,
  renameSession,
  deleteSessionFiles,
  emptyTrash,
  scanConfigDir,
  sortSessions,
  projectDirNameFor,
  detectTerminal,
  parseArgs,
  cache,
} = require('../index.js');

cache.enabled = false; // never touch the real ~/.cache from tests

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp(subdirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
  for (const d of subdirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

function rmTmp(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
}

// ── encodePathToDir ───────────────────────────────────────────────────────────

describe('encodePathToDir', () => {
  test('replaces all slashes with hyphens', () => {
    assert.equal(encodePathToDir('/home/user/projects/foo'), '-home-user-projects-foo');
  });

  test('root slash becomes single hyphen', () => {
    assert.equal(encodePathToDir('/'), '-');
  });

  test('no slashes: string unchanged', () => {
    assert.equal(encodePathToDir('foo'), 'foo');
  });

  test('dots, underscores and spaces also become hyphens (matches Claude Code)', () => {
    assert.equal(encodePathToDir('/home/u/.local/my_app v2'), '-home-u--local-my-app-v2');
  });

  test('windows paths', () => {
    assert.equal(encodePathToDir('C:\\Users\\me\\proj'), 'C--Users-me-proj');
  });
});

describe('projectDirNameFor', () => {
  let root;
  before(() => { root = makeTmp(['projects']); });
  after(() =>  { rmTmp(root); });

  test('short path: plain encoding', () => {
    assert.equal(projectDirNameFor(root, '/a/b.c'), '-a-b-c');
  });

  test('long path: reuses existing folder with the same 200-char prefix', () => {
    const long = '/' + 'x'.repeat(250);
    const existing = encodePathToDir(long).slice(0, 200) + '-abc123';
    fs.mkdirSync(path.join(root, 'projects', existing));
    assert.equal(projectDirNameFor(root, long), existing);
  });

  test('long path with no existing folder: throws', () => {
    assert.throws(() => projectDirNameFor(root, '/' + 'y'.repeat(250)), /too long/);
  });
});

// ── tabComplete ───────────────────────────────────────────────────────────────

describe('tabComplete', () => {
  let root;
  before(() => { root = makeTmp(['alpha', 'beta', 'gamma/delta']); });
  after(() =>  { rmTmp(root); });

  test('single match: completes and appends slash', () => {
    const { completed, matches } = tabComplete(root + '/a');
    assert.equal(completed, root + '/alpha/');
    assert.deepEqual(matches, []);
  });

  test('no match: returns input unchanged with no matches', () => {
    const { completed, matches } = tabComplete(root + '/zzz');
    assert.equal(completed, root + '/zzz');
    assert.deepEqual(matches, []);
  });

  test('trailing slash: lists single subdir and completes', () => {
    const { completed, matches } = tabComplete(root + '/gamma/');
    assert.equal(completed, root + '/gamma/delta/');
    assert.deepEqual(matches, []);
  });

  test('multiple matches with extendable common prefix: extends to common prefix', () => {
    const sub = makeTmp(['barfoo', 'barbaz']);
    try {
      const { completed, matches } = tabComplete(sub + '/ba');
      assert.equal(completed, sub + '/bar');
      assert.deepEqual(matches.sort(), ['barbaz/', 'barfoo/']);
    } finally { rmTmp(sub); }
  });

  test('multiple matches with no further common prefix: returns input unchanged, shows options', () => {
    const sub = makeTmp(['bar', 'baz']);
    try {
      const { completed, matches } = tabComplete(sub + '/ba');
      assert.equal(completed, sub + '/ba');
      assert.deepEqual(matches.sort(), ['bar/', 'baz/']);
    } finally { rmTmp(sub); }
  });

  test('non-existent base dir: returns input unchanged', () => {
    const { completed, matches } = tabComplete('/nonexistent-xyz-dir/foo');
    assert.equal(completed, '/nonexistent-xyz-dir/foo');
    assert.deepEqual(matches, []);
  });
});

// ── readSession ───────────────────────────────────────────────────────────────

describe('readSession', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  test('reads title, firstMessage, cwd, timestamp from JSONL', () => {
    const f = path.join(root, 'session1.jsonl');
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'My Title' },
      { type: 'user', message: { content: 'Hello world' }, cwd: '/some/path', timestamp: 1000 },
    ]);
    const { title, firstUserMessage, cwd, timestamp } = readSession(f);
    assert.equal(title, 'My Title');
    assert.equal(firstUserMessage, 'Hello world');
    assert.equal(cwd, '/some/path');
    assert.equal(timestamp, 1000);
  });

  test('cwd from first record that has it', () => {
    const f = path.join(root, 'session2.jsonl');
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'T', cwd: '/first-cwd', timestamp: 1 },
      { type: 'user', message: { content: 'hi' }, cwd: '/second-cwd', timestamp: 2 },
    ]);
    const { cwd } = readSession(f);
    assert.equal(cwd, '/first-cwd');
  });

  test('skips malformed lines without throwing', () => {
    const f = path.join(root, 'session3.jsonl');
    fs.writeFileSync(f, 'not json\n{"type":"custom-title","customTitle":"T2"}\nbad too\n');
    const { title } = readSession(f);
    assert.equal(title, 'T2');
  });

  test('returns nulls for unreadable file', () => {
    const { title, firstUserMessage, cwd, timestamp } = readSession('/no/such/file.jsonl');
    assert.equal(title, null);
    assert.equal(firstUserMessage, null);
    assert.equal(cwd, null);
    assert.equal(timestamp, null);
  });

  test('skips meta records and <system-reminder> wrappers for firstMessage', () => {
    const f = path.join(root, 'session5.jsonl');
    writeJsonl(f, [
      { type: 'user', isMeta: true, message: { content: 'meta stuff' }, cwd: '/p' },
      { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', message: { content: [{ type: 'text', text: '<command-name>/rename</command-name>' }, { type: 'text', text: 'real question' }] } },
    ]);
    assert.equal(readSession(f).firstUserMessage, 'real question');
  });

  test('keeps user prompts that merely start with "<" (pasted HTML)', () => {
    const f = path.join(root, 'session6.jsonl');
    writeJsonl(f, [{ type: 'user', message: { content: '<div>why is this broken</div>' } }]);
    assert.equal(readSession(f).firstUserMessage, '<div>why is this broken</div>');
  });

  test('large file: takes the last custom-title from the tail', () => {
    const f = path.join(root, 'big.jsonl');
    const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'z'.repeat(1000) }] } };
    writeJsonl(f, [
      { type: 'custom-title', customTitle: 'old' },
      { type: 'user', message: { content: 'first' }, cwd: '/p', timestamp: 1 },
      ...Array(800).fill(filler),
      { type: 'custom-title', customTitle: 'new' },
      ...Array(10).fill(filler),
    ]);
    assert.ok(fs.statSync(f).size > 512 * 1024, 'file exceeds head+tail window');
    const r = readSession(f);
    assert.equal(r.title, 'new');
    assert.equal(r.firstUserMessage, 'first');
    assert.equal(r.cwd, '/p');
  });

  test('extracts text from array content blocks', () => {
    const f = path.join(root, 'session4.jsonl');
    writeJsonl(f, [
      { type: 'user', message: { content: [{ type: 'text', text: 'Block message' }] }, cwd: '/p', timestamp: 1 },
    ]);
    const { firstUserMessage } = readSession(f);
    assert.equal(firstUserMessage, 'Block message');
  });
});

// ── resolveProjectPath ────────────────────────────────────────────────────────

describe('resolveProjectPath', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  test('returns hint file path when present and directory exists', () => {
    const sessionDir   = path.join(root, 'hint-test');
    const realProject  = path.join(root, 'real-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'abc.jsonl');
    writeJsonl(jsonlPath, [{ cwd: '/stale/path', timestamp: 1 }]);
    fs.writeFileSync(path.join(sessionDir, '.project-path'), realProject, 'utf8');

    assert.equal(resolveProjectPath({ jsonlPath, project: '/stale/path' }), realProject);
  });

  test('ignores hint file when path does not exist on disk', () => {
    const sessionDir   = path.join(root, 'bad-hint');
    const realProject  = path.join(root, 'real-proj-2');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'abc2.jsonl');
    writeJsonl(jsonlPath, [{ cwd: realProject, timestamp: 1 }]);
    // hint points to a path that does not exist
    fs.writeFileSync(path.join(sessionDir, '.project-path'), '/ghost/path', 'utf8');

    // should fall through to sibling / session.project
    const result = resolveProjectPath({ jsonlPath, project: realProject });
    assert.equal(result, realProject);
  });

  test('uses sibling session cwd when no hint file', () => {
    const sessionDir   = path.join(root, 'sibling-test');
    const realProject  = path.join(root, 'sibling-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const mainJsonl = path.join(sessionDir, 'main.jsonl');
    const sibJsonl  = path.join(sessionDir, 'sibling.jsonl');
    writeJsonl(mainJsonl, [{ cwd: '/stale', timestamp: 1 }]);
    writeJsonl(sibJsonl,  [{ cwd: realProject, timestamp: 2 }]);

    assert.equal(resolveProjectPath({ jsonlPath: mainJsonl, project: '/stale' }), realProject);
  });

  test('falls back to session.project when it exists and no siblings', () => {
    const sessionDir   = path.join(root, 'fallback-test');
    const realProject  = path.join(root, 'fallback-project');
    fs.mkdirSync(sessionDir,  { recursive: true });
    fs.mkdirSync(realProject, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'solo.jsonl');
    writeJsonl(jsonlPath, [{ cwd: realProject, timestamp: 1 }]);

    assert.equal(resolveProjectPath({ jsonlPath, project: realProject }), realProject);
  });

  test('falls back to home dir when all paths are missing', () => {
    const sessionDir = path.join(root, 'missing-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const jsonlPath = path.join(sessionDir, 'ghost.jsonl');
    writeJsonl(jsonlPath, [{ cwd: '/does/not/exist', timestamp: 1 }]);

    assert.equal(
      resolveProjectPath({ jsonlPath, project: '/also/does/not/exist' }),
      os.homedir()
    );
  });
});

// ── moveSession ───────────────────────────────────────────────────────────────

describe('moveSession', () => {
  let root;
  before(() => { root = makeTmp([]); });
  after(() =>  { rmTmp(root); });

  function makeSession(configDir, projectDirName, sessionId = 'sess') {
    const projectDir = path.join(root, configDir, 'projects', projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeJsonl(jsonlPath, [{ cwd: '/some/project', type: 'user', message: { content: 'hi' }, timestamp: 1 }]);
    return { jsonlPath, sessionId, configDir, configDirPath: path.join(root, configDir), project: '/some/project' };
  }

  test('moves jsonl to target config dir and updates session fields', () => {
    const session = makeSession('src-a', '-proj', 's1');
    const targetConfig = path.join(root, 'dst-a');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj');

    assert.ok(fs.existsSync(session.jsonlPath), 'file exists at new path');
    assert.ok(session.jsonlPath.includes('dst-a'), 'jsonlPath updated to target config');
    assert.equal(session.configDir, 'dst-a');
    assert.equal(session.configDirPath, targetConfig);
  });

  test('preserves source dir name when targetProjectDirName is null', () => {
    const session = makeSession('src-b', '-keep-dir', 's2');
    const targetConfig = path.join(root, 'dst-b');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, null);

    assert.ok(session.jsonlPath.includes('-keep-dir'), 'dir name preserved');
  });

  test('writes .project-path hint when targetRawPath provided', () => {
    const session = makeSession('src-c', '-proj2', 's3');
    const targetConfig = path.join(root, 'dst-c');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });
    const rawPath = '/home/user/real-project';

    moveSession(session, targetConfig, '-proj2', rawPath);

    const hintFile = path.join(path.dirname(session.jsonlPath), '.project-path');
    assert.ok(fs.existsSync(hintFile));
    assert.equal(fs.readFileSync(hintFile, 'utf8'), rawPath);
  });

  test('does not write .project-path when targetRawPath is null', () => {
    const session = makeSession('src-d', '-proj3', 's4');
    const targetConfig = path.join(root, 'dst-d');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj3', null);

    const hintFile = path.join(path.dirname(session.jsonlPath), '.project-path');
    assert.ok(!fs.existsSync(hintFile), '.project-path not written');
  });

  test('moves companion dir alongside the jsonl file', () => {
    const session      = makeSession('src-e', '-proj4', 's5');
    const companionDir = session.jsonlPath.replace('.jsonl', '');
    fs.mkdirSync(companionDir, { recursive: true });
    fs.writeFileSync(path.join(companionDir, 'artifact.txt'), 'data');
    const targetConfig = path.join(root, 'dst-e');
    fs.mkdirSync(path.join(targetConfig, 'projects'), { recursive: true });

    moveSession(session, targetConfig, '-proj4');

    const newCompanion = session.jsonlPath.replace('.jsonl', '');
    assert.ok(fs.existsSync(newCompanion), 'companion dir moved');
    assert.ok(fs.existsSync(path.join(newCompanion, 'artifact.txt')), 'companion contents intact');
  });
});

// ── readRecentMessages ────────────────────────────────────────────────────────

describe('readRecentMessages', () => {
  test('returns last N user/assistant texts, skipping tool results', () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 's.jsonl');
      writeJsonl(f, [
        { type: 'user', message: { content: 'q1' } },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a1' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
        { type: 'user', message: { content: 'q2' } },
      ]);
      assert.deepEqual(readRecentMessages(f, 2), [{ role: 'assistant', text: 'a1' }, { role: 'user', text: 'q2' }]);
    } finally { rmTmp(root); }
  });
});

// ── renameSession ─────────────────────────────────────────────────────────────

describe('renameSession', () => {
  test('appends a custom-title record that readSession picks up', () => {
    const root = makeTmp([]);
    try {
      const f = path.join(root, 's.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'hi' } })); // no trailing newline
      const s = { jsonlPath: f, sessionId: 's' };
      renameSession(s, '  my name ');
      assert.equal(s.title, 'my name');
      assert.equal(readSession(f).title, 'my name');
      assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2);
    } finally { rmTmp(root); }
  });

  test('rejects empty title', () => {
    assert.throws(() => renameSession({ jsonlPath: '/x', sessionId: 'x' }, '   '), /empty/);
  });
});

// ── delete / trash ────────────────────────────────────────────────────────────

describe('deleteSessionFiles + emptyTrash', () => {
  test('moves jsonl and companion dir to trash, emptyTrash frees it', () => {
    const root = makeTmp([]);
    try {
      const cfg = path.join(root, '.claude');
      const jsonlPath = path.join(cfg, 'projects', '-p', 'abc.jsonl');
      writeJsonl(jsonlPath, [{ type: 'user', message: { content: 'hi' } }]);
      fs.mkdirSync(path.join(cfg, 'projects', '-p', 'abc'));
      fs.writeFileSync(path.join(cfg, 'projects', '-p', 'abc', 'x.txt'), 'data');

      deleteSessionFiles({ jsonlPath, configDirPath: cfg });

      assert.ok(!fs.existsSync(jsonlPath));
      assert.ok(fs.existsSync(path.join(cfg, '.claude-sessions-trash', '-p', 'abc.jsonl')));
      assert.ok(fs.existsSync(path.join(cfg, '.claude-sessions-trash', '-p', 'abc', 'x.txt')));
      assert.ok(emptyTrash([cfg]) > 0);
      assert.ok(!fs.existsSync(path.join(cfg, '.claude-sessions-trash')));
    } finally { rmTmp(root); }
  });
});

// ── scanConfigDir ─────────────────────────────────────────────────────────────

describe('scanConfigDir', () => {
  test('uses the folder path for sessions whose cwd drifted, filters by path', () => {
    const root = makeTmp([]);
    try {
      const cfg = path.join(root, '.claude');
      const proj = '/home/u/my.app';
      const dir = path.join(cfg, 'projects', encodePathToDir(proj));
      writeJsonl(path.join(dir, 'a.jsonl'), [{ type: 'user', message: { content: 'a' }, cwd: proj }]);
      writeJsonl(path.join(dir, 'b.jsonl'), [{ type: 'user', message: { content: 'b' }, cwd: '/elsewhere' }]);
      const all = scanConfigDir(cfg, null);
      assert.equal(all.length, 2);
      assert.ok(all.every(s => s.project === proj));
      assert.ok(all.every(s => typeof s.size === 'number' && s.size > 0));
      assert.equal(scanConfigDir(cfg, '/home/u/my.app').length, 2);
      assert.equal(scanConfigDir(cfg, '/home/u/my').length, 0, 'prefix of a folder name is not a match');
    } finally { rmTmp(root); }
  });
});

// ── sortSessions ──────────────────────────────────────────────────────────────

describe('sortSessions', () => {
  const mk = (configDir, title, size, t) => ({ configDir, title, size, lastModified: new Date(t) });
  const list = [mk('.claude-a', 'b', 1, 3), mk('.claude-a', 'a', 5, 1), mk('.claude', 'c', 9, 2)];

  test('keeps profile grouping order, sorts within', () => {
    assert.deepEqual(sortSessions(list, 'size').map(s => s.title), ['a', 'b', 'c']);
    assert.deepEqual(sortSessions(list, 'name').map(s => s.title), ['a', 'b', 'c']);
    assert.deepEqual(sortSessions(list, 'date').map(s => s.title), ['b', 'a', 'c']);
  });
});

// ── detectTerminal / parseArgs ────────────────────────────────────────────────

describe('detectTerminal', () => {
  test('falls back to opening in this terminal', () => {
    assert.equal(detectTerminal({}), 'here');
  });
  test('detects kitty, tmux, iTerm, Apple Terminal, honours override', () => {
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: '1' }), 'kitty');
    assert.equal(detectTerminal({ TMUX: '/tmp/x' }), 'tmux');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
    assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }), 'apple-terminal');
    assert.equal(detectTerminal({ TMUX: 'x', CLAUDE_SESSIONS_TERMINAL: 'here' }), 'here');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'win32'), 'windows-terminal');
    assert.equal(detectTerminal({ WT_SESSION: 'x' }, 'linux'), 'here'); // WSL
  });
});

describe('parseArgs', () => {
  test('expands ~ in the folder filter', () => {
    assert.equal(parseArgs(['~/x']).filterPath, path.join(os.homedir(), 'x'));
  });
  test('flags', () => {
    const o = parseArgs(['--empty-trash', '--no-cache', '--named-only']);
    assert.ok(o.emptyTrash && o.noCache && o.namedOnly);
  });
});

describe('splitKeys', () => {
  const { splitKeys } = require('../index.js');
  test('splits pasted text, keeps escape sequences whole', () => {
    assert.deepEqual(splitKeys('ab\x1b[A\x1b[5~\r\x7f\x1b'), ['a', 'b', '\x1b[A', '\x1b[5~', '\r', '\x7f', '\x1b']);
  });
  test('keeps multi-byte characters intact', () => {
    assert.deepEqual(splitKeys('tên😀'), ['t', 'ê', 'n', '😀']);
  });
});

describe('wrapWords', () => {
  const { wrapWords } = require('../index.js');
  test('breaks at spaces', () => {
    assert.deepEqual(wrapWords('added a regression test', 12), ['added a', 'regression', 'test']);
  });
  test('splits words longer than the width', () => {
    assert.deepEqual(wrapWords('abcdefghij x', 4), ['abcd', 'efgh', 'ij x']);
  });
});

describe('LineInput', () => {
  const { LineInput } = require('../index.js');
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

describe('wtArgs', () => {
  const { wtArgs } = require('../index.js');
  test('opens a cmd tab with the profile set, escaping ";" for wt', () => {
    const args = wtArgs({ title: 'fix; login', cwd: 'C:\\Users\\Jo Doe\\app', configDirPath: 'C:\\Users\\Jo Doe\\.claude', args: ['-r', 'abc'] });
    assert.deepEqual(args, ['-w', '0', 'nt', '--title', 'fix\\; login', '-d', 'C:\\Users\\Jo Doe\\app',
      'cmd', '/k', 'set CLAUDE_CONFIG_DIR=C:\\Users\\Jo Doe\\.claude&& claude -r abc']);
  });
});

describe('fmtAgo', () => {
  const { fmtAgo } = require('../index.js');
  test('picks the largest whole unit', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const ago = mins => fmtAgo(now - mins * 60000, now);
    assert.deepEqual([ago(0), ago(5), ago(125), ago(60 * 24 * 3), ago(60 * 24 * 65), ago(60 * 24 * 800)],
      ['just now', '5m ago', '2h ago', '3d ago', '2mo ago', '2y ago']);
  });
});
