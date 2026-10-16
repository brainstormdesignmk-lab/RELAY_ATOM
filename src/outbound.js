'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Outbound queue — the reverse lane of the relay.
 *
 * Inbound lane:  platform -> relay spool -> worker -> atom (/message).
 * Outbound lane: secretary (atom) -> POST /outbound -> THIS queue
 *                -> viber client bridge (claim) -> real Viber app on the phone
 *                -> ack (done) / nack (requeue or dead-letter).
 *
 * One subdirectory per client identity (viber1|viber2|viber3), matching the
 * per-client RELAY_TOKEN_<CLIENT> auth. Same discipline as Spool: atomic
 * writes (tmp+fsync+rename), claim-by-rename (single winner), JSON envelopes.
 *
 * Clients are never addressed by Viber credentials here: `to` is the peer's
 * phone number/chat id as the secretary addressed it; the bridge resolves it
 * to a chat in ITS OWN logged-in Viber account.
 */
class OutboundQueue {
  constructor(dataDir, { now = Date.now, claimTimeoutMs = 120000, maxAttempts = 5 } = {}) {
    this.base = path.join(dataDir, 'outbound');
    this.claimsDir = path.join(this.base, 'claims');
    this.doneDir = path.join(this.base, 'done');
    this.failedDir = path.join(this.base, 'failed');
    this.now = now;
    this.claimTimeoutMs = claimTimeoutMs;
    this.maxAttempts = maxAttempts;
    for (const d of [this.claimsDir, this.doneDir, this.failedDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  clientDir(client) {
    const dir = path.join(this.base, client);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Queue a reply for a viber client. Returns the stored envelope. */
  push({ client, botId, to, text, meta }) {
    if (!client || !/^[a-z0-9_-]+$/i.test(client)) throw new Error('outbound: invalid client');
    if (!to || typeof to !== 'string') throw new Error('outbound: missing recipient');
    if (typeof text !== 'string' || text === '') throw new Error('outbound: empty text');
    const envelope = {
      id: crypto.randomUUID(),
      client,
      botId: botId || null,
      to,
      text,
      ts: new Date().toISOString(),
      attempts: 0,
      ...(meta ? { meta } : {}),
    };
    const finalPath = path.join(this.clientDir(client), `${Date.now()}-${envelope.id}.json`);
    const tmp = `${finalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, finalPath);
    return envelope;
  }

  /** Atomically claim the oldest queued message for a client, or null. */
  claim(client) {
    let files = [];
    try {
      files = fs
        .readdirSync(this.clientDir(client))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(this.clientDir(client), f));
    } catch {
      return null;
    }
    for (const filePath of files) {
      const claimId = path.basename(filePath, '.json');
      const dest = path.join(this.claimsDir, `${claimId}.json`);
      try {
        fs.renameSync(filePath, dest);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // raced: another worker took it
        throw err;
      }
      return { claimId, path: dest, envelope: JSON.parse(fs.readFileSync(dest, 'utf8')) };
    }
    return null;
  }

  /** Read a claimed envelope without taking it (ownership check + redelivery). */
  peek(claimId) {
    const p = path.join(this.claimsDir, `${claimId}.json`);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Delivery confirmed on the phone: done/. */
  ack(claimId) {
    const src = path.join(this.claimsDir, `${claimId}.json`);
    try {
      fs.renameSync(src, path.join(this.doneDir, `${claimId}.json`));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Delivery failed: requeue, or dead-letter past maxAttempts. */
  nack(claimId, reason) {
    const src = path.join(this.claimsDir, `${claimId}.json`);
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'gone' };
      throw err;
    }
    envelope.attempts = (envelope.attempts || 0) + 1;
    envelope.lastError = String(reason || 'unknown');
    envelope.lastErrorAt = new Date().toISOString();
    const dest =
      envelope.attempts > this.maxAttempts
        ? path.join(this.failedDir, `${claimId}.json`)
        : path.join(this.clientDir(envelope.client), `${Date.now()}-${claimId}.json`);
    const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    fs.renameSync(src, dest); // move original out of claims
    fs.renameSync(tmp, dest); // replace with updated envelope
    return { status: envelope.attempts > this.maxAttempts ? 'failed' : 'requeued', envelope };
  }

  /**
   * Crash recovery: a bridge that claimed messages and died before ack/nack
   * leaves orphans in claims/. Anything older than claimTimeoutMs goes back
   * to its client queue (attempts preserved). Called before each poll.
   */
  reclaimStale() {
    let names = [];
    try {
      names = fs.readdirSync(this.claimsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    let moved = 0;
    for (const name of names) {
      const p = path.join(this.claimsDir, name);
      try {
        if (this.now() - fs.statSync(p).mtimeMs < this.claimTimeoutMs) continue;
        const envelope = JSON.parse(fs.readFileSync(p, 'utf8'));
        const requeueName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`;
        fs.renameSync(p, path.join(this.clientDir(envelope.client), requeueName));
        moved += 1;
      } catch {
        // raced with ack/nack — leave it
      }
    }
    return moved;
  }

  /** Pending count per client (queued only, not claims). */
  counts() {
    const out = {};
    let clients = [];
    try {
      clients = fs.readdirSync(this.base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out;
    }
    for (const c of clients) {
      if (c === 'claims' || c === 'done' || c === 'failed') continue;
      try {
        out[c] = fs.readdirSync(path.join(this.base, c)).filter((f) => f.endsWith('.json')).length;
      } catch {
        out[c] = 0;
      }
    }
    return out;
  }
}

module.exports = { OutboundQueue };
