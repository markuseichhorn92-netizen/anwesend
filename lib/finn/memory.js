'use strict';

/**
 * FINN – Konversationsgedächtnis (kurzfristig, je Konversation).
 * -----------------------------------------------------------------------------
 * Hält NUR Steuerzustand über mehrere Nachrichten hinweg: zuletzt aktiver Agent,
 * offener Bestätigungsvorschlag, Themen, Zähler. KEINE Nachrichtentexte, keine
 * Gesundheitsdaten – der Verlauf selbst bleibt beim Kanal (App: Client;
 * WhatsApp: Vorgang im Postfach). 12 Stunden TTL.
 *
 * Langzeit-Fakten (Opt-in) laufen unverändert über lib/finnMemory.js.
 *
 * Key: finnconv:<channel>:<conversationId>
 */

const KV = require('./kv');
const TTL = 12 * 3600;

const K = (ch, id) => 'finnconv:' + String(ch || 'web') + ':' + String(id);

async function get(channel, id) {
  if (id == null) return { agent: null, pending: null, topics: [], turns: 0 };
  const v = await KV.getJSON(K(channel, id));
  return v && typeof v === 'object' ? Object.assign({ agent: null, pending: null, topics: [], turns: 0 }, v) : { agent: null, pending: null, topics: [], turns: 0 };
}
async function set(channel, id, patch) {
  if (id == null) return null;
  const cur = await get(channel, id);
  const next = Object.assign(cur, patch || {}, { at: Date.now() });
  if (Array.isArray(next.topics)) next.topics = next.topics.slice(-8);
  await KV.set(K(channel, id), next, TTL);
  return next;
}
async function clear(channel, id) { if (id != null) await KV.del(K(channel, id)); }

module.exports = { get, set, clear, TTL };
