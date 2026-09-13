'use strict';

const { loadConfig } = require('./config');
const { createAuth } = require('./tokens');
const { Spool } = require('./spool');
const { DedupIndex } = require('./dedup');
const { AtomRegistry } = require('./registry');
const { Worker } = require('./worker');
const { createServer } = require('./server');
const { runRetention } = require('./retention');

function main() {
  const config = loadConfig(process.env);
  const auth = createAuth(config);
  const spool = new Spool(config.dirs);
  const dedup = new DedupIndex(config.dirs.dedup, { ttlMs: config.dedupTtlHours * 3600 * 1000 });
  const registry = new AtomRegistry(config.atoms, {
    deadThreshold: config.deadThreshold,
    deadCooldownMs: config.deadCooldownSeconds * 1000,
  });
  const worker = new Worker({ spool, registry, config });

  const server = createServer({ config, auth, spool, dedup, registry });

  // Point 4: retention sweep, hourly, isolated from request handling.
  const retentionTimer = setInterval(() => {
    try {
      const removed = runRetention({
        dirs: config.dirs,
        retentionProcessedHours: config.retentionProcessedHours,
        retentionFailedDays: config.retentionFailedDays,
        log: console.error,
      });
      if (removed > 0) console.error(`[retention] removed ${removed} envelope(s)`);
    } catch (err) {
      console.error(`[retention] error: ${err.message}`);
    }
  }, 3600 * 1000);
  retentionTimer.unref?.();

  worker.start();

  server.listen(config.port, config.host, () => {
    console.error(`[relay] ${config.nodeId} listening on ${config.host}:${config.port}`);
    console.error(`[relay] clients: ${auth.clientNames().join(', ') || 'none'}`);
    console.error(`[relay] atoms: ${config.atoms.map((a) => a.id).join(', ') || 'none'}`);
  });

  const shutdown = (signal) => {
    console.error(`[relay] ${signal} received, shutting down`);
    worker.stop();
    clearInterval(retentionTimer);
    server.close(() => process.exit(0));
    // Hard exit if connections refuse to drain.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
