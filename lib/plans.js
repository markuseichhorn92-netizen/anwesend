'use strict';

/**
 * Fit-Inn Trier · „Vormerken" – geplante Trainingszeit (heute)
 * -----------------------------------------------------------
 * Mitglieder merken sich eine Ankunftszeit für HEUTE vor (30-Minuten-Slots).
 * Daraus entsteht eine anonyme, aggregierte Vorschau der geplanten Auslastung
 * sowie persönliche E-Mails (Bestätigung + Erinnerung).
 *
 * Speicher: Upstash Redis (REST) über redisPipeline aus store.js — kein SDK.
 *   plan:cnt:<YYYY-MM-DD>  Hash  { slotMinuten -> anzahl }   (NUR Zahlen, öffentlich)
 *   plan:by:<YYYY-MM-DD>   Hash  { memberId -> JSON{slot,email,firstName,remind} } (intern)
 *   plan:rem:<YYYY-MM-DD>  Set   bereits erinnerte memberIds (Doppel-Mails vermeiden)
 * Slot = Minuten des Tages (Vielfaches von 30), z. B. 750 = 12:30.
 * Vergangene Slots laufen am Slot-Ende ab (Slot 12:30 -> ab 13:00 unsichtbar).
 * Alle Keys mit TTL bis Tagesende (Berlin). Personenbezug bleibt serverseitig.
 */

const crypto = require('crypto');
const { redisPipeline, hasStore, TZ } = require('./store');

const TZONE = TZ || 'Europe/Berlin';
const MIN_HOUR = parseInt(process.env.PLAN_MIN_HOUR || '5', 10);
const MAX_HOUR = parseInt(process.env.PLAN_MAX_HOUR || '23', 10);
const REMIND_LEAD_MIN = parseInt(process.env.PLAN_REMIND_LEAD_MIN || '75', 10); // Fenster vor dem Slot
const EXPIRE_GRACE_MIN = parseInt(process.env.PLAN_EXPIRE_GRACE_MIN || '30', 10); // Ende des 30-Min-Slots
const SLOT_MIN = 30;
const CANCEL_SECRET = process.env.PLAN_CANCEL_SECRET || process.env.RECORD_SECRET || 'fitinn-plan-cancel';

// Lokale (Berlin-)Bestandteile: Datum YYYY-MM-DD + Stunde/Minute, DST-sicher.
function parts(date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date || new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return {
    date: g('year') + '-' + g('month') + '-' + g('day'),
    hour: parseInt(g('hour'), 10),
    minute: parseInt(g('minute'), 10),
  };
}

function ttlEndOfDay(pn, extraDays) {
  const secNow = pn.hour * 3600 + pn.minute * 60;
  // bis Mitternacht (+ optionale Folgetage, z. B. Vormerkung für morgen) + 3 Min Puffer
  return Math.max(120, (1 + (extraDays || 0)) * 24 * 3600 - secNow + 180);
}

// Berlin-Datumsteile für „heute + offset Tage" (offset 0 = heute, 1 = morgen).
function partsForOffset(offset, now) {
  const base = now || new Date();
  const off = parseInt(offset, 10) || 0;
  return off ? parts(new Date(base.getTime() + off * 86400000)) : parts(base);
}

function hashToMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) {
    const m = {};
    for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1];
    return m;
  }
  if (typeof v === 'object') return v;
  return {};
}

// Slot (Minuten des Tages) validieren: Vielfaches von 30 innerhalb der erlaubten Stunden.
function normSlot(m) {
  const n = parseInt(m, 10);
  if (!Number.isFinite(n) || n % SLOT_MIN !== 0) return null;
  if (n < MIN_HOUR * 60 || n > MAX_HOUR * 60 + SLOT_MIN) return null;
  return n;
}
// Rückwärtskompatibel: alte Records/Counts mit Stunde -> Minuten umrechnen.
function recSlot(o) {
  if (o == null) return null;
  if (o.slot != null) return normSlot(o.slot);
  if (o.hour != null) { const h = parseInt(o.hour, 10); return Number.isFinite(h) ? h * 60 : null; }
  return null;
}
function keySlot(k) {
  const n = parseInt(k, 10);
  if (!Number.isFinite(n)) return null;
  return n < 48 ? n * 60 : n;   // <48 = alter Stunden-Key, sonst Minuten
}
function slotActive(slot, nowMin) { return nowMin < slot + EXPIRE_GRACE_MIN; }

const K = {
  cnt: (d) => 'plan:cnt:' + d,
  by: (d) => 'plan:by:' + d,
  rem: (d) => 'plan:rem:' + d,
};

// Vormerkung setzen/ändern. Ein Eintrag pro Mitglied/Tag; Zähler wird angepasst.
// opts.dayOffset: 0 = heute (Standard), 1 = morgen (z. B. abends nach Ladenschluss).
async function setPlan(memberId, minutes, opts, now) {
  if (!hasStore) return { ok: false, error: 'no_store' };
  opts = opts || {};
  const slot = normSlot(minutes);
  if (slot === null) return { ok: false, error: 'bad_slot' };
  const offset = (parseInt(opts.dayOffset, 10) === 1) ? 1 : 0;
  const pnNow = parts(now);                                  // aktuelle Berlin-Zeit (heute)
  const nowMin = pnNow.hour * 60 + pnNow.minute;
  if (offset === 0 && slot < nowMin) return { ok: false, error: 'past' }; // keine vergangene Zeit heute
  const target = offset ? partsForOffset(offset, now) : pnNow;
  const date = target.date, ttl = String(ttlEndOfDay(pnNow, offset)), mid = String(memberId);
  const remind = opts.remind !== false;

  const [oldRaw] = await redisPipeline([['HGET', K.by(date), mid]]);
  let oldSlot = null;
  if (oldRaw) { try { oldSlot = recSlot(JSON.parse(oldRaw)); } catch (e) {} }

  const rec = JSON.stringify({ slot: slot, email: opts.email || '', firstName: opts.firstName || '', remind: remind });
  const cmds = [];
  if (oldSlot !== null && oldSlot !== slot) cmds.push(['HINCRBY', K.cnt(date), String(oldSlot), '-1']);
  if (oldSlot !== slot) cmds.push(['HINCRBY', K.cnt(date), String(slot), '1']);
  cmds.push(['HSET', K.by(date), mid, rec]);
  cmds.push(['EXPIRE', K.cnt(date), ttl]);
  cmds.push(['EXPIRE', K.by(date), ttl]);
  if (oldSlot !== slot) cmds.push(['SREM', K.rem(date), mid]); // bei Zeitwechsel neue Erinnerung zulassen
  await redisPipeline(cmds);
  return { ok: true, plan: { date: date, slot: slot, remind: remind, dayOffset: offset } };
}

// Internes Stornieren für ein bestimmtes Datum (heute, oder per Token).
async function cancelForDate(memberId, date) {
  const mid = String(memberId);
  const [oldRaw] = await redisPipeline([['HGET', K.by(date), mid]]);
  if (!oldRaw) return { ok: true, plan: null, slot: null };
  let oldSlot = null; try { oldSlot = recSlot(JSON.parse(oldRaw)); } catch (e) {}
  const cmds = [['HDEL', K.by(date), mid], ['SREM', K.rem(date), mid]];
  if (oldSlot !== null) cmds.push(['HINCRBY', K.cnt(date), String(oldSlot), '-1']);
  await redisPipeline(cmds);
  return { ok: true, plan: null, slot: oldSlot };
}

async function cancelPlan(memberId, now, dayOffset) {
  if (!hasStore) return { ok: false, error: 'no_store' };
  const offset = (parseInt(dayOffset, 10) === 1) ? 1 : 0;
  return cancelForDate(memberId, partsForOffset(offset, now).date);
}

// Aktive Vormerkung: zuerst heute (falls noch nicht abgelaufen), sonst morgen
// (z. B. abends nach Ladenschluss bereits für den nächsten Tag vorgemerkt).
async function getMyPlan(memberId, now) {
  if (!hasStore) return null;
  const base = now || new Date();
  const pn = parts(base), nowMin = pn.hour * 60 + pn.minute, mid = String(memberId);
  const [rawT] = await redisPipeline([['HGET', K.by(pn.date), mid]]);
  if (rawT) {
    try {
      const o = JSON.parse(rawT), slot = recSlot(o);
      if (slot !== null && slotActive(slot, nowMin)) return { slot: slot, remind: o.remind !== false, date: pn.date, dayOffset: 0 };
    } catch (e) {}
  }
  const tom = partsForOffset(1, base);
  const [rawM] = await redisPipeline([['HGET', K.by(tom.date), mid]]);
  if (rawM) {
    try {
      const o = JSON.parse(rawM), slot = recSlot(o);
      if (slot !== null) return { slot: slot, remind: o.remind !== false, date: tom.date, dayOffset: 1 };
    } catch (e) {}
  }
  return null;
}

// Öffentliche, anonyme Aggregation: pro Stunde summiert (+ pro Slot).
// dayOffset 0 = heute (abgelaufene Slots werden ausgeblendet), 1 = morgen (alle Slots).
async function getAggregate(now, dayOffset) {
  if (!hasStore) return { available: false };
  const offset = (parseInt(dayOffset, 10) === 1) ? 1 : 0;
  const base = now || new Date();
  const pn = parts(base), nowMin = pn.hour * 60 + pn.minute;
  const target = offset ? partsForOffset(offset, base) : pn;
  const [flat] = await redisPipeline([['HGETALL', K.cnt(target.date)]]);
  const m = hashToMap(flat);
  const hours = {}, slots = {}; let total = 0;
  Object.keys(m).forEach((k) => {
    const slot = keySlot(k), c = parseInt(m[k], 10);
    if (slot === null || !Number.isFinite(c) || c <= 0) return;
    if (offset === 0 && !slotActive(slot, nowMin)) return; // heute: abgelaufen -> nicht mehr anzeigen
    const h = Math.floor(slot / 60);
    hours[h] = (hours[h] || 0) + c;
    slots[slot] = (slots[slot] || 0) + c;
    total += c;
  });
  return { available: true, date: target.date, dayOffset: offset, hours: hours, slots: slots, total: total };
}

// Fällige Erinnerungen: remind=true, E-Mail vorhanden, Slot startet in 0..LEAD Min, nicht erinnert.
async function dueReminders(now) {
  if (!hasStore) return [];
  const pn = parts(now), date = pn.date;
  const [byFlat, remArr] = await redisPipeline([['HGETALL', K.by(date)], ['SMEMBERS', K.rem(date)]]);
  const by = hashToMap(byFlat);
  const reminded = new Set((Array.isArray(remArr) ? remArr : []).map(String));
  const nowMin = pn.hour * 60 + pn.minute;
  const due = [];
  Object.keys(by).forEach((mid) => {
    if (reminded.has(String(mid))) return;
    let o; try { o = JSON.parse(by[mid]); } catch (e) { return; }
    if (!o || o.remind === false || !o.email) return;
    const slot = recSlot(o); if (slot === null) return;
    const until = slot - nowMin;
    if (until >= 0 && until <= REMIND_LEAD_MIN) {
      due.push({ memberId: String(mid), email: o.email, firstName: o.firstName || '', slot: slot, date: date });
    }
  });
  return due;
}

async function markReminded(memberId, now) {
  if (!hasStore) return;
  const pn = parts(now), date = pn.date;
  await redisPipeline([
    ['SADD', K.rem(date), String(memberId)],
    ['EXPIRE', K.rem(date), String(ttlEndOfDay(pn))],
  ]);
}

// ── Storno-Token (stateless, HMAC) für den E-Mail-Link ──
function sign(mid, date) {
  return crypto.createHmac('sha256', CANCEL_SECRET).update(mid + ':' + date).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}
function cancelToken(memberId, date) {
  const mid = String(memberId);
  return mid + '.' + date + '.' + sign(mid, date);
}
function verifyCancelToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts2 = token.split('.');
  if (parts2.length !== 3) return null;
  const mid = parts2[0], date = parts2[1], sig = parts2[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let ok = false;
  try {
    const a = Buffer.from(sig), b = Buffer.from(sign(mid, date));
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { ok = false; }
  return ok ? { memberId: mid, date: date } : null;
}

// Aktuelle Vormerkung zu einem Token lesen (für die Storno-Bestätigungsseite).
async function getPlanForToken(token) {
  if (!hasStore) return null;
  const v = verifyCancelToken(token); if (!v) return null;
  const [raw] = await redisPipeline([['HGET', K.by(v.date), v.memberId]]);
  if (!raw) return { memberId: v.memberId, date: v.date, slot: null };
  let slot = null; try { slot = recSlot(JSON.parse(raw)); } catch (e) {}
  return { memberId: v.memberId, date: v.date, slot: slot };
}

// Stornieren per Token (für den E-Mail-Link).
async function cancelByToken(token) {
  if (!hasStore) return { ok: false, error: 'no_store' };
  const v = verifyCancelToken(token); if (!v) return { ok: false, error: 'invalid_token' };
  const r = await cancelForDate(v.memberId, v.date);
  return { ok: true, slot: r.slot, date: v.date };
}

module.exports = {
  setPlan, cancelPlan, getMyPlan, getAggregate, dueReminders, markReminded,
  cancelToken, verifyCancelToken, getPlanForToken, cancelByToken,
  parts, hasStore, MIN_HOUR, MAX_HOUR, SLOT_MIN, EXPIRE_GRACE_MIN,
};
