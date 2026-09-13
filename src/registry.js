'use strict';

/**
 * Point 5: atom registry with health-aware routing and per-node holding.
 *
 * States: healthy -> degraded (1 failure) -> dead (deadThreshold failures)
 * Recovery: only a *successful delivery* promotes a dead atom back
 * (not a TCP connect), which prevents flap. While dead, the atom's
 * messages accumulate in holding/<atomId>/ preserving queue order and
 * are replayed oldest-first on recovery.
 */
const DEAD = 'dead';
const DEGRADED = 'degraded';
const HEALTHY = 'healthy';

class AtomRegistry {
  constructor(atoms, { deadThreshold = 3, deadCooldownMs = 60000, now = Date.now } = {}) {
    this.now = now;
    this.deadThreshold = deadThreshold;
    this.deadCooldownMs = deadCooldownMs;
    this.atoms = new Map(atoms.map((a) => [a.id, { ...a, state: HEALTHY, failures: 0, lastFailureAt: 0, lastSuccessAt: 0 }]));
    this.roundRobin = 0;
  }

  ids() {
    return [...this.atoms.keys()];
  }

  get(id) {
    return this.atoms.get(id) || null;
  }

  /** Healthy + degraded atoms are routable; dead ones are not. */
  routable() {
    const out = [];
    for (const atom of this.atoms.values()) {
      if (atom.state === DEAD) {
        // Dead atoms may be retried after a cooldown so a recovered atom
        // gets a real delivery attempt (which is what proves recovery).
        if (this.now() - atom.lastFailureAt >= this.deadCooldownMs) out.push(atom);
      } else {
        out.push(atom);
      }
    }
    if (out.length === 0) return [...this.atoms.values()]; // last resort: try everyone
    return out;
  }

  next() {
    const pool = this.routable();
    if (pool.length === 0) return null;
    const atom = pool[this.roundRobin % pool.length];
    this.roundRobin += 1;
    return atom;
  }

  recordFailure(id) {
    const atom = this.atoms.get(id);
    if (!atom) return;
    atom.failures += 1;
    atom.lastFailureAt = this.now();
    if (atom.state !== DEAD && atom.failures >= this.deadThreshold) atom.state = DEAD;
    else if (atom.state === HEALTHY) atom.state = DEGRADED;
  }

  recordSuccess(id) {
    const atom = this.atoms.get(id);
    if (!atom) return;
    atom.failures = 0;
    atom.lastSuccessAt = this.now();
    atom.state = HEALTHY;
  }

  isDead(id) {
    const atom = this.atoms.get(id);
    return !!atom && atom.state === DEAD && this.now() - atom.lastFailureAt < this.deadCooldownMs;
  }

  snapshot() {
    return [...this.atoms.values()].map((a) => ({
      id: a.id,
      host: a.host,
      port: a.port,
      state: a.state,
      failures: a.failures,
      lastSuccessAt: a.lastSuccessAt ? new Date(a.lastSuccessAt).toISOString() : null,
      lastFailureAt: a.lastFailureAt ? new Date(a.lastFailureAt).toISOString() : null,
    }));
  }
}

module.exports = { AtomRegistry, HEALTHY, DEGRADED, DEAD };
