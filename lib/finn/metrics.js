'use strict';

/**
 * FINN – Observability (nicht personenbezogen).
 * -----------------------------------------------------------------------------
 * Zähler laufen über lib/opsStat (Tageswerte, 35 Tage, sichtbar unter /api/ops
 * als `counters`) und zusätzlich als FINN-Snapshot im KV (finnmx:*), damit das
 * Team-Backend Latenzen und Fehlerklassen sieht. Namen: finn.turn, finn.agent.<x>,
 * finn.tool.<name>.<status>, finn.confirm.<proposed|confirmed|declined|expired>,
 * finn.handoff, finn.error.<code>, finn.route.<agent>.
 * Latenz: Buckets (<1s, <3s, <8s, <20s, >=20s) je Kanal.
 */

const KV = require('./kv');
const TTL = 35 * 86400;

async function bump(name, n) {
  try { await require('../opsStat').bump(name, n); } catch (e) {}
  try { await KV.incr('finnmx:c:' + safe(name), TTL); } catch (e) {}
}
function safe(s) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 60); }
function bucket(ms) { return ms < 1000 ? 'lt1s' : ms < 3000 ? 'lt3s' : ms < 8000 ? 'lt8s' : ms < 20000 ? 'lt20s' : 'ge20s'; }
async function latency(channel, ms) {
  await bump('finn.lat.' + safe(channel || 'web') + '.' + bucket(ms));
}
async function read() {
  const names = ['finn.turn', 'finn.handoff', 'finn.blocked', 'finn.confirm.proposed', 'finn.confirm.confirmed', 'finn.confirm.declined', 'finn.confirm.expired', 'finn.error.ai', 'finn.error.tool',
    'finn.lat.web.lt1s', 'finn.lat.web.lt3s', 'finn.lat.web.lt8s', 'finn.lat.web.lt20s', 'finn.lat.web.ge20s',
    'finn.lat.whatsapp.lt1s', 'finn.lat.whatsapp.lt3s', 'finn.lat.whatsapp.lt8s', 'finn.lat.whatsapp.lt20s', 'finn.lat.whatsapp.ge20s'];
  const out = {};
  for (const n of names) out[n] = Number(await KV.get('finnmx:c:' + safe(n))) || 0;
  return out;
}

module.exports = { bump, latency, read, bucket };
