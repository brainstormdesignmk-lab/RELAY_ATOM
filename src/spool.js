'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Point 2: file spool with atomic operations.
 * - write: temp file + fsync + rename (no torn reads)
 * - claim: rename out of the queue dir (single-winner by construction)
 * Every message is a JSON envelope persisted under DATA_DIR.
 */
class Spool {
  constructor(dirs, { now = Date.now } = {}) {
    this.dirs = dirs;
    this.now = now;
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  }

  envelopePath(dirName, msg) {
    return path.join(this.dirs[dirName], `${Date.now()}-${msg.id}.json`);
  }

  /** Atomically persist an envelope into a queue directory. */
  write(dirName, envelope) {
    const finalPath = this.envelopePath(dirName, envelope);
    const tmp = `${finalPath}.tmp-${process.pid}-${cryptoRandom()}`;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, finalPath);
    return finalPath;
  }

  read(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }

  list(dirName) {
    try {
      return fs
        .readdirSync(this.dirs[dirName])
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(this.dirs[dirName], f));
    } catch {
      return [];
    }
  }

  /** Claim a message: atomically move it out of its queue. Losers get ENOENT. */
  claim(filePath) {
    const dest = path.join(
      this.dirs.processing,
      `${path.basename(filePath, '.json')}-${process.pid}-${cryptoRandom()}.json`
    );
    try {
      fs.renameSync(filePath, dest);
    } catch (err) {
      if (err.code === 'ENOENT') return null; // someone else claimed it first
      throw err;
    }
    return { path: dest, envelope: this.read(dest) };
  }

  finish(claimed, dirName) {
    const dest = path.join(this.dirs[dirName], path.basename(claimed.path));
    fs.mkdirSync(this.dirs[dirName], { recursive: true });
    fs.renameSync(claimed.path, dest);
    return dest;
  }

  /** Requeue after failure; past retryMax -> failed/ (dead letter).
   *  The attempt counter MUST be persisted, not just mutated in memory,
   *  or retries never escalate. Atomic: tmp-write, move, rename-over. */
  requeueOrFail(claimed, err) {
    const envelope = claimed.envelope;
    envelope.attempts = (envelope.attempts || 0) + 1;
    envelope.lastError = String(err && err.message ? err.message : err);
    envelope.lastErrorAt = new Date().toISOString();
    const dirName = envelope.attempts > RETRY_MAX ? 'failed' : 'retry';
    const dest = path.join(this.dirs[dirName], path.basename(claimed.path));
    const tmp = `${dest}.tmp-${process.pid}-${cryptoRandom()}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(claimed.path, dest); // move original out of processing
    fs.renameSync(tmp, dest); // replace with updated envelope
    // Crash windows: before 1st rename -> original safe in processing;
    // between renames -> dest holds old content (stale count, no loss).
    return { dirName, path: dest, envelope };
  }

  /** Point 5: park a claimed message in a per-atom holding area (order kept). */
  holdFor(claimed, atomId) {
    const dir = path.join(this.dirs.holding, atomId);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(claimed.path));
    fs.renameSync(claimed.path, dest);
    return dest;
  }

  /** Holding messages for one atom, oldest first. */
  listHolding(atomId) {
    const dir = path.join(this.dirs.holding, atomId);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  /** Ordered drain: claims all currently available messages, oldest first. */
  drain(dirName, limit = 100) {
    const claimed = [];
    for (const filePath of this.list(dirName)) {
      if (claimed.length >= limit) break;
      const c = this.claim(filePath);
      if (c) claimed.push(c);
    }
    return claimed;
  }
}

const RETRY_MAX = 5;

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = { Spool, RETRY_MAX };
