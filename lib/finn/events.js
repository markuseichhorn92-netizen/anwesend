'use strict';

/**
 * FINN – Event Bus mit Idempotenz (um den bestehenden Webhook-Handler).
 * -----------------------------------------------------------------------------
 * ingest(event, type)  -> { id, dedup:'id'|'hash'|'none', dup:boolean, corrupt:boolean, type, cid }
 *   • Kennung: event.id / eventId / uuid / messageId (dedup:'id'); sonst
 *     sha1(type + entityId + timestamp) (dedup:'hash'); fehlt jedes zeitliche
 *     Merkmal, wird NICHT dedupliziert (dedup:'none') – zwei echte Check-ins
 *     derselben Person dürfen nicht verschluckt werden.
 *   • Duplikat = `SET finnev:seen:<id> NX` schlägt fehl (7 Tage).
 *   • corrupt = kein Typ oder kein Objekt.
 * finish(rec, action)  -> protokolliert { id, type, cid, at, action, dup } in finnev:log (500)
 *                          und zählt finnev:stat:<action-klasse>.
 * on(type, handler) / emit(rec, event) -> Automationen (lib/finn/automations.js);
 *   ein Fehler dort ändert nichts am Ergebnis der Bestandsverarbeitung.
 * stats() -> { seen, duplicates, unknown, corrupt, errors, last:[…] } für ?health=1.
 *
 * Ohne KV: kein Dedup, kein Log – die Verarbeitung läuft wie bisher.
 */

const KV = require('./kv');
const U = require('./util');

const SEEN_TTL = 7 * 86400, LOG_CAP = 500, LOG_TTL = 30 * 86400;
const handlers = {};   // type -> [fn]

function eventIdOf(e) {
  const v = e && (e.id || e.eventId || e.uuid || e.messageId || e.notificationId);
  return v != null && String(v).length >= 4 ? String(v).slice(0, 80) : null;
}
function timeOf(e) {
  const p = (e && (e.content || e.payload || e.data)) || {};
  return e && (e.timestamp || e.createdAt || e.occurredAt || e.time || e.eventTime || p.timestamp || p.checkinDateTime || p.dateTime || p.startDateTime) || null;
}
// Kunden-Id: bei Termin-Events ist entityId die BUCHUNGS-Id – dort zählt nur content.customerId.
function customerIdOf(e, type) {
  if (!e) return null;
  const p = e.content || e.payload || e.data || {};
  const appt = /^APPOINTMENT_/.test(String(type || '').toUpperCase());
  const c = (appt ? null : e.entityId) || e.customerId || p.customerId || (p.customer && p.customer.id) || null;
  return c != null ? String(c) : null;
}

async function ingest(e, type) {
  const T = String(type || '').toUpperCase();
  const rec = { id: null, dedup: 'none', dup: false, corrupt: false, type: T, cid: customerIdOf(e, T), entityId: e && e.entityId != null ? String(e.entityId) : null, at: Date.now() };
  if (!e || typeof e !== 'object' || !rec.type) { rec.corrupt = true; return rec; }
  const eid = eventIdOf(e);
  if (eid) { rec.id = 'e:' + eid; rec.dedup = 'id'; }
  else {
    const t = timeOf(e);
    if (t) { rec.id = 'h:' + U.sha1(rec.type + '|' + (e.entityId != null ? e.entityId : '') + '|' + String(t)); rec.dedup = 'hash'; }
  }
  if (rec.id && KV.available()) {
    const fresh = await KV.set('finnev:seen:' + rec.id, String(rec.at), SEEN_TTL, { nx: true });
    if (fresh === false) rec.dup = true;
  }
  return rec;
}

function klass(rec, action) {
  if (rec.dup) return 'duplicate';
  if (rec.corrupt) return 'corrupt';
  if (action === 'error') return 'error';
  if (action === 'ignored') return 'unknown';
  return 'handled';
}

async function finish(rec, action) {
  const k = klass(rec, action);
  try {
    await KV.lpush('finnev:log', { id: rec.id, type: rec.type || null, cid: rec.cid, at: rec.at, action: action, klass: k, dedup: rec.dedup }, LOG_CAP, LOG_TTL);
    await KV.incr('finnev:stat:' + k, LOG_TTL);
    await KV.incr('finnev:stat:seen', LOG_TTL);
  } catch (e) {}
  return k;
}

function on(type, fn) { const t = String(type).toUpperCase(); (handlers[t] = handlers[t] || []).push(fn); }
function off(type) { delete handlers[String(type).toUpperCase()]; }
async function emit(rec, e) {
  const list = (handlers[rec.type] || []).concat(handlers['*'] || []);
  const out = [];
  for (const fn of list) { try { out.push(await fn(rec, e)); } catch (err) { out.push({ error: true }); await KV.incr('finnev:stat:automation_error', LOG_TTL); } }
  return out;
}

async function stats(n) {
  const out = { seen: 0, handled: 0, duplicate: 0, unknown: 0, corrupt: 0, error: 0, automation_error: 0, last: [] };
  for (const k of Object.keys(out)) { if (k !== 'last') out[k] = Number(await KV.get('finnev:stat:' + k)) || 0; }
  out.last = (await KV.lrangeJSON('finnev:log', 0, Math.max(1, Math.min(100, n || 20)) - 1)).map((r) => ({ type: r.type, action: r.action, klass: r.klass, at: r.at, dedup: r.dedup }));
  out.mode = KV.mode();
  return out;
}
async function log(n) { return KV.lrangeJSON('finnev:log', 0, Math.max(1, Math.min(500, n || 100)) - 1); }

function _reset() { Object.keys(handlers).forEach((k) => delete handlers[k]); }

module.exports = { ingest, finish, on, off, emit, stats, log, eventIdOf, timeOf, customerIdOf, _reset };
