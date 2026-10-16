'use strict';

// outbound.test.js — the reverse lane: secretaries push replies for a viber
// client bridge; the bridge claims/acks/nacks ONLY its own per-client queue
// (authenticated via RELAY_TOKEN_VIBER<n>). Covers: auth, per-client
// isolation, queue validation, nack requeue + dead-letter, stale-claim
// recovery, and /health exposure.

const { test } = require('./runner');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createAuth } = require('../src/tokens');
const { Spool } = require('../src/spool');
const { DedupIndex } = require('../src/dedup');
const { AtomRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
const { OutboundQueue } = require('../src/outbound');

function setup(env = {}, nowMs = Date.now()) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-outbound-'));
  const dir = (n) => path.join(base, n);
  const config = loadConfig({
    RELAY_PORT: '0',
    DATA_DIR: base,
    ATOM1_HOST: '127.0.0.1',
    ATOM1_PORT: '59991',
    ...env,
  });
  const envFull = {
    RELAY_TOKEN_LINA1: 'lina1-tok',
    RELAY_TOKEN_VIBER1: 'viber1-tok',
    RELAY_TOKEN_VIBER2: 'viber2-tok',
    ...env,
  };
  const auth = createAuth(config, envFull);
  const spool = new Spool(config.dirs);
  const dedup = new DedupIndex(config.dirs.dedup);
  const registry = new AtomRegistry(config.atoms);
  const server = createServer({ config, auth, spool, dedup, registry });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, spool, config, base, port: server.address().port }))
  );
}

function request(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(token ? { 'x-relay-token': token } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

test('outbound: lina1 pushes a reply into the viber1 queue and viber1 bridge claims it', async () => {
  const { server, base, port } = await setup();
  const push = await request(port, 'POST', '/outbound', {
    client: 'viber1',
    botId: 'LINA-1',
    to: '+389701234567',
    text: 'Здраво! Станот е слободен.',
  }, 'lina1-tok');
  assert.equal(push.status, 202);
  assert.equal(push.json.client, 'viber1');

  // viber2's bridge must NOT see viber1's message.
  const wrong = await request(port, 'GET', '/outbound/poll', undefined, 'viber2-tok');
  assert.equal(wrong.status, 200);
  assert.equal(wrong.json.claims.length, 0);

  const poll = await request(port, 'GET', '/outbound/poll', undefined, 'viber1-tok');
  assert.equal(poll.status, 200);
  assert.equal(poll.json.claims.length, 1);
  assert.equal(poll.json.claims[0].botId, 'LINA-1');
  assert.equal(poll.json.claims[0].to, '+389701234567');
  assert.ok(poll.json.claims[0].claimId);
  server.close();
});

test('outbound: poll requires a viber client token and claims are exclusive', async () => {
  const { server, port } = await setup();
  await request(port, 'POST', '/outbound', { client: 'viber1', botId: 'LINA-1', to: 'a', text: 'x' }, 'lina1-tok');
  const noTok = await request(port, 'GET', '/outbound/poll');
  assert.equal(noTok.status, 401);
  const badTok = await request(port, 'GET', '/outbound/poll', undefined, 'nope');
  assert.equal(badTok.status, 401);
  const first = await request(port, 'GET', '/outbound/poll', undefined, 'viber1-tok');
  assert.equal(first.json.claims.length, 1);
  const second = await request(port, 'GET', '/outbound/poll', undefined, 'viber1-tok');
  assert.equal(second.json.claims.length, 0); // claimed = gone from queue
  server.close();
});

test('outbound: ack completes delivery; nack requeues with attempts preserved', async () => {
  const { server, base, port } = await setup();
  await request(port, 'POST', '/outbound', { client: 'viber1', botId: 'LINA-1', to: 'a', text: 'one' }, 'lina1-tok');
  await request(port, 'POST', '/outbound', { client: 'viber1', botId: 'LINA-1', to: 'b', text: 'two' }, 'lina1-tok');
  const poll = await request(port, 'GET', '/outbound/poll?limit=2', undefined, 'viber1-tok');
  const [c1, c2] = poll.json.claims;

  const ack = await request(port, 'POST', '/outbound/ack', { claimId: c1.claimId }, 'viber1-tok');
  assert.equal(ack.status, 200);
  assert.ok(fs.existsSync(path.join(base, 'outbound', 'done', `${c1.claimId}.json`)));

  const nack = await request(port, 'POST', '/outbound/nack', { claimId: c2.claimId, reason: 'viber UI busy' }, 'viber1-tok');
  assert.equal(nack.status, 200);
  assert.equal(nack.json.status, 'requeued');
  const repoll = await request(port, 'GET', '/outbound/poll', undefined, 'viber1-tok');
  assert.equal(repoll.json.claims.length, 1);
  assert.equal(repoll.json.claims[0].text, 'two');
  server.close();
});

test('outbound: a bridge cannot ack another client claim (ownership enforced)', async () => {
  const { server, port } = await setup();
  await request(port, 'POST', '/outbound', { client: 'viber1', botId: 'LINA-1', to: 'a', text: 'x' }, 'lina1-tok');
  const poll = await request(port, 'GET', '/outbound/poll', undefined, 'viber1-tok');
  const claimId = poll.json.claims[0].claimId;
  const wrong = await request(port, 'POST', '/outbound/ack', { claimId }, 'viber2-tok');
  assert.equal(wrong.status, 404);
  const right = await request(port, 'POST', '/outbound/ack', { claimId }, 'viber1-tok');
  assert.equal(right.status, 200);
  server.close();
});

test('outbound: invalid queue name and empty text are rejected', async () => {
  const { server, port } = await setup();
  const badClient = await request(port, 'POST', '/outbound', { client: 'atom9', to: 'a', text: 'x' }, 'lina1-tok');
  assert.equal(badClient.status, 422);
  const noText = await request(port, 'POST', '/outbound', { client: 'viber1', to: 'a', text: '' }, 'lina1-tok');
  assert.equal(noText.status, 422);
  const noTo = await request(port, 'POST', '/outbound', { client: 'viber1', text: 'x' }, 'lina1-tok');
  assert.equal(noTo.status, 422);
  server.close();
});

test('outbound: nack past maxAttempts dead-letters; stale claims are recovered', async () => {
  const { server, base, port } = await setup();
  // Unit-level: drive attempts past maxAttempts directly on the queue.
  const oq = new OutboundQueue(base, { maxAttempts: 2 });
  const env = oq.push({ client: 'viber1', botId: 'LINA-1', to: 'a', text: 'x' });
  let c = oq.claim('viber1');
  oq.nack(c.claimId, 'fail 1');
  c = oq.claim('viber1');
  oq.nack(c.claimId, 'fail 2');
  c = oq.claim('viber1');
  const dead = oq.nack(c.claimId, 'fail 3');
  assert.equal(dead.status, 'failed');
  assert.equal(oq.claim('viber1'), null);
  assert.ok(fs.existsSync(path.join(base, 'outbound', 'failed')));

  // Stale claim recovery: claim, backdate the claim file, recover.
  oq.push({ client: 'viber1', botId: 'LINA-1', to: 'b', text: 'y' });
  const stale = oq.claim('viber1');
  const claimPath = path.join(base, 'outbound', 'claims', `${stale.claimId}.json`);
  const old = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(claimPath, old / 1000, old / 1000);
  const recovered = oq.reclaimStale();
  assert.equal(recovered, 1);
  const again = oq.claim('viber1');
  assert.ok(again);
  assert.equal(again.envelope.text, 'y');
  server.close();
});

test('outbound: /health exposes per-client outbound counts', async () => {
  const { server, port } = await setup();
  await request(port, 'POST', '/outbound', { client: 'viber1', botId: 'LINA-1', to: 'a', text: 'x' }, 'lina1-tok');
  const health = await request(port, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.outbound.viber1, 1);
  server.close();
});
