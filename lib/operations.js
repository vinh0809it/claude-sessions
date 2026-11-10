'use strict';

// Changes to session files: move, rename, delete to trash, empty trash.

const fs   = require('fs');
const path = require('path');
const { readSession } = require('./sessions');
const { shortenPath } = require('./format');

const TRASH_DIR = '.claude-sessions-trash';

/** rename(2), falling back to copy + remove across filesystems (EXDEV). */
function movePath(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** <id>.jsonl may have a sibling <id>/ folder (subagent transcripts, tool output). */
function companionDir(jsonlPath) {
  return jsonlPath.replace(/\.jsonl$/, '');
}

function moveWithCompanion(jsonlPath, destJsonl) {
  movePath(jsonlPath, destJsonl);
  const dir = companionDir(jsonlPath);
  try { if (fs.statSync(dir).isDirectory()) movePath(dir, companionDir(destJsonl)); } catch {}
}

/**
 * Moves a session into <configDir>/.claude-sessions-trash/<folder>/ (same
 * filesystem, so it is a cheap rename). Returns the trash folder.
 */
function deleteSessionFiles(session) {
  const folderName = path.basename(path.dirname(session.jsonlPath));
  const trashDir   = path.join(session.configDirPath, TRASH_DIR, folderName);
  fs.mkdirSync(trashDir, { recursive: true });
  let base = path.basename(session.jsonlPath, '.jsonl');
  if (fs.existsSync(path.join(trashDir, base + '.jsonl'))) base += '-' + Date.now();
  moveWithCompanion(session.jsonlPath, path.join(trashDir, base + '.jsonl'));
  return trashDir;
}

function diskUsage(p) {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(p).reduce((sum, n) => sum + diskUsage(path.join(p, n)), 0);
  } catch { return 0; }
}

/** Permanently removes the trash of each config dir. Returns the bytes freed. */
function emptyTrash(configDirs) {
  let freed = 0;
  for (const dir of configDirs) {
    const trash = path.join(dir, TRASH_DIR);
    if (!fs.existsSync(trash)) continue;
    freed += diskUsage(trash);
    fs.rmSync(trash, { recursive: true, force: true });
  }
  return freed;
}

/**
 * Moves a session to another config dir and/or project folder, updating the
 * session object in place. `targetRawPath` is recorded as the folder's
 * .project-path hint when the folder is new.
 */
function moveSession(session, targetConfigDirPath, targetFolderName, targetRawPath = null) {
  const folderName  = targetFolderName || path.basename(path.dirname(session.jsonlPath));
  const targetDir   = path.join(targetConfigDirPath, 'projects', folderName);
  const targetJsonl = path.join(targetDir, path.basename(session.jsonlPath));
  if (path.resolve(targetJsonl) === path.resolve(session.jsonlPath)) return;
  if (fs.existsSync(targetJsonl)) throw new Error('a session with this id already exists there');

  fs.mkdirSync(targetDir, { recursive: true });
  moveWithCompanion(session.jsonlPath, targetJsonl);

  if (targetRawPath) {
    try { fs.writeFileSync(path.join(targetDir, '.project-path'), targetRawPath, 'utf8'); } catch {}
  }

  session.configDir     = path.basename(targetConfigDirPath);
  session.configDirPath = targetConfigDirPath;
  session.jsonlPath     = targetJsonl;
}

/** Appends a custom-title record, the same thing /rename writes. */
function renameSession(session, title) {
  title = title.trim();
  if (!title) throw new Error('empty title');
  const fd = fs.openSync(session.jsonlPath, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const record = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: session.sessionId });
    fs.writeSync(fd, prefix + record + '\n', size);
  } finally { fs.closeSync(fd); }
  session.title = title;
}

/** Project folders of a config dir with a readable path for each, sorted by that path. */
function listProjectFolders(configDirPath) {
  const projectsDir = path.join(configDirPath, 'projects');
  const displayPathOf = (folderName) => {
    const folderDir = path.join(projectsDir, folderName);
    try {
      const hint = fs.readFileSync(path.join(folderDir, '.project-path'), 'utf8').trim();
      if (hint) return shortenPath(hint);
    } catch {
      try {
        const file = fs.readdirSync(folderDir).find(f => f.endsWith('.jsonl'));
        const cwd  = file && readSession(path.join(folderDir, file)).cwd;
        if (cwd) return shortenPath(cwd);
      } catch {}
    }
    return folderName;
  };
  try {
    return fs.readdirSync(projectsDir)
      .filter(d => { try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; } })
      .map(d => ({ projectDirName: d, displayPath: displayPathOf(d) }))
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  } catch { return []; }
}

module.exports = {
  deleteSessionFiles, emptyTrash, moveSession, renameSession, listProjectFolders,
};
