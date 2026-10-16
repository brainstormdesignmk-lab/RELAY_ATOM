'use strict';

const path = require('node:path');

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  // 0 is meaningful (e.g. RELAY_PORT=0 -> ephemeral port in tests).
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const dir = (name) => path.join(dataDir, name);

  const atoms = [];
  for (let i = 1; i <= 9; i++) {
    const host = env[`ATOM${i}_HOST`];
    const port = intEnv(env, `ATOM${i}_PORT`, 0);
    if (host && port) {
      atoms.push({ id: `atom${i}`, host, port, url: `http://${host}:${port}/message` });
    }
  }

  // Identity-routed bots: RELAY_BOT_<NAME>=atomN registers a bot identity that
  // always routes to one atom (affinity). Example: RELAY_BOT_LINA1=atom1.
  // Optional per-bot env: RELAY_BOT_<NAME>_NUMBER (e.g. VIBER-1) and a
  // dedicated relay token RELAY_TOKEN_<NAME> (NOT a Viber credential — this is
  // relay-to-secretary auth only). The webhook /webhook/viber/<name-lowercase>
  // identifies the destination bot; Viber tokens never live on the relay.
  const bots = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('RELAY_BOT_') || !value) continue;
    if (key.endsWith('_NUMBER') || key.endsWith('_TOKEN')) continue;
    const name = key.slice('RELAY_BOT_'.length);
    if (!name || !/^atom[1-9]$/.test(value)) continue;
    // Name convention: LINA1 -> botId LINA-1 (letter prefix + instance number).
    const m = name.match(/^([A-Z]+)(\d*)$/);
    const botId = m ? (m[2] ? `${m[1]}-${m[2]}` : m[1]) : name;
    const atomId = value;
    bots.push({
      name,
      botId,
      atomId,
      numberId: env[`RELAY_BOT_${name}_NUMBER`] || '',
      token: env[`RELAY_TOKEN_${name}`] || '',
    });
  }
  bots.sort((a, b) => (a.name < b.name ? -1 : 1));

  return {
    nodeId: env.NODE_ID || 'unknown',
    role: env.RELAY_ROLE || 'relay',
    host: env.RELAY_HOST || '0.0.0.0',
    port: intEnv(env, 'RELAY_PORT', 8400),
    dataDir,
    dirs: {
      inbound: dir('inbound'),
      processing: dir('processing'),
      processed: dir('processed'),
      retry: dir('retry'),
      failed: dir('failed'),
      holding: dir('holding'),
      health: dir('health'),
      dedup: dir('dedup'),
    },
    atoms,
    bots,
    // Shared legacy token (identity "legacy") plus per-client tokens:
    // every env var named RELAY_TOKEN_<CLIENT> maps client -> token.
    tokenEnvPrefix: 'RELAY_TOKEN_',
    legacyToken: env.RELAY_TOKEN || '',
    retryMax: intEnv(env, 'RETRY_MAX', 5),
    retryDelaySeconds: intEnv(env, 'RETRY_DELAY_SECONDS', 30),
    workerIntervalSeconds: intEnv(env, 'WORKER_INTERVAL_SECONDS', 15),
    // Atom health thresholds (point 5: distinguish slow from dead)
    deadThreshold: intEnv(env, 'ATOM_DEAD_THRESHOLD', 3),
    deadCooldownSeconds: intEnv(env, 'ATOM_DEAD_COOLDOWN_SECONDS', 60),
    // Retention (point 4: privacy)
    retentionProcessedHours: intEnv(env, 'RETENTION_PROCESSED_HOURS', 24),
    retentionFailedDays: intEnv(env, 'RETENTION_FAILED_DAYS', 30),
    dedupTtlHours: intEnv(env, 'DEDUP_TTL_HOURS', 24),
    fetchTimeoutMs: intEnv(env, 'ATOM_FETCH_TIMEOUT_MS', 5000),
    maxBodyBytes: intEnv(env, 'MAX_BODY_BYTES', 1048576),
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
  };
}

module.exports = { loadConfig };
