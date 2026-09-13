'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Point 2: dedup. In-memory Map with TTL eviction, persisted as JSONL
 * (one JSON object per line) and replayed on startup. Bounded: entries
 * expire after ttlMs and the log is compacted when it grows past
 * compactAfter lines.
 */
class DedupIndex {
  constructor(dir, { ttlMs = 24 * 3600 * 1000, compactAfter = 5000, now = Date.now } = {}) {
    this.file = path.join(dir, 'seen.jsonl');
    this.ttlMs = ttlMs;
    this.compactAfter = compactAfter;
    this.now = now;
    this.entries = new Map(); // id -> expiresAt
    this.appendCount = 0;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // first run or empty dir
    }
    const cutoff = this.now();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const { id, expiresAt } = JSON.parse(line);
        if (typeof id === 'string' && Number.isFinite(expiresAt) && expiresAt > cutoff) {
          this.entries.set(id, expiresAt);
        }
      } catch {
        // skip corrupt line
      }
    }
  }

  persist(id, expiresAt) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ id, expiresAt }) + '\n');
    this.appendCount += 1;
    if (this.appendCount >= this.compactAfter) this.compact();
  }

  compact() {
    this.evict();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, [...this.entries].map(([id, exp]) => JSON.stringify({ id, expiresAt: exp })).join('\n') + '\n');
    fs.renameSync(tmp, this.file);
    this.appendCount = 0;
  }

  evict() {
    const now = this.now();
    for (const [id, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(id);
    }
  }

  seen(id) {
    if (!id) return false;
    const expiresAt = this.entries.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  remember(id) {
    if (!id) return;
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(id, expiresAt);
    this.persist(id, expiresAt);
    if (this.entries.size > this.compactAfter * 2) this.evict();
  }

  size() {
    this.evict();
    return this.entries.size;
  }
}

module.exports = { DedupIndex };
