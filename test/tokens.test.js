'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const { buildTokenMap, createAuth } = require('../src/tokens');

test('buildTokenMap maps per-client tokens to identities', () => {
  const env = {
    RELAY_TOKEN_ADAPTER_TELEGRAM: 'tok-tg',
    RELAY_TOKEN_ATOM5: 'tok-a5',
    RELAY_TOKEN_EMPTY: '',
    UNRELATED: 'nope',
  };
  const map = buildTokenMap(env, 'RELAY_TOKEN_');
  assert.equal(map.get('tok-tg'), 'adapter_telegram');
  assert.equal(map.get('tok-a5'), 'atom5');
  assert.equal(map.size, 2); // empty value and unrelated var ignored
});

function reqWith(token) {
  return { headers: token === undefined ? {} : { 'x-relay-token': token } };
}

test('authenticate resolves client identity from X-Relay-Token', () => {
  process.env.RELAY_TOKEN_ADAPTER_VIBER = 'tok-viber';
  const auth = createAuth({ tokenEnvPrefix: 'RELAY_TOKEN_', legacyToken: '' });
  assert.equal(auth.authenticate(reqWith('tok-viber')), 'adapter_viber');
  assert.equal(auth.authenticate(reqWith('wrong')), null);
  assert.equal(auth.authenticate(reqWith(undefined)), null);
  assert.equal(auth.authenticate(reqWith('')), null);
  delete process.env.RELAY_TOKEN_ADAPTER_VIBER;
});

test('legacy shared token authenticates as legacy identity', () => {
  const auth = createAuth({ tokenEnvPrefix: 'RELAY_TOKEN_', legacyToken: 'old-shared' });
  assert.equal(auth.authenticate(reqWith('old-shared')), 'legacy');
  assert.equal(auth.clientNames().includes('legacy'), true);
});
