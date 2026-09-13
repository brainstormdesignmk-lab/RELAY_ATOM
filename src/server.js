'use strict';

const http = require('node:http');
const { normalize, PLATFORMS, whatsappVerifyChallenge } = require('./normalize');
const { runRetention } = require('./retention');

/**
 * HTTP surface:
 * - POST /webhook/:platform  (telegram|viber|whatsapp) -> normalize + queue
 * - POST /inbound            (adapters POST already-normalized envelopes)
 * - GET  /health             -> JSON status incl. atom health snapshot
 * Auth: X-Relay-Token, per-client identity (point 3).
 */
function createServer({ config, auth, spool, dedup, registry }) {
  let retentionTimer = null;

  async function handleInbound(req, res, rawBody) {
    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'invalid JSON' });
    }
    const problems = validateEnvelope(envelope);
    if (problems.length) return reply(res, 422, { error: 'invalid envelope', problems });
    const key = envelope.id || envelope.correlationId;
    if (dedup.seen(key)) {
      return reply(res, 200, { status: 'duplicate-ignored', id: envelope.id });
    }
    dedup.remember(key);
    spool.write('inbound', withDefaults(envelope));
    return reply(res, 202, { status: 'queued', id: envelope.id, correlationId: envelope.correlationId });
  }

  async function handleWebhook(req, res, platform, rawBody) {
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'invalid JSON' });
    }
    let msg = null;
    try {
      msg = normalize(platform, payload, new Date().toISOString());
    } catch (err) {
      return reply(res, 404, { error: err.message });
    }
    if (!msg) {
      // Receipts/updates without a user message: accepted, nothing to queue.
      return reply(res, 200, { status: 'ignored-non-message' });
    }
    if (dedup.seen(msg.id)) {
      return reply(res, 200, { status: 'duplicate-ignored', id: msg.id });
    }
    dedup.remember(msg.id);
    spool.write('inbound', msg);
    return reply(res, 202, { status: 'queued', id: msg.id, correlationId: msg.correlationId });
  }

  function handleHealth(res) {
    const counts = {};
    for (const key of ['inbound', 'retry', 'failed', 'processed']) {
      counts[key] = spool.list(key).length;
    }
    counts.holding = countHolding(spool);
    reply(res, 200, {
      status: 'ok',
      node: config.nodeId,
      role: config.role,
      version: '0.3.0',
      atoms: registry ? registry.snapshot() : [],
      queues: counts,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  function route(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return handleHealth(res);
    }

    // WhatsApp GET verification handshake.
    if (req.method === 'GET' && pathname.startsWith('/webhook/whatsapp')) {
      const challenge = whatsappVerifyChallenge(url.searchParams, config.whatsappVerifyToken);
      if (challenge) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(challenge);
        return;
      }
      return reply(res, 403, { error: 'verification failed' });
    }

    const client = auth.authenticate(req);
    if (!client) {
      res.setHeader('www-authenticate', 'X-Relay-Token');
      return reply(res, 401, { error: 'missing or invalid X-Relay-Token' });
    }

    if (req.method === 'POST' && pathname === '/inbound') {
      return handleInbound(req, res, body);
    }

    const webhookMatch = pathname.match(/^\/webhook\/([a-z]+)$/);
    if (req.method === 'POST' && webhookMatch) {
      const platform = webhookMatch[1];
      if (!PLATFORMS.has(platform)) return reply(res, 404, { error: `unknown platform: ${platform}` });
      return handleWebhook(req, res, platform, body);
    }

    return reply(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        done = true;
        reply(res, 413, { error: 'body too large' });
        req.removeAllListeners('data');
        req.resume(); // drain without buffering; never destroy mid-response
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        // Node 16 makes unhandled rejections fatal: catch async handler
        // failures explicitly and answer 500 instead of dying.
        const result = route(req, res, Buffer.concat(chunks));
        if (result && typeof result.catch === 'function') {
          result.catch(() => reply(res, 500, { error: 'internal error' }));
        }
      } catch (err) {
        reply(res, 500, { error: 'internal error' });
      }
    });
    req.on('error', () => {});
  });
}

function countHolding(spool) {
  let total = 0;
  for (const atomId of fsListDirs(spool.dirs.holding)) {
    total += spool.listHolding(atomId).length;
  }
  return total;
}

function fsListDirs(base) {
  try {
    const fs = require('node:fs');
    return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function withDefaults(envelope) {
  return {
    attempts: 0,
    ...envelope,
    receivedAt: envelope.receivedAt || new Date().toISOString(),
  };
}

function validateEnvelope(envelope) {
  const problems = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return ['envelope must be an object'];
  }
  if (typeof envelope.platform !== 'string' || !PLATFORMS.has(envelope.platform)) {
    problems.push('platform must be one of telegram|viber|whatsapp');
  }
  if (typeof envelope.chatId !== 'string' || envelope.chatId === '') {
    problems.push('chatId must be a non-empty string');
  }
  if (typeof envelope.text !== 'string') problems.push('text must be a string');
  if (typeof envelope.ts !== 'string' || Number.isNaN(Date.parse(envelope.ts))) {
    problems.push('ts must be an ISO timestamp string');
  }
  return problems;
}

function reply(res, status, obj) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

module.exports = { createServer };
