'use strict';

const http = require('node:http');
const { normalize, PLATFORMS, whatsappVerifyChallenge, toRelayEnvelope } = require('./normalize');
const { runRetention } = require('./retention');
const { OutboundQueue } = require('./outbound');

/**
 * HTTP surface:
 * - POST /webhook/:platform  (telegram|viber|whatsapp) -> normalize + queue
 * - POST /inbound            (adapters POST already-normalized envelopes)
 * - GET  /health             -> JSON status incl. atom health snapshot
 * Auth: X-Relay-Token, per-client identity (point 3).
 */
function createServer({ config, auth, spool, dedup, registry, outbound }) {
  let retentionTimer = null;
  // Outbound lane (secretary -> relay -> viber bridge). Constructed from the
  // same DATA_DIR unless injected (tests). Per-client subqueues keyed by the
  // authenticated client identity (RELAY_TOKEN_VIBER1 -> client "viber1").
  const oq = outbound || new OutboundQueue(config.dataDir);

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

  async function handleWebhook(req, res, platform, bot, rawBody) {
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
    // Per-identity envelope: the bot/atom/number identity comes from the
    // webhook PATH (/webhook/viber/lina1 -> LINA-1), never from a token map,
    // and Viber credentials never live on the relay.
    const envelope = toRelayEnvelope(msg, bot, platform);
    spool.write('inbound', envelope);
    return reply(res, 202, {
      status: 'queued',
      id: envelope.id,
      correlationId: envelope.correlationId,
      botId: envelope.botId,
      atomId: envelope.atomId,
    });
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
      version: '0.4.0',
      atoms: registry ? registry.snapshot() : [],
      bots: (config.bots || []).map((b) => ({
        botId: b.botId,
        atomId: b.atomId,
        numberId: b.numberId,
        // Token PRESENCE only — never the token value.
        relayAuth: b.token ? 'configured' : 'missing',
      })),
      queues: counts,
      outbound: oq.counts(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  // ---- outbound lane handlers ----

  function handleOutbound(req, res, rawBody, client) {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'invalid JSON' });
    }
    // The queue name must be a viber client queue (viber1|viber2|viber3...):
    // secretaries (linaN tokens) push replies there; bridges claim their own.
    const queueClient = typeof body.client === 'string' ? body.client.toLowerCase() : '';
    if (!/^viber\d+$/.test(queueClient)) {
      return reply(res, 422, { error: 'client must be viber<digit(s)>' });
    }
    // Spam-guard: channel/community notification ids are not addressable
    // conversations — a reply 'to' them can only fail at the phone. Channel
    // digests surfaced under a display name (e.g. "Purple Channel") are the
    // same promo surface and equally unaddressable.
    if (typeof body.to === 'string' && body.to.includes('community_message')) {
      return reply(res, 422, { error: 'unaddressable recipient: community/channel id' });
    }
    if (typeof body.to === 'string' && /^purple channel$/i.test(body.to.trim())) {
      return reply(res, 422, { error: 'unaddressable recipient: channel' });
    }
    try {
      const envelope = oq.push({ client: queueClient, botId: body.botId, to: body.to, text: body.text, meta: body.meta });
      return reply(res, 202, { status: 'queued', id: envelope.id, client: queueClient });
    } catch (err) {
      return reply(res, 422, { error: err.message });
    }
  }

  function handleOutboundPoll(res, client, params) {
    // A bridge claims ONLY from its own queue (authenticated client name).
    if (!/^viber\d+$/.test(client)) {
      return reply(res, 403, { error: `client ${client} has no viber outbound queue` });
    }
    oq.reclaimStale(); // recover claims abandoned by a crashed bridge
    const limit = Math.max(1, Math.min(20, parseInt(params.get('limit') || '5', 10) || 5));
    const claims = [];
    while (claims.length < limit) {
      const c = oq.claim(client);
      if (!c) break;
      claims.push({
        claimId: c.claimId,
        id: c.envelope.id,
        botId: c.envelope.botId,
        to: c.envelope.to,
        text: c.envelope.text,
        ts: c.envelope.ts,
      });
    }
    return reply(res, 200, { status: 'ok', claims });
  }

  /** Ownership check: the claim must belong to the authenticated client. */
  function ownedClaim(res, rawBody, client) {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      reply(res, 400, { error: 'invalid JSON' });
      return null;
    }
    if (!body || typeof body.claimId !== 'string' || !body.claimId) {
      reply(res, 422, { error: 'claimId required' });
      return null;
    }
    const envelope = oq.peek(body.claimId);
    if (!envelope || envelope.client !== client) {
      reply(res, 404, { error: 'no such claim for this client' });
      return null;
    }
    return { body, envelope };
  }

  function handleOutboundAck(req, res, rawBody, client) {
    const ctx = ownedClaim(res, rawBody, client);
    if (!ctx) return;
    return reply(res, oq.ack(ctx.body.claimId) ? 200 : 404, { status: 'done' });
  }

  function handleOutboundNack(req, res, rawBody, client) {
    const ctx = ownedClaim(res, rawBody, client);
    if (!ctx) return;
    const result = oq.nack(ctx.body.claimId, ctx.body.reason);
    if (result.status === 'gone') return reply(res, 404, { error: 'no such claim' });
    return reply(res, 200, { status: result.status });
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

    // Outbound lane: secretaries push replies for a viber client queue;
    // that client's bridge claims / acks / nacks ONLY its own queue.
    if (req.method === 'POST' && pathname === '/outbound') {
      return handleOutbound(req, res, body, client);
    }
    if (req.method === 'GET' && pathname === '/outbound/poll') {
      return handleOutboundPoll(res, client, url.searchParams);
    }
    if (req.method === 'POST' && pathname === '/outbound/ack') {
      return handleOutboundAck(req, res, body, client);
    }
    if (req.method === 'POST' && pathname === '/outbound/nack') {
      return handleOutboundNack(req, res, body, client);
    }

    // /webhook/<platform>            (legacy, platform-level)
    // /webhook/<platform>/<identity> (per-bot: /webhook/viber/lina1 -> LINA-1)
    const webhookMatch = pathname.match(/^\/webhook\/([a-z]+)(?:\/([a-z0-9_-]+))?$/);
    if (req.method === 'POST' && webhookMatch) {
      const platform = webhookMatch[1];
      if (!PLATFORMS.has(platform)) return reply(res, 404, { error: `unknown platform: ${platform}` });
      const identity = webhookMatch[2];
      let bot = null;
      if (identity) {
        bot = findBotByWebhook(config, platform, identity);
        if (!bot) return reply(res, 404, { error: `unknown bot identity: ${identity}` });
      }
      return handleWebhook(req, res, platform, bot, body);
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

/**
 * Identity resolution for /webhook/<platform>/<identity>. The identity is the
 * bot's config NAME lowercased (lina1 -> the bot registered as LINA1); the
 * platform comes from the path and must be a known platform. No token map:
 * the URL path IS the identity, and Viber credentials never live on the relay.
 */
function findBotByWebhook(config, platform, identity) {
  const wanted = identity.toLowerCase();
  for (const bot of config.bots || []) {
    if (bot.name.toLowerCase() === wanted) {
      return { ...bot, platform };
    }
  }
  return null;
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
