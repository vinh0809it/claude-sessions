'use strict';

const path = require('path');
const { version } = require('../package.json');
const { groupTitle } = require('./ansi');
const { USAGE, parseArgs, discoverConfigDirs } = require('./config');
const { fmtDate, fmtSize, shortenPath } = require('./format');
const { cache, loadSessions } = require('./sessions');
const { emptyTrash } = require('./operations');
const { App } = require('./tui/app');

/** Color helper for plain output: styled only when writing to a terminal. */
function color(code, s) {
  return process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}

/** Sessions grouped by profile and project, for --list or piped output. */
function printList(sessions) {
  if (!sessions.length) { console.log('No sessions found.'); return; }
  let lastConfig = null, lastProject = null;
  for (const s of sessions) {
    if (s.configDir !== lastConfig) {
      if (lastConfig) console.log();
      console.log(color('1;36', `[${s.configDir}]`));
      lastConfig = s.configDir;
      lastProject = null;
    }
    if (s.project !== lastProject) {
      console.log(color('33', `  ${shortenPath(s.project)}`));
      lastProject = s.project;
    }
    const label = s.title
      ? groupTitle(s.title, '1;32', color)
      : color('2', `(${(s.firstMessage || 'untitled').slice(0, 60)}…)`);
    console.log(`    ${label}  ${color('2', `${fmtDate(s.lastModified)}  ${fmtSize(s.size)}`)}`);
    console.log(color('2', `    id: ${s.sessionId}`));
  }
}

function printJson(sessions) {
  const out = sessions.map(({ jsonlPath: _j, configDirPath: _c, ...rest }) => rest);
  console.log(JSON.stringify(out, null, 2));
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.version) { console.log(version); return; }
  if (opts.help)    { console.log(USAGE); return; }
  if (opts.noCache) cache.enabled = false;

  if (opts.emptyTrash) {
    const dirs = opts.dir ? [path.resolve(opts.dir)] : discoverConfigDirs();
    console.log(`Freed ${fmtSize(emptyTrash(dirs))}`);
    return;
  }

  const sessions = loadSessions(opts);
  if (opts.json) printJson(sessions);
  else if (opts.list || !process.stdout.isTTY || !process.stdin.isTTY) printList(sessions);
  else new App(sessions, opts).start();
}

module.exports = { main };
