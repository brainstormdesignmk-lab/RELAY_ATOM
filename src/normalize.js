'use strict';

const crypto = require('node:crypto');

const PLATFORMS = new Set(['telegram', 'viber', 'whatsapp']);

/** Deterministic message id so platform-level redelivery can be deduped. */
function makeId(platform, chatId, ts, text) {
  return crypto
    .createHash('sha256')
    .update(`${platform}|${chatId}|${ts}|${text}`)
    .digest('hex')
    .slice(0, 24);
}

function base(ts) {
  const correlationId = crypto.randomUUID();
  return {
    id: null,
    platform: null,
    chatId: null,
    senderId: null,
    senderName: '',
    text: '',
    ts,
    correlationId,
    receivedAt: new Date().toISOString(),
  };
}

function normalizeTelegram(payload, receivedAt) {
  const msg = payload.message || payload.edited_message;
  if (!msg || typeof msg !== 'object') return null;
  const out = base(receivedAt);
  out.platform = 'telegram';
  out.chatId = String(msg.chat && msg.chat.id);
  out.senderId = String(msg.from && msg.from.id);
  out.senderName = [msg.from && msg.from.first_name, msg.from && msg.from.last_name]
    .filter(Boolean)
    .join(' ');
  out.text = typeof msg.text === 'string' ? msg.text : '';
  out.ts = new Date(msg.date ? msg.date * 1000 : Date.now()).toISOString();
  out.id = makeId(out.platform, out.chatId, out.ts, out.text);
  return out;
}

function normalizeViber(payload, receivedAt) {
  if (!payload || payload.event !== 'message' || !payload.message) return null;
  const out = base(receivedAt);
  out.platform = 'viber';
  out.chatId = String(payload.sender && payload.sender.id);
  out.senderId = String(payload.sender && payload.sender.id);
  out.senderName = (payload.sender && payload.sender.name) || '';
  out.text = typeof payload.message.text === 'string' ? payload.message.text : '';
  out.ts = payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
  out.id = makeId(out.platform, out.chatId, out.ts, out.text);
  return out;
}

function normalizeWhatsApp(payload, receivedAt) {
  const entries =
    payload.entry &&
    payload.entry.flatMap((e) => (e.changes || []).map((c) => c.value)).filter(Boolean);
  const value = entries && entries[0];
  const msg = value && value.messages && value.messages[0];
  if (!msg) return null;
  const out = base(receivedAt);
  out.platform = 'whatsapp';
  out.chatId = String(msg.from);
  out.senderId = String(msg.from);
  out.senderName = (value.contacts && value.contacts[0] && value.contacts[0].profile) ?
    value.contacts[0].profile.name || '' : '';
  out.text = msg.text && typeof msg.text.body === 'string' ? msg.text.body : '';
  out.ts = new Date(Number(msg.timestamp) * 1000 || Date.now()).toISOString();
  out.id = makeId(out.platform, out.chatId, out.ts, out.text);
  return out;
}

/**
 * Normalize a platform webhook body into the canonical schema.
 * Returns null for events that carry no user message (receipts, pokes).
 * Throws for unknown platforms.
 */
function normalize(platform, payload, receivedAt = new Date().toISOString()) {
  if (!PLATFORMS.has(platform)) throw new Error(`unknown platform: ${platform}`);
  let msg = null;
  if (platform === 'telegram') msg = normalizeTelegram(payload, receivedAt);
  else if (platform === 'viber') msg = normalizeViber(payload, receivedAt);
  else msg = normalizeWhatsApp(payload, receivedAt);
  return msg;
}

/** WhatsApp webhook verification handshake (GET). Returns challenge or null. */
function whatsappVerifyChallenge(query, expected = process.env.WHATSAPP_VERIFY_TOKEN || '') {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return challenge;
  }
  return null;
}

module.exports = { normalize, PLATFORMS, whatsappVerifyChallenge, makeId };
