'use strict';

// routing.test.js — identity routing for the one-pair vertical slice.
// Covers slice criteria: /webhook/viber/lina1 received and identified as
// LINA-1, pickAtom("LINA-1") -> ATOM1, per-identity relay auth, unknown
// identity and unknown botId rejection, and wrong-atom isolation (a LINA-1
// message can never be routed to another atom, even when its own atom is dead
// or other atoms are alive).

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
const { Worker } = require('../src/worker');
const { createServer } = require('../src/server');

const VIBER_PAYLOAD = {
  event: 'message',
  message_token: 778899,
  timestamp: 1700000000000,
  sender: { id: '389701234567', name: 'Marko' },
  message: { type: 'text', text: 'Здраво, дали станот е слободен?' },
};

function setup(env = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-routing-'));
  const dir = (n) => path.join(base, n);
  const config = loadConfig({
    RELAY_PORT: '0',
    DATA_DIR: base,
    RELAY_TOKEN: 'legacy-tok', // platform adapter ingress (same convention as server.test.js)
    RELAY_BOT_LINA1: 'atom1',
    RELAY_BOT_LINA1_NUMBER: 'VIBER-1',
    RELAY_TOKEN_LINA1: 'lina1-relay-tok',
    ATOM1_HOST: '127.0.0.1',
    ATOM1_PORT: '59991',
    ATOM2_HOST: '127.0.0.1',
    ATOM2_PORT: '59992',
    ...env,
  });
  const auth = createAuth(config, { RELAY_TOKEN_LINA1: 'lina1-relay-tok' });
  const spool = new Spool(config.dirs);
  const dedup = new DedupIndex(config.dirs.dedup);
  const registry = new AtomRegistry(config.atoms);
  const server = createServer({ config, auth, spool, dedup, registry });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, spool, config, registry, port: server.address().port }))
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

/** Stub atom that records which token and body it received. */
function startStubAtom(status = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ envelope: JSON.parse(body || '{}'), token: req.headers['x-relay-token'] });
      res.writeHead(status);
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

test('criterion 1+2: /webhook/viber/lina1 receives the event and identifies it as LINA-1 -> ATOM1', async () => {
  const { server, spool, port } = await setup();
  const res = await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'legacy-tok');
  assert.equal(res.status, 202);
  assert.equal(res.json.botId, 'LINA-1');
  assert.equal(res.json.atomId, 'atom1');
  const files = spool.list('inbound');
  assert.equal(files.length, 1);
  const env = spool.read(files[0]);
  // Contract envelope fields:
  assert.equal(env.botId, 'LINA-1');
  assert.equal(env.atomId, 'atom1');
  assert.equal(env.channel, 'viber');
  assert.equal(env.numberId, 'VIBER-1');
  assert.equal(env.messageId, '778899'); // Viber message_token when present
  assert.equal(env.from, '389701234567');
  assert.equal(env.text, 'Здраво, дали станот е слободен?');
  server.close();
});

test('criterion 3: pickAtom("LINA-1") always resolves to ATOM1 (affinity)', async () => {
  const { spool, config } = await setup();
  const registry = new AtomRegistry(config.atoms);
  const worker = new Worker({ spool, registry, config });
  assert.equal(worker.atomForBot('LINA-1'), 'atom1');
  // Even with round-robin pressure from other traffic, the botId pins the atom.
  const atom = worker.pickAtom(null, { botId: 'LINA-1' });
  assert.equal(atom.id, 'atom1');
  assert.equal(worker.pickAtom(null, { botId: 'LINA-1' }).id, 'atom1');
});

test('criterion 12: a LINA-1 message can never be routed to another atom', async () => {
  // ATOM2 alive and round-robin eligible, ATOM1 absent (as if down/unconfigured).
  const { server, spool, port } = await setup({ ATOM1_HOST: '', ATOM1_PORT: '' });
  await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'legacy-tok');
  const registry = new AtomRegistry(loadConfig({ ATOM2_HOST: '127.0.0.1', ATOM2_PORT: '59992' }).atoms);
  const config = loadConfig({
    ATOM2_HOST: '127.0.0.1',
    ATOM2_PORT: '59992',
    RELAY_BOT_LINA1: 'atom1',
    RELAY_TOKEN_LINA1: 'lina1-relay-tok',
  });
  const worker = new Worker({ spool, registry, config });
  await worker.runOnce();
  // Nothing delivered anywhere; the message waits under its OWN atom's holding.
  assert.equal(spool.list('processed').length, 0);
  assert.equal(spool.list('retry').length, 0);
  assert.equal(spool.list('failed').length, 0);
  const held = spool.listHolding('atom1');
  assert.equal(held.length, 1);
  assert.equal(spool.read(held[0]).botId, 'LINA-1');
  assert.equal(spool.listHolding('atom2').length, 0);
  server.close();
});

test('criterion 4: relay authenticates the Lina connection with the dedicated token', async () => {
  const { server, spool, port } = await setup();
  // Worker delivers with the per-identity token, not the legacy one.
  const stub = await startStubAtom();
  const cfg = loadConfig({
    ATOM1_HOST: '127.0.0.1',
    ATOM1_PORT: String(stub.port),
    RELAY_BOT_LINA1: 'atom1',
    RELAY_TOKEN_LINA1: 'lina1-relay-tok',
  });
  const registry = new AtomRegistry(cfg.atoms);
  const worker = new Worker({ spool, registry, config: cfg });
  await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'legacy-tok');
  await worker.runOnce();
  assert.equal(stub.received.length, 1);
  assert.equal(stub.received[0].token, 'lina1-relay-tok');
  assert.equal(stub.received[0].envelope.botId, 'LINA-1');
  assert.equal(spool.list('processed').length, 1);
  stub.server.close();
  server.close();
});

test('criterion 10: invalid relay authentication is rejected', async () => {
  const { server, spool, port } = await setup();
  const noToken = await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD);
  assert.equal(noToken.status, 401);
  const badToken = await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'wrong-token');
  assert.equal(badToken.status, 401);
  assert.equal(spool.list('inbound').length, 0);
  server.close();
});

test('criterion 11: unknown bot identity is rejected at the webhook and never routed', async () => {
  const { server, spool, port } = await setup();
  const res = await request(port, 'POST', '/webhook/viber/lina2', VIBER_PAYLOAD, 'legacy-tok');
  assert.equal(res.status, 404);
  assert.equal(spool.list('inbound').length, 0);
  // An envelope with an unknown botId that somehow reached the spool is
  // dead-lettered by the worker — it must never reach ANY atom.
  spool.write('inbound', {
    id: 'x1', platform: 'viber', chatId: '1', text: 'hi', ts: new Date().toISOString(),
    botId: 'LINA-9', atomId: null, attempts: 0,
  });
  const cfg = loadConfig({ ATOM1_HOST: '127.0.0.1', ATOM1_PORT: '59991' });
  const registry = new AtomRegistry(cfg.atoms);
  const worker = new Worker({ spool, registry, config: cfg });
  await worker.runOnce();
  assert.equal(spool.list('failed').length, 1);
  assert.equal(spool.list('processed').length, 0);
  server.close();
});

test('non-message Viber events on the identity path are accepted and ignored', async () => {
  const { server, spool, port } = await setup();
  const res = await request(port, 'POST', '/webhook/viber/lina1', { event: 'delivered' }, 'legacy-tok');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ignored-non-message');
  assert.equal(spool.list('inbound').length, 0);
  server.close();
});

test('identity path is deduped like the platform-level webhook', async () => {
  const { server, spool, port } = await setup();
  const first = await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'legacy-tok');
  const second = await request(port, 'POST', '/webhook/viber/lina1', VIBER_PAYLOAD, 'legacy-tok');
  assert.equal(first.status, 202);
  assert.equal(second.json.status, 'duplicate-ignored');
  assert.equal(spool.list('inbound').length, 1);
  server.close();
});
