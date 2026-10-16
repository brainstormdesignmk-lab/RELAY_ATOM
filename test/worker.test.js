'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Spool, RETRY_MAX } = require('../src/spool');
const { AtomRegistry } = require('../src/registry');
const { Worker } = require('../src/worker');

function makeSpool() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-worker-'));
  const dir = (name) => path.join(base, name);
  return new Spool({
    inbound: dir('inbound'),
    processing: dir('processing'),
    processed: dir('processed'),
    retry: dir('retry'),
    failed: dir('failed'),
    holding: dir('holding'),
    health: dir('health'),
    dedup: dir('dedup'),
  });
}

const envelope = (id) => ({ id, platform: 'telegram', chatId: '1', text: `m-${id}`, ts: new Date().toISOString() });

/** Stub atom: always 200, records bodies it received. */
function startStubAtom(status = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.writeHead(status);
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received })));
}

function makeWorker(spool, atoms, config = {}) {
  const registry = new AtomRegistry(atoms, { deadThreshold: 2, deadCooldownMs: 60000 });
  const worker = new Worker({
    spool,
    registry,
    config: {
      workerIntervalSeconds: 3600,
      retryDelaySeconds: 30,
      fetchTimeoutMs: 2000,
      legacyToken: 'tok',
      ...config,
    },
  });
  return { worker, registry };
}

test('delivers inbound to atom and finishes as processed', async () => {
  const spool = makeSpool();
  const { server, received } = await startStubAtom(200);
  const port = server.address().port;
  const { worker, registry } = makeWorker(spool, [
    { id: 'atom1', host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/message` },
  ]);
  spool.write('inbound', envelope('w1'));
  await worker.runOnce();
  assert.equal(spool.list('processed').length, 1);
  assert.equal(spool.list('inbound').length, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'w1');
  assert.equal(registry.get('atom1').state, 'healthy');
  server.close();
});

test('failed delivery retries, then parks in per-atom holding when dead', async () => {
  const spool = makeSpool();
  const { server } = await startStubAtom(500);
  const port = server.address().port;
  const atom = { id: 'atom1', host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/message` };
  const { worker, registry } = makeWorker(spool, [atom]);
  spool.write('inbound', envelope('w2'));

  // Attempt 1: HTTP 500 -> requeue (degraded).
  await worker.runOnce();
  assert.equal(spool.list('retry').length, 1);
  assert.equal(registry.get('atom1').state, 'degraded');

  // Attempt 2: still 500 -> threshold reached, dead + held.
  const retried = spool.claim(spool.list('retry')[0]);
  await worker.deliverClaimed(retried);
  assert.equal(registry.get('atom1').state, 'dead');
  assert.equal(spool.listHolding('atom1').length, 1);
  server.close();
});

test('retry queue waits for its delay, then delivers a due message', async () => {
  const spool = makeSpool();
  let status = 500;
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(status);
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const atom = { id: 'atom1', host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/message` };
  const { worker, registry } = makeWorker(spool, [atom], { retryDelaySeconds: 60 });
  spool.write('inbound', envelope('retry-due'));

  await worker.runOnce();
  assert.equal(spool.list('retry').length, 1);
  assert.equal(received.length, 1);

  // A retry before the configured delay stays parked.
  status = 200;
  await worker.runOnce();
  assert.equal(spool.list('retry').length, 1);
  assert.equal(received.length, 1);

  // Age only the retry metadata; no message content is changed.
  const retryPath = spool.list('retry')[0];
  const retryEnvelope = spool.read(retryPath);
  retryEnvelope.lastErrorAt = new Date(Date.now() - 61_000).toISOString();
  fs.writeFileSync(retryPath, JSON.stringify(retryEnvelope));
  await worker.runOnce();
  assert.equal(spool.list('retry').length, 0);
  assert.equal(spool.list('processed').length, 1);
  assert.equal(received.length, 2);
  assert.equal(received[1].id, 'retry-due');
  assert.equal(registry.get('atom1').state, 'healthy');
  server.close();
});

test('held messages replay oldest-first after recovery', async () => {
  const spool = makeSpool();
  let failMode = true;
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(failMode ? 500 : 200);
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const atom = { id: 'atom1', host: '127.0.0.1', port, url: `http://127.0.0.1:${port}/message` };
  const { worker, registry } = makeWorker(spool, [atom]);

  // Two messages arrive while atom is down -> both held.
  spool.write('inbound', envelope('r1'));
  await worker.runOnce(); // failure 1 -> retry
  spool.write('inbound', envelope('r2'));
  await worker.runOnce(); // failure 2 -> dead; r2 held
  const retried = spool.claim(spool.list('retry')[0]); // r1 still in retry
  await worker.deliverClaimed(retried); // dead -> held
  assert.equal(spool.listHolding('atom1').length, 2);

  // Atom recovers.
  failMode = false;
  registry.recordSuccess('atom1');
  await worker.runOnce();
  assert.equal(spool.listHolding('atom1').length, 0);
  assert.equal(spool.list('processed').length, 2);
  assert.equal(received[0].id, 'r1'); // oldest first
  assert.equal(received[1].id, 'r2');
  server.close();
});

test('atomicity: crash-mid-write leaves no partial file (tmp suffix ignored)', async () => {
  const spool = makeSpool();
  spool.write('inbound', envelope('ok'));
  // Simulate a crash mid-write: orphan tmp file.
  fs.writeFileSync(path.join(spool.dirs.inbound, '9999-torn.json.tmp-999-xyz'), '{"id":"torn"');
  const claimed = spool.drain('inbound');
  assert.equal(claimed.length, 1); // torn file is never picked up
  assert.equal(claimed[0].envelope.id, 'ok');
});

test('retry escalation matches RETRY_MAX', () => {
  assert.equal(RETRY_MAX, 5);
});
