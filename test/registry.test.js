'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const { AtomRegistry, HEALTHY, DEGRADED, DEAD } = require('../src/registry');

const atoms = () => [
  { id: 'atom1', host: '127.0.0.1', port: 8301, url: 'http://127.0.0.1:8301/message' },
  { id: 'atom2', host: '127.0.0.1', port: 8302, url: 'http://127.0.0.1:8302/message' },
];

test('starts healthy and routes round-robin', () => {
  const r = new AtomRegistry(atoms());
  assert.equal(r.get('atom1').state, HEALTHY);
  assert.equal(r.next().id, 'atom1');
  assert.equal(r.next().id, 'atom2');
  assert.equal(r.next().id, 'atom1');
});

test('failures degrade then deaden an atom', () => {
  const r = new AtomRegistry(atoms(), { deadThreshold: 3 });
  r.recordFailure('atom1');
  assert.equal(r.get('atom1').state, DEGRADED);
  r.recordFailure('atom1');
  r.recordFailure('atom1');
  assert.equal(r.get('atom1').state, DEAD);
  assert.equal(r.isDead('atom1'), true);
});

test('dead atom is skipped while cooldown runs, retried after', () => {
  let t = 1000;
  const r = new AtomRegistry(atoms(), { deadThreshold: 1, deadCooldownMs: 60000, now: () => t });
  r.recordFailure('atom1'); // -> dead
  const ids = () => r.routable().map((a) => a.id);
  assert.deepEqual(ids(), ['atom2']);
  t += 61000; // cooldown elapsed
  assert.deepEqual(ids(), ['atom1', 'atom2']);
  assert.equal(r.isDead('atom1'), false);
});

test('success resets health', () => {
  const r = new AtomRegistry(atoms(), { deadThreshold: 1 });
  r.recordFailure('atom1');
  assert.equal(r.get('atom1').state, DEAD);
  r.recordSuccess('atom1');
  assert.equal(r.get('atom1').state, HEALTHY);
  assert.equal(r.get('atom1').failures, 0);
});

test('snapshot exposes state without internals', () => {
  const r = new AtomRegistry(atoms(), { deadThreshold: 1 });
  r.recordFailure('atom2');
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  const atom2 = snap.find((a) => a.id === 'atom2');
  assert.equal(atom2.state, DEAD);
  assert.ok(atom2.lastFailureAt);
  assert.equal(atom2.password, undefined);
});

test('unknown atom ids are ignored', () => {
  const r = new AtomRegistry(atoms());
  assert.equal(r.get('atom9'), null);
  r.recordFailure('atom9');
  r.recordSuccess('atom9');
  assert.equal(r.snapshot().every((a) => a.state === HEALTHY), true);
});
