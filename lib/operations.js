'use strict';

// Changes to session files: move, rename, delete to trash, restore from it.

const fs   = require('fs');
const path = require('path');
const { readSession } = require('./sessions');

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
 * filesystem, so it is a cheap rename). If that name is taken, a
 * "-<timestamp>" suffix is added. Returns the session's path in the trash.
 */
function deleteSessionFiles(session) {
  const folderName = path.basename(path.dirname(session.jsonlPath));
  const trashDir   = path.join(session.configDirPath, TRASH_DIR, folderName);
  fs.mkdirSync(trashDir, { recursive: true });
  let base = path.basename(session.jsonlPath, '.jsonl');
  if (fs.existsSync(path.join(trashDir, base + '.jsonl'))) base += '-' + Date.now();
  const trashed = path.join(trashDir, base + '.jsonl');
  moveWithCompanion(session.jsonlPath, trashed);
  return trashed;
}

/** The session id of a trashed file name, without the "-<timestamp>" a name clash adds. */
function trashedSessionId(base) {
  return base.replace(/-\d{13}$/, '');
}

/**
 * Sessions in the trash of each config dir, most recently deleted first:
 * { configDir, configDirPath, folderName, sessionId, jsonlPath (in the trash),
 *   title, firstMessage, project, size, deletedAt }.
 */
function listTrash(configDirs) {
  const entries = [];
  for (const configDirPath of configDirs) {
    const trash = path.join(configDirPath, TRASH_DIR);
    let folders;
    try { folders = fs.readdirSync(trash); } catch { continue; }
    for (const folderName of folders) {
      let names;
      try { names = fs.readdirSync(path.join(trash, folderName)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const name of names) {
        const jsonlPath = path.join(trash, folderName, name);
        let stat;
        try { stat = fs.statSync(jsonlPath); } catch { continue; }
        const meta = readSession(jsonlPath);
        entries.push({
          configDir: path.basename(configDirPath), configDirPath, folderName,
          sessionId:    trashedSessionId(path.basename(name, '.jsonl')),
          jsonlPath,
          title:        meta.title,
          firstMessage: meta.firstUserMessage,
          project:      meta.cwd || folderName,
          size:         stat.size,
          deletedAt:    stat.ctime, // moving the file into the trash updates it
        });
      }
    }
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Moves a trashed session (an entry from listTrash) back where it was. */
function restoreFromTrash(entry) {
  const targetDir = path.join(entry.configDirPath, 'projects', entry.folderName);
  const target    = path.join(targetDir, entry.sessionId + '.jsonl');
  if (fs.existsSync(target)) throw new Error('a session with this id already exists there');
  fs.mkdirSync(targetDir, { recursive: true });
  moveWithCompanion(entry.jsonlPath, target);
  removeIfEmpty(path.dirname(entry.jsonlPath));
  return target;
}

/** Permanently removes one trashed session (an entry from listTrash). Returns the bytes freed. */
function deleteForever(entry) {
  const freed = diskUsage(entry.jsonlPath) + diskUsage(companionDir(entry.jsonlPath));
  fs.rmSync(entry.jsonlPath, { force: true });
  fs.rmSync(companionDir(entry.jsonlPath), { recursive: true, force: true });
  removeIfEmpty(path.dirname(entry.jsonlPath));
  return freed;
}

function removeIfEmpty(dir) {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
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

module.exports = {
  deleteSessionFiles, listTrash, restoreFromTrash, deleteForever, emptyTrash, moveSession, renameSession,
};
