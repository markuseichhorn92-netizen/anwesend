'use strict';

/**
 * FINN – Agenten-/CRM-Timeline je Kunde.
 * -----------------------------------------------------------------------------
 * Was hat FINN (oder ein Webhook) für diese Person getan? Für das Team-Backend
 * (Profil → „FINN-Verlauf") und für den Kontext eines Handoffs.
 * Einträge: { at, kind, title, detail?, agent?, source:'agent'|'webhook'|'automation'|'team', ref? }
 * Kein Nachrichtenfreitext des Kunden, keine Gesundheitsdaten – nur Ereignisse.
 *
 * Key: finntl:<customerId> (LIST, 150, 1 Jahr)
 */

const KV = require('./kv');
const CAP = 150, TTL = 365 * 86400;

async function add(customerId, e) {
  if (customerId == null || !e) return null;
  const rec = {
    at: Date.now(), kind: String(e.kind || 'note').slice(0, 40), title: String(e.title || '').slice(0, 120),
    source: String(e.source || 'agent').slice(0, 20),
  };
  if (e.detail) rec.detail = String(e.detail).slice(0, 240);
  if (e.agent) rec.agent = String(e.agent).slice(0, 40);
  if (e.ref) rec.ref = String(e.ref).slice(0, 40);
  if (e.traceId) rec.traceId = String(e.traceId).slice(0, 40);
  try { await KV.lpush('finntl:' + String(customerId), rec, CAP, TTL); } catch (err) {}
  return rec;
}
async function list(customerId, limit) {
  if (customerId == null) return [];
  return KV.lrangeJSON('finntl:' + String(customerId), 0, Math.max(1, Math.min(CAP, limit || 50)) - 1);
}

module.exports = { add, list };
