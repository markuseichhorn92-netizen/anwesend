'use strict';

/**
 * FINN Journeys – Einstiegspunkt für Webhooks, Buchungswege und Endpunkte.
 * Lädt die Teilmodule erst bei Bedarf, damit die Webhooks schlank bleiben.
 * Siehe docs/finn/journeys.md.
 */

const KV = require('../finn/kv');

// Doppelte Zustellung desselben WhatsApp-Webhooks (Retry des Anbieters) erkennen.
// true = zum ersten Mal gesehen. Ohne Id/Speicher nie blockieren.
async function firstDelivery(msgId) {
  if (!msgId) return true;
  const r = await KV.set('wa:wh:' + String(msgId).slice(0, 80), '1', 3600, { nx: true });
  return r !== false;
}

// Für den Push-Anstoß (lib/nudge.js): wurde die Person in den letzten `days` Tagen per
// WhatsApp motiviert, oder läuft gerade ein Comeback? Dann keinen zusätzlichen Push –
// niemand soll von zwei Kanälen gleichzeitig angestoßen werden.
async function recentlyContacted(cid, days) {
  if (process.env.JOURNEYS !== '1' || !/^[0-9]{1,12}$/.test(String(cid || ''))) return false;
  const st = await KV.getJSON('jr:st:' + cid);
  if (!st) return false;
  const since = Date.now() - (days || 7) * 86400000;
  if ((st.sent || []).some((x) => x && x.at > since && x.via !== 'dry' && x.cat !== 'service')) return true;
  const cb = st.runs && st.runs.comeback;
  return !!(cb && !cb.exit);
}

module.exports = {
  firstDelivery,
  recentlyContacted,
  onInbound: (o) => require('./inbound').onInbound(o),
  onStatus: (id, status, code) => require('./status').onStatus(id, status, code),
  onTrialBooked: (o) => require('./hooks').onTrialBooked(o),
  leadTurn: (o) => require('./leadchat').leadTurn(o),
  isLeadConversation: (phone) => require('./leadchat').isLeadConversation(phone),
  onLeadContact: (o) => require('./hooks').onLeadContact(o),
  createCode: (cid, types, ttl, src) => require('./inbound').createCode(cid, types, ttl, src),
  waLink: (code) => require('./inbound').waLink(code),
  tick: (opts) => require('./tick').run(opts),
  erase: (cid) => require('./store').erase(cid),
  config: () => require('./config'),
};
