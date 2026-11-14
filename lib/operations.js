'use strict';

// Changes to session files: move, rename, delete to trash, restore from it.

const fs   = require('fs');
const path = require('path');
const { readSession, projectPathOf } = require('./sessions');
const { projectDirNameFor } = require('./paths');

const TRASH_DIR = '.claude-sessions-trash';

/**
 * rename(2), falling back across filesystems (EXDEV) to: copy to a temporary
 * name next to `dest` (keeping timestamps), rename it into place, remove the
 * source. A failed copy leaves nothing behind at `dest`.
 */
function movePath(src, dest, { cp = fs.cpSync } = {}) {
  try { fs.renameSync(src, dest); return; }
  catch (e) { if (e.code !== 'EXDEV') throw e; }
  const tmp = `${dest}.${process.pid}.moving`;
  try {
    cp(src, tmp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(src, { recursive: true, force: true });
}

/** <id>.jsonl may have a sibling <id>/ folder (subagent transcripts, tool output). */
function companionDir(jsonlPath) {
  return jsonlPath.replace(/\.jsonl$/, '');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Moves a session file and its companion folder. Refuses before touching
 * anything when either target exists; if the folder can't be moved, the file
 * is moved back, so a session is never split.
 */
function moveWithCompanion(jsonlPath, destJsonl, opts) {
  const dir = companionDir(jsonlPath), destDir = companionDir(destJsonl);
  const hasDir = isDir(dir);
  if (fs.existsSync(destJsonl)) throw new Error('a session with this id already exists there');
  if (hasDir && fs.existsSync(destDir)) throw new Error(`its folder already exists there: ${destDir}`);
  movePath(jsonlPath, destJsonl, opts);
  if (!hasDir) return;
  try { movePath(dir, destDir, opts); }
  catch (e) {
    try { movePath(destJsonl, jsonlPath, opts); }
    catch { throw new Error(`moved the session but not its folder ${dir}: ${e.message}`); }
    throw new Error(`could not move its folder: ${e.message}`);
  }
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
  const taken = b => fs.existsSync(path.join(trashDir, b + '.jsonl')) || fs.existsSync(path.join(trashDir, b));
  if (taken(base)) base += '-' + Date.now();
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

/** True when two paths name the same folder (through symlinks; ignoring case on Windows). */
function samePath(a, b) {
  const norm = p => {
    let r;
    try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * Moves a session to another config dir and/or project folder, updating the
 * session object in place.
 *
 * `targetRawPath` is a typed folder path. It is resolved through symlinks (as
 * Claude Code stores sessions under the real cwd), which also picks the
 * folder name; an existing folder that belongs to another path is refused
 * (two paths can encode to the same name: "/a/b-c" and "/a/b/c"). It is
 * recorded as the folder's .project-path hint only when the folder is new.
 */
function moveSession(session, targetConfigDirPath, targetFolderName, targetRawPath = null) {
  let folderName = targetFolderName || path.basename(path.dirname(session.jsonlPath));
  let realPath = null;
  if (targetRawPath) {
    try { realPath = fs.realpathSync.native(targetRawPath); } catch { realPath = path.resolve(targetRawPath); }
    folderName = projectDirNameFor(targetConfigDirPath, realPath);
  }
  const targetDir   = path.join(targetConfigDirPath, 'projects', folderName);
  const targetJsonl = path.join(targetDir, path.basename(session.jsonlPath));
  if (path.resolve(targetJsonl) === path.resolve(session.jsonlPath)) return;

  const isNewFolder = !fs.existsSync(targetDir);
  if (realPath && !isNewFolder) {
    const known = projectPathOf(targetDir);
    if (known && !samePath(known, realPath)) {
      throw new Error(`that folder belongs to ${known}, which Claude Code stores under the same name`);
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  try { moveWithCompanion(session.jsonlPath, targetJsonl); }
  catch (e) { if (isNewFolder) removeIfEmpty(targetDir); throw e; }

  if (realPath && isNewFolder) {
    try { fs.writeFileSync(path.join(targetDir, '.project-path'), realPath, 'utf8'); } catch {}
  }

  session.configDir     = path.basename(targetConfigDirPath);
  session.configDirPath = targetConfigDirPath;
  session.jsonlPath     = targetJsonl;
}

/** The last byte of a file, or null when it is empty. */
function lastByte(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0];
  } finally { fs.closeSync(fd); }
}

/**
 * Appends a custom-title record, the same thing /rename writes. The file is
 * opened in append mode, so a line a running claude writes at the same time
 * is never overwritten.
 */
function renameSession(session, title) {
  title = title.trim();
  if (!title) throw new Error('empty title');
  const last = lastByte(session.jsonlPath);
  const prefix = last !== null && last !== 0x0a ? '\n' : '';
  const record = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: session.sessionId });
  fs.appendFileSync(session.jsonlPath, prefix + record + '\n');
  session.title = title;
}

module.exports = {
  movePath, deleteSessionFiles, listTrash, restoreFromTrash, deleteForever, emptyTrash, moveSession, renameSession,
};
