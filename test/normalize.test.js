'use strict';

const { test } = require('./runner');
const assert = require('node:assert');
const { normalize, whatsappVerifyChallenge, makeId } = require('../src/normalize');

test('telegram message normalizes to canonical schema', () => {
  const payload = {
    message: {
      chat: { id: 42 },
      from: { id: 7, first_name: 'Ada', last_name: 'Lovelace' },
      text: 'book me a table',
      date: 1700000000,
    },
  };
  const msg = normalize('telegram', payload);
  assert.equal(msg.platform, 'telegram');
  assert.equal(msg.chatId, '42');
  assert.equal(msg.senderId, '7');
  assert.equal(msg.senderName, 'Ada Lovelace');
  assert.equal(msg.text, 'book me a table');
  assert.equal(msg.ts, new Date(1700000000 * 1000).toISOString());
  assert.match(msg.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(msg.id.length, 24);
});

test('telegram non-message update normalizes to null', () => {
  assert.equal(normalize('telegram', { update_id: 1 }), null);
  assert.equal(normalize('telegram', {}), null);
});

test('viber message normalizes', () => {
  const payload = {
    event: 'message',
    sender: { id: 'vib1', name: 'Grace' },
    message: { text: 'hello', type: 'text' },
    timestamp: 1700000000000,
  };
  const msg = normalize('viber', payload);
  assert.equal(msg.platform, 'viber');
  assert.equal(msg.chatId, 'vib1');
  assert.equal(msg.senderName, 'Grace');
  assert.equal(msg.text, 'hello');
  assert.equal(normalize('viber', { event: 'delivered' }), null);
});

test('whatsapp cloud api payload normalizes', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Alan' } }],
              messages: [{ from: '15551234567', text: { body: 'hi' }, timestamp: '1700000000' }],
            },
          },
        ],
      },
    ],
  };
  const msg = normalize('whatsapp', payload);
  assert.equal(msg.platform, 'whatsapp');
  assert.equal(msg.chatId, '15551234567');
  assert.equal(msg.senderName, 'Alan');
  assert.equal(msg.text, 'hi');
  assert.equal(normalize('whatsapp', { entry: [] }), null); // e.g. status-only update
});

test('unknown platform throws', () => {
  assert.throws(() => normalize('skype', {}), /unknown platform/);
});

test('whatsapp verification handshake validates token', () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'sekret';
  const q = new URLSearchParams('hub.mode=subscribe&hub.verify_token=sekret&hub.challenge=CH4L');
  assert.equal(whatsappVerifyChallenge(q), 'CH4L');
  const bad = new URLSearchParams('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CH4L');
  assert.equal(whatsappVerifyChallenge(bad), null);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test('makeId is deterministic and platform-scoped', () => {
  const a = makeId('telegram', '42', '2023-01-01T00:00:00.000Z', 'x');
  const b = makeId('telegram', '42', '2023-01-01T00:00:00.000Z', 'x');
  const c = makeId('telegram', '43', '2023-01-01T00:00:00.000Z', 'x');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
