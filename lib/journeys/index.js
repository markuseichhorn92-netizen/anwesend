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

module.exports = {
  firstDelivery,
  onInbound: (o) => require('./inbound').onInbound(o),
  onStatus: (id, status, code) => require('./status').onStatus(id, status, code),
  onTrialBooked: (o) => require('./hooks').onTrialBooked(o),
  onLeadContact: (o) => require('./hooks').onLeadContact(o),
  createCode: (cid, types, ttl, src) => require('./inbound').createCode(cid, types, ttl, src),
  waLink: (code) => require('./inbound').waLink(code),
  tick: (opts) => require('./tick').run(opts),
  erase: (cid) => require('./store').erase(cid),
  config: () => require('./config'),
};
