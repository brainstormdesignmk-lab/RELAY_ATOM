'use strict';

const http = require('node:http');

/**
 * Point 5: push delivery engine with health-aware routing.
 * - inbound is pushed to atoms round-robin (skipping dead ones)
 * - on failure the atom's health is degraded/deadened and the message is
 *   parked in holding/<atomId>/ while the atom is dead
 * - recovery is proven by a successful delivery, never by a mere connect
 */
class Worker {
  constructor({ spool, registry, config, now = Date.now, log = console.error }) {
    this.spool = spool;
    this.registry = registry;
    this.config = config;
    this.now = now;
    this.log = log;
    this.timer = null;
    this.running = false;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    const intervalMs = Math.max(1, this.config.workerIntervalSeconds) * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    Promise.resolve()
      .then(() => this.runOnce())
      .catch((err) => this.log(`[worker] tick error: ${err.message}`))
      .finally(() => {
        this.ticking = false;
      });
  }

  async runOnce() {
    await this.replayHolding();
    const claimed = this.spool.drain('inbound');
    for (const c of claimed) {
      try {
        await this.deliverClaimed(c);
      } catch (err) {
        this.log(`[worker] delivery error: ${err.message}`);
      }
    }
  }

  /** First serve per-atom holding queues (oldest first) for live atoms. */
  async replayHolding() {
    for (const atomId of this.registry.ids()) {
      if (this.registry.isDead(atomId)) continue;
      const files = this.spool.listHolding(atomId);
      for (const filePath of files) {
        const claimed = this.spool.claim(filePath);
        if (!claimed) continue;
        await this.deliverClaimed(claimed, atomId);
      }
    }
  }

  pickAtom(preferredId) {
    if (preferredId) {
      const atom = this.registry.get(preferredId);
      // Preferred atom only if it is alive enough to try.
      if (atom && !this.registry.isDead(preferredId)) return atom;
      return null; // holding replay for a dead atom: leave for later
    }
    return this.registry.next();
  }

  async deliverClaimed(claimed, preferredId) {
    const atom = this.pickAtom(preferredId);
    if (!atom) {
      // Nowhere to send: park it (or back to holding if replaying one atom).
      if (preferredId) this.spool.holdFor(claimed, preferredId);
      else this.spool.holdFor(claimed, 'unassigned');
      return;
    }
    try {
      await this.postToAtom(atom, claimed.envelope);
      this.registry.recordSuccess(atom.id);
      this.spool.finish(claimed, 'processed');
    } catch (err) {
      this.registry.recordFailure(atom.id);
      if (this.registry.isDead(atom.id)) {
        // Atom just crossed into dead: park its traffic in holding.
        this.spool.holdFor(claimed, atom.id);
        this.log(`[worker] atom ${atom.id} is dead; message held`);
      } else {
        this.spool.requeueOrFail(claimed, err);
      }
    }
  }

  postToAtom(atom, envelope) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(envelope);
      const url = new URL(atom.url);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-relay-token': this.config.legacyToken || '',
          },
          timeout: this.config.fetchTimeoutMs,
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`atom ${atom.id} responded ${res.statusCode}`));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`atom ${atom.id} timed out`)));
      req.on('error', reject);
      req.end(body);
    });
  }
}

module.exports = { Worker };
