'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DedupIndex } = require('../src/dedup');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dedup-'));
}

test('remember/seen round trip', () => {
  const d = new DedupIndex(tmpDir());
  assert.equal(d.seen('a'), false);
  d.remember('a');
  assert.equal(d.seen('a'), true);
  assert.equal(d.seen('b'), false);
});

test('entries expire after ttl', () => {
  let t = 1000;
  const d = new DedupIndex(tmpDir(), { ttlMs: 500, now: () => t });
  d.remember('a');
  assert.equal(d.seen('a'), true);
  t += 501;
  assert.equal(d.seen('a'), false);
});

test('seen ids survive restart via persistence', () => {
  const dir = tmpDir();
  const d1 = new DedupIndex(dir);
  d1.remember('persist-me');
  const d2 = new DedupIndex(dir);
  assert.equal(d2.seen('persist-me'), true);
});

test('corrupt lines are tolerated on load', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'seen.jsonl'), '{"id":"good","expiresAt":9999999999999}\nNOT JSON\n\n');
  const d = new DedupIndex(dir);
  assert.equal(d.seen('good'), true);
});

test('compact keeps only live entries', () => {
  let t = 0;
  const dir = tmpDir();
  const d = new DedupIndex(dir, { ttlMs: 100, now: () => t, compactAfter: 2 });
  d.remember('old'); // expires at t=100
  t = 150;
  d.remember('new'); // expires at t=250; 2nd append triggers compact -> 'old' evicted
  d.remember('newer');
  assert.equal(d.seen('old'), false);
  assert.equal(d.seen('new'), true);
  const d2 = new DedupIndex(dir, { now: () => t });
  assert.equal(d2.seen('old'), false);
  assert.equal(d2.seen('new'), true);
  assert.equal(d2.seen('newer'), true);
});
