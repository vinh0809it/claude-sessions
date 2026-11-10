'use strict';

const os   = require('os');
const path = require('path');

/** "2026-11-10 15:45" in local time. */
function fmtDate(date) {
  const t = new Date(date);
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** "just now", "5m ago", "2h ago", "3d ago", "2mo ago", "1y ago". */
function fmtAgo(date, now = Date.now()) {
  const minutes = Math.floor((now - new Date(date)) / 60000);
  if (minutes < 1)      return 'just now';
  if (minutes < 60)     return `${minutes}m ago`;
  if (minutes < 1440)   return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 43200)  return `${Math.floor(minutes / 1440)}d ago`;
  if (minutes < 525600) return `${Math.floor(minutes / 43200)}mo ago`;
  return `${Math.floor(minutes / 525600)}y ago`;
}

/** Bytes as "512B", "1.5K", "13M", "1.2G". */
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G'];
  let n = bytes, i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/** "/home/me/x" → "~/x". */
function shortenPath(p) {
  const home = os.homedir();
  const underHome = p === home || p.startsWith(home + path.sep) || p.startsWith(home + '/');
  return underHome ? '~' + p.slice(home.length) : p;
}

/** ".claude-work" → "work", ".claude" → "default". */
function shortConfig(configDir) {
  return path.basename(configDir).replace(/^\.claude-?/, '') || 'default';
}

module.exports = { fmtDate, fmtAgo, fmtSize, shortenPath, shortConfig };
