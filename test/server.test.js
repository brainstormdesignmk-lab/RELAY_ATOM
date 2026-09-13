'use strict';

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

function setup(env = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'));
  const dir = (n) => path.join(base, n);
  const config = loadConfig({
    RELAY_PORT: '0',
    DATA_DIR: base,
    RELAY_TOKEN: 'legacy-tok',
    RELAY_TOKEN_ADAPTER_TELEGRAM: 'tg-tok',
    ...env,
  });
  const auth = createAuth(config, { RELAY_TOKEN_ADAPTER_TELEGRAM: 'tg-tok' });
  const spool = new Spool(config.dirs);
  const dedup = new DedupIndex(config.dirs.dedup);
  const registry = new AtomRegistry(config.atoms);
  const server = createServer({ config, auth, spool, dedup, registry });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, spool, config, dedup, port: server.address().port })));
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
        res.on('end', () => resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null, raw }));
      }
    );
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

test('/health returns JSON with atom snapshot and queue counts', async () => {
  const { server, port } = await setup();
  const res = await request(port, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.equal(typeof res.json.uptimeSeconds, 'number');
  assert.deepEqual(res.json.queues, { inbound: 0, retry: 0, failed: 0, processed: 0, holding: 0 });
  assert.deepEqual(res.json.atoms, []);
  server.close();
});

test('requests without a valid token are rejected with 401', async () => {
  const { server, port } = await setup();
  const res = await request(port, 'POST', '/inbound', { platform: 'telegram', chatId: '1', text: 'x', ts: new Date().toISOString() });
  assert.equal(res.status, 401);
  server.close();
});

test('per-client tokens authenticate (point 3)', async () => {
  const { server, port, spool } = await setup();
  const envelope = { id: 'a1', platform: 'telegram', chatId: '42', text: 'hi', ts: new Date().toISOString(), correlationId: 'c1' };
  const res = await request(port, 'POST', '/inbound', envelope, 'tg-tok');
  assert.equal(res.status, 202);
  assert.equal(res.json.status, 'queued');
  assert.equal(spool.list('inbound').length, 1);
  server.close();
});

test('webhook telegram queues a normalized message', async () => {
  const { server, port, spool } = await setup();
  const payload = { message: { chat: { id: 42 }, from: { id: 7, first_name: 'A' }, text: 'book me', date: 1700000000 } };
  const res = await request(port, 'POST', '/webhook/telegram', payload, 'legacy-tok');
  assert.equal(res.status, 202);
  const files = spool.list('inbound');
  assert.equal(files.length, 1);
  const stored = spool.read(files[0]);
  assert.equal(stored.platform, 'telegram');
  assert.equal(stored.text, 'book me');
  server.close();
});

test('webhook redelivery is deduped (point 2)', async () => {
  const { server, port, spool } = await setup();
  const payload = { message: { chat: { id: 42 }, from: { id: 7 }, text: 'once', date: 1700000000 } };
  const first = await request(port, 'POST', '/webhook/telegram', payload, 'legacy-tok');
  const second = await request(port, 'POST', '/webhook/telegram', payload, 'legacy-tok');
  assert.equal(first.status, 202);
  assert.equal(second.json.status, 'duplicate-ignored');
  assert.equal(spool.list('inbound').length, 1);
  server.close();
});

test('non-message webhook events are accepted and ignored', async () => {
  const { server, port } = await setup();
  const res = await request(port, 'POST', '/webhook/viber', { event: 'delivered' }, 'legacy-tok');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ignored-non-message');
  server.close();
});

test('invalid envelopes are rejected with 422', async () => {
  const { server, port } = await setup();
  const res = await request(port, 'POST', '/inbound', { platform: 'sms', chatId: '', text: 5 }, 'legacy-tok');
  assert.equal(res.status, 422);
  assert.ok(res.json.problems.length >= 2);
  server.close();
});

test('unknown platform webhook returns 404, oversized body 413', async () => {
  const { server, port, config } = await setup();
  const res404 = await request(port, 'POST', '/webhook/skype', {}, 'legacy-tok');
  assert.equal(res404.status, 404);

  const big = 'x'.repeat(config.maxBodyBytes + 10);
  const res413 = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/webhook/telegram', method: 'POST', headers: { 'x-relay-token': 'legacy-tok', 'content-length': Buffer.byteLength(big) } },
      (r) => {
        let raw = '';
        r.on('data', (c) => (raw += c));
        r.on('end', () => resolve({ status: r.statusCode, raw }));
      }
    );
    req.on('error', reject);
    req.end(big);
  });
  assert.equal(res413.status, 413);
  server.close();
});

test('whatsapp GET verification handshake works end to end', async () => {
  const { server, port } = await setup({ WHATSAPP_VERIFY_TOKEN: 'v-tok' });
  const res = await request(port, 'GET', '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=v-tok&hub.challenge=1234');
  assert.equal(res.status, 200);
  assert.equal(res.raw, '1234');
  server.close();
});
