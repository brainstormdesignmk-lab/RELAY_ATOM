'use strict';

/**
 * Point 3: per-client tokens. Every RELAY_TOKEN_<CLIENT> env var registers a
 * client identity; the legacy shared RELAY_TOKEN authenticates as "legacy".
 */
function buildTokenMap(env, prefix) {
  const map = new Map(); // token -> client identity
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || !value) continue;
    const client = key.slice(prefix.length).toLowerCase();
    if (client) map.set(value, client);
  }
  return map;
}

function createAuth(config, env = process.env) {
  const tokens = buildTokenMap(env, config.tokenEnvPrefix);
  if (config.legacyToken && !tokens.has(config.legacyToken)) {
    tokens.set(config.legacyToken, 'legacy');
  }

  return {
    /** Returns the client identity for a request, or null if unauthorized. */
    authenticate(req) {
      const token = req.headers['x-relay-token'];
      if (typeof token !== 'string' || token === '') return null;
      return tokens.get(token) || null;
    },
    hasClients() {
      return tokens.size > 0;
    },
    /** For tests/diagnostics only: never log token values. */
    clientNames() {
      return [...new Set(tokens.values())];
    },
  };
}

module.exports = { createAuth, buildTokenMap };
