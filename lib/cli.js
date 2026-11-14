'use strict';

const path = require('path');
const { version } = require('../package.json');
const { groupTitle } = require('./ansi');
const { USAGE, parseArgs, discoverConfigDirs } = require('./config');
const { fmtAgo, fmtDate, fmtSize, shortenPath } = require('./format');
const { pad, trunc } = require('./text');
const { cache, loadSessions, findSessions } = require('./sessions');
const { resumePlan, runHere } = require('./launch');
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
      : color('2', `(${trunc(s.firstMessage || 'untitled', 60)})`);
    console.log(`    ${label}  ${color('2', `${fmtDate(s.lastModified)}  ${fmtSize(s.size)}`)}`);
    console.log(color('2', `    id: ${s.sessionId}`));
  }
}

function printJson(sessions) {
  const out = sessions.map(({ jsonlPath: _j, configDirPath: _c, ...rest }) => rest);
  console.log(JSON.stringify(out, null, 2));
}

/** "-o <query>": resumes the one matching session here; lists them when there are several. Returns the exit code. */
function openByQuery(sessions, query) {
  const hits = findSessions(sessions, query);
  if (!hits.length) { console.error(`No session matches "${query}".`); return 1; }
  if (hits.length > 1) {
    console.error(`${hits.length} sessions match "${query}"; be more specific, or use an id:`);
    for (const s of hits.slice(0, 15)) {
      const label = s.title || `(${s.firstMessage || ''})`;
      console.error(`  ${pad(trunc(label, 40), 40)}  ${color('33', shortenPath(s.project))}  ${color('2', `${fmtAgo(s.lastModified)}  ${s.sessionId}`)}`);
    }
    return 1;
  }
  const plan = resumePlan(hits[0]);
  if (!plan.cwd) { console.error(`Project folder not found: ${shortenPath(hits[0].project)}`); return 1; }
  const run = runHere(plan);
  if (!run.ok) { console.error(run.msg); return 1; }
  return 0;
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
  if (opts.open !== null) { process.exitCode = openByQuery(sessions, opts.open); return; }
  if (opts.json) { printJson(sessions); return; }
  const interactive = process.stdout.isTTY && process.stdin.isTTY && process.env.TERM !== 'dumb';
  if (opts.list || !interactive) {
    // Git Bash's mintty without ConPTY gives node pipes, not a terminal.
    if (!opts.list && process.platform === 'win32' && process.env.MSYSTEM && !process.stdin.isTTY) {
      process.stderr.write('No terminal input here (mintty). For the TUI, run: winpty claude-sessions, or use Windows Terminal.\n');
    }
    printList(sessions);
    return;
  }
  new App(sessions, opts).start();
}

module.exports = { main };
