'use strict';

// Pinned sessions (by id), kept at the top of their profile. Stored next to the
// settings, in pins.json.

const fs   = require('fs');
const path = require('path');
const { settings } = require('./settings');

class Pins {
  constructor(file = path.join(path.dirname(settings.file), 'pins.json')) {
    this.file = file;
    this.ids  = new Set();
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') this.ids.add(id);
    } catch {} // missing or unreadable: nothing pinned
  }

  has(sessionId) { return this.ids.has(sessionId); }

  /** Pins or unpins a session and saves. Returns whether it's pinned now. Throws when it can't be saved. */
  toggle(sessionId) {
    const ids = new Set(this.ids);
    if (ids.has(sessionId)) ids.delete(sessionId); else ids.add(sessionId);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...ids], null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.ids = ids;
    return ids.has(sessionId);
  }
}

module.exports = { Pins, pins: new Pins() };
