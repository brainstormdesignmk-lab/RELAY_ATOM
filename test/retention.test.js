'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRetention } = require('../src/retention');

function tmpDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retention-'));
  const dir = (n) => {
    fs.mkdirSync(path.join(base, n), { recursive: true });
    return path.join(base, n);
  };
  return { processed: dir('processed'), failed: dir('failed') };
}

function writeEnvelope(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ id: name }));
  return p;
}

function ageFile(p, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

test('removes old processed envelopes, keeps fresh ones', () => {
  const dirs = tmpDirs();
  const oldP = writeEnvelope(dirs.processed, 'old.json');
  const newP = writeEnvelope(dirs.processed, 'new.json');
  ageFile(oldP, 48 * 3600 * 1000);
  const removed = runRetention({ dirs, retentionProcessedHours: 24, retentionFailedDays: 30 });
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldP), false);
  assert.equal(fs.existsSync(newP), true);
});

test('failed envelopes live longer than processed ones', () => {
  const dirs = tmpDirs();
  const p = writeEnvelope(dirs.failed, 'dead.json');
  ageFile(p, 5 * 24 * 3600 * 1000); // 5 days old
  runRetention({ dirs, retentionProcessedHours: 24, retentionFailedDays: 30 });
  assert.equal(fs.existsSync(p), true); // inside 30-day window
  ageFile(p, 40 * 24 * 3600 * 1000);
  runRetention({ dirs, retentionProcessedHours: 24, retentionFailedDays: 30 });
  assert.equal(fs.existsSync(p), false);
});

test('ignores non-json files and missing dirs', () => {
  const dirs = tmpDirs();
  fs.writeFileSync(path.join(dirs.processed, 'keep.txt'), 'x');
  const removed = runRetention({
    dirs: { ...dirs, processed: path.join(dirs.processed, 'does-not-exist') },
    retentionProcessedHours: 24,
    retentionFailedDays: 30,
  });
  assert.equal(removed, 0);
  assert.equal(fs.existsSync(path.join(dirs.processed, 'keep.txt')), true);
});
