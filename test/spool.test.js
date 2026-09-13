'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Spool, RETRY_MAX } = require('../src/spool');

function makeSpool() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-spool-'));
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

const envelope = (id) => ({ id, platform: 'telegram', chatId: '42', text: `m-${id}`, ts: new Date().toISOString() });

test('write persists atomically and lists', () => {
  const s = makeSpool();
  s.write('inbound', envelope('one'));
  const files = s.list('inbound');
  assert.equal(files.length, 1);
  assert.deepEqual(s.read(files[0]).id, 'one');
});

test('claim is single-winner', () => {
  const s = makeSpool();
  s.write('inbound', envelope('two'));
  const [f] = s.list('inbound');
  const c1 = s.claim(f);
  assert.ok(c1);
  assert.equal(s.claim(f), null); // loser gets null (ENOENT)
  assert.equal(s.list('inbound').length, 0);
  assert.equal(s.list('processing').length, 1);
});

test('requeueOrFail escalates retry then dead-letters', () => {
  const s = makeSpool();
  s.write('inbound', envelope('three'));
  let claimed = s.claim(s.list('inbound')[0]);
  for (let i = 1; i <= RETRY_MAX; i++) {
    const r = s.requeueOrFail(claimed, new Error(`boom-${i}`));
    assert.equal(r.dirName, 'retry');
    assert.equal(r.envelope.attempts, i);
    claimed = s.claim(s.list('retry')[0]);
  }
  const dead = s.requeueOrFail(claimed, new Error('final'));
  assert.equal(dead.dirName, 'failed');
  assert.match(dead.envelope.lastError, /final/);
  assert.equal(s.list('retry').length, 0);
  assert.equal(s.list('failed').length, 1);
});

test('holdFor parks messages per atom in order', () => {
  const s = makeSpool();
  s.write('inbound', envelope('h1'));
  s.write('inbound', envelope('h2'));
  for (const f of s.list('inbound')) s.holdFor(s.claim(f), 'atom1');
  const held = s.listHolding('atom1');
  assert.equal(held.length, 2);
  assert.match(s.read(held[0]).id, /h1/); // oldest first
  assert.match(s.read(held[1]).id, /h2/);
});

test('finish moves claimed to processed', () => {
  const s = makeSpool();
  s.write('inbound', envelope('done'));
  const c = s.claim(s.list('inbound')[0]);
  s.finish(c, 'processed');
  assert.equal(s.list('processing').length, 0);
  assert.equal(s.list('processed').length, 1);
});

test('drain claims oldest first and skips vanished files', () => {
  const s = makeSpool();
  s.write('inbound', envelope('d1'));
  s.write('inbound', envelope('d2'));
  const claimed = s.drain('inbound');
  assert.equal(claimed.length, 2);
  assert.match(claimed[0].envelope.id, /d1/);
  assert.equal(s.list('inbound').length, 0);
  assert.equal(s.drain('inbound').length, 0);
});
