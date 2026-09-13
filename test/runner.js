'use strict';

/**
 * Minimal test runner for Node 16+ (built-in node:test requires 18).
 * Same test(name, fn) shape; sequential execution, one process.
 * Hard-exits so leftover server handles can never hang CI.
 */
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runAll() {
  let pass = 0;
  let n = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    n += 1;
    const t0 = Date.now();
    try {
      await fn();
      pass += 1;
      console.log(`ok ${n} - ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      failures.push({ name, err });
      const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : String(err);
      console.error(`not ok ${n} - ${name}\n    ${detail}`);
    }
  }
  console.log(`\n${tests.length} tests: ${pass} pass, ${failures.length} fail`);
  if (failures.length > 0) process.exit(1);
  process.exit(0);
}

module.exports = { test, runAll, _tests: tests };
