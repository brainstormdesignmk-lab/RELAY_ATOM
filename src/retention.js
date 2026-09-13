'use strict';

const fs = require('node:fs');

/**
 * Point 4: retention. Deletes processed/ and failed/ envelopes older than
 * the configured ages. Isolated: any error is logged, never thrown, so a
 * retention bug cannot take down the relay.
 */
function runRetention({ dirs, retentionProcessedHours, retentionFailedDays, now = Date.now, log = () => {} }) {
  let removed = 0;
  const cutoffProcessed = now() - retentionProcessedHours * 3600 * 1000;
  const cutoffFailed = now() - retentionFailedDays * 24 * 3600 * 1000;
  const jobs = [
    { dir: dirs.processed, cutoff: cutoffProcessed },
    { dir: dirs.failed, cutoff: cutoffFailed },
  ];
  for (const { dir, cutoff } of jobs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = `${dir}/${name}`;
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch (err) {
        log(`[retention] skipped ${name}: ${err.message}`);
      }
    }
  }
  return removed;
}

module.exports = { runRetention };
