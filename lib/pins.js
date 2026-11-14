'use strict';

// Pinned sessions (by id), kept at the top of their profile. Stored next to the
// settings, in pins.json.

const path = require('path');
const { settings, readJsonFile, writeJsonFile } = require('./settings');

const toIds = v => new Set(Array.isArray(v) ? v.filter(id => typeof id === 'string') : []);

class Pins {
  constructor(file = path.join(path.dirname(settings.file), 'pins.json')) {
    this.file = file;
    this.ids  = toIds(readJsonFile(file));
  }

  has(sessionId) { return this.ids.has(sessionId); }

  /**
   * Pins or unpins a session and saves. The file is read again first, so pins
   * made in another open window are kept. Returns whether it's pinned now.
   * Throws when it can't be saved.
   */
  toggle(sessionId) {
    const ids = toIds(readJsonFile(this.file, { backup: true }));
    if (this.ids.has(sessionId)) ids.delete(sessionId); else ids.add(sessionId);
    writeJsonFile(this.file, [...ids]);
    this.ids = ids;
    return ids.has(sessionId);
  }
}

module.exports = { Pins, pins: new Pins() };
