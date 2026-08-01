'use strict';

/**
 * Magicline-Webhook-EVENTS -> lokaler Live-Feed (Upstash KV).
 * -----------------------------------------------------------------------------
 * Die Magicline Open API kennt keinen zuverlässigen studioweiten Termin- oder
 * Check-in-Abruf. Über die neu aktivierten Webhooks (APPOINTMENT_BOOKING_*,
 * CUSTOMER_CHECKIN) bauen wir den Live-Feed selbst auf: jedes Event aktualisiert
 * einen kleinen KV-Store, aus dem das Team-Backend liest. Datensparsam: nur
 * Termin-Eckdaten bzw. Check-in-Zeit + optional Anzeigename; keine sensiblen Daten.
 *
 * Keys (Präfix mlx):
 *   mlx:appt:<bookingId>     JSON eines Termins (Titel, Start, Ende, customerId)
 *   mlx:apptday:<YYYY-MM-DD> SET der bookingIds des Tages (Wochen-Query = 7 Lookups)
 *   mlx:ci:recent            LIST der letzten Check-ins (LPUSH + LTRIM), neueste zuerst
 *   mlx:present:<YYYY-MM-DD>  SET der heute anwesenden customerIds (Live-Zähler)
 *
 * Grundsatz wie im Bestand: wirft NIE. Ohne Store -> keine Persistenz.
 */

const { redisPipeline, hasStore } = require('./store');

const APPT = (id) => 'mlx:appt:' + id;
const APPTDAY = (d) => 'mlx:apptday:' + d;
const CI_RECENT = 'mlx:ci:recent';
const PRESENT = (d) => 'mlx:present:' + d;

const APPT_TTL = 60 * 60 * 24 * 90;   // 90 Tage
const PRESENT_TTL = 60 * 60 * 36;     // 1,5 Tage (heutige Anwesenheit)
const CI_CAP = 120;                    // so viele letzte Check-ins halten wir

function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 80); }
function dayOf(iso) { const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }

// ── Termine (studioweiter Feed) ──
async function getAppointment(bookingId) {
  const id = str(bookingId, 60); if (!hasStore || !id) return null;
  try { const [s] = await redisPipeline([['GET', APPT(id)]]); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

// Termin anlegen/aktualisieren. a = { bookingId, title, start, end, customerId, memberName }.
// Verschiebt sich der Tag, wird der alte Tages-Index mitgepflegt.
async function upsertAppointment(a) {
  a = a || {};
  const id = str(a.bookingId, 60);
  const start = str(a.start, 40);
  if (!hasStore || !id || !start) return false;
  const day = dayOf(start); if (!day) return false;
  const appt = {
    bookingId: id, title: str(a.title, 80) || 'Termin', start: start, end: str(a.end, 40) || null,
    customerId: a.customerId != null ? str(a.customerId, 40) : null, memberName: str(a.memberName, 80) || null,
    updatedAt: Date.now(),
  };
  try {
    const prev = await getAppointment(id);
    const cmds = [['SET', APPT(id), JSON.stringify(appt), 'EX', String(APPT_TTL)], ['SADD', APPTDAY(day), id], ['EXPIRE', APPTDAY(day), String(APPT_TTL)]];
    if (prev && prev.start) { const pd = dayOf(prev.start); if (pd && pd !== day) cmds.push(['SREM', APPTDAY(pd), id]); }
    await redisPipeline(cmds);
    return true;
  } catch (e) { return false; }
}

async function removeAppointment(bookingId) {
  const id = str(bookingId, 60); if (!hasStore || !id) return false;
  try {
    const prev = await getAppointment(id);
    const cmds = [['DEL', APPT(id)]];
    if (prev && prev.start) { const pd = dayOf(prev.start); if (pd) cmds.push(['SREM', APPTDAY(pd), id]); }
    await redisPipeline(cmds);
    return true;
  } catch (e) { return false; }
}

// Termine im Zeitraum [fromISO, toISO] (inklusive Tage). Neueste-Start zuerst? Nein –
// chronologisch aufsteigend, gekappt. Wirft nie.
async function listAppointments(fromISO, toISO) {
  if (!hasStore) return [];
  const fromD = dayOf(fromISO) || dayOf(new Date().toISOString());
  const toD = dayOf(toISO) || fromD;
  if (!fromD || !toD) return [];
  const days = [];
  let cur = fromD;
  for (let i = 0; i < 31 && cur <= toD; i++) { days.push(cur); cur = nextDay(cur); }
  let idsPer;
  try { idsPer = await redisPipeline(days.map((d) => ['SMEMBERS', APPTDAY(d)])); } catch (e) { return []; }
  const ids = [];
  (idsPer || []).forEach((set) => { (Array.isArray(set) ? set : []).forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); }); });
  if (!ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', APPT(id)])); } catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { const a = JSON.parse(s); if (a && a.start) out.push(a); } catch (e) {} } });
  out.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  return out.slice(0, 300);
}

function nextDay(d) {
  const p = d.split('-'); const dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

// ── Check-ins (Live-Feed „wer ist gerade da") ──
async function recordCheckin(o) {
  o = o || {};
  const cid = str(o.customerId, 40);
  if (!hasStore || !cid) return false;
  const day = dayOf(o.at || new Date().toISOString()) || dayOf(new Date().toISOString());
  const entry = { customerId: cid, name: str(o.memberName, 80) || null, at: Number(o.atMs) || Date.now() };
  try {
    await redisPipeline([
      ['LPUSH', CI_RECENT, JSON.stringify(entry)],
      ['LTRIM', CI_RECENT, '0', String(CI_CAP - 1)],
      ['SADD', PRESENT(day), cid],
      ['EXPIRE', PRESENT(day), String(PRESENT_TTL)],
    ]);
    return true;
  } catch (e) { return false; }
}

async function recentCheckins(limit) {
  if (!hasStore) return [];
  const n = Math.max(1, Math.min(CI_CAP, parseInt(limit, 10) || 30));
  try {
    const [arr] = await redisPipeline([['LRANGE', CI_RECENT, '0', String(n - 1)]]);
    return (Array.isArray(arr) ? arr : []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

async function presentCount(dayISO) {
  if (!hasStore) return 0;
  const day = dayOf(dayISO || new Date().toISOString());
  if (!day) return 0;
  try { const [n] = await redisPipeline([['SCARD', PRESENT(day)]]); return Number(n) || 0; } catch (e) { return 0; }
}

module.exports = {
  upsertAppointment, removeAppointment, listAppointments, getAppointment,
  recordCheckin, recentCheckins, presentCount,
  hasStore,
};
