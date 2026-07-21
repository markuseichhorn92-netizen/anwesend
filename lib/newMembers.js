'use strict';

/**
 * Neue Mitglieder: merkt sich Beitritte (aus dem Magicline-Webhook CONTRACT_CREATED),
 * damit das Team-Backend eine „Zuletzt beigetreten"-Liste anzeigen kann (Begrüßung/
 * Onboarding vor Ort). Bewusst datensparsam: gespeichert wird nur die Kunden-ID +
 * Zeitpunkt; Name/Nummer holt das Team-Backend erst beim Anzeigen frisch aus Magicline.
 *
 * Speicher: Redis-Liste `newmembers:recent` (neueste zuerst), gekappt + TTL.
 * No-Op ohne KV-Store; wirft nie.
 */

const { redisPipeline, hasStore } = require('./store');

const KEY = 'newmembers:recent';
const CAP = 60;                    // maximal so viele Einträge vorhalten
const TTL = 120 * 24 * 3600;       // ~120 Tage

async function recordJoin(id, extra) {
  if (!hasStore || id == null) return { ok: false };
  const rec = JSON.stringify(Object.assign({ id: String(id), joinedAt: new Date().toISOString() }, extra || {}));
  try {
    await redisPipeline([['LPUSH', KEY, rec], ['LTRIM', KEY, '0', String(CAP - 1)], ['EXPIRE', KEY, String(TTL)]]);
    return { ok: true };
  } catch (e) { return { ok: false }; }
}

// Neueste Beitritte (dedupliziert nach Kunden-ID – bei doppeltem Event bleibt der jüngste).
async function listJoins(limit) {
  if (!hasStore) return [];
  const n = Math.max(1, Math.min(CAP, limit || CAP));
  let raw = [];
  try { const [r] = await redisPipeline([['LRANGE', KEY, '0', String(CAP - 1)]]); raw = Array.isArray(r) ? r : []; }
  catch (e) { return []; }
  const out = [], seen = new Set();
  for (const s of raw) {
    try { const o = JSON.parse(s); if (o && o.id && !seen.has(o.id)) { seen.add(o.id); out.push(o); } } catch (e) {}
    if (out.length >= n) break;
  }
  return out;   // neueste zuerst
}

module.exports = { recordJoin, listJoins, KEY, CAP, TTL };
