'use strict';

/**
 * Fit-Inn Trier · „Vormerken" – geplante Trainingszeit (heute)
 * -----------------------------------------------------------
 * Mitglieder merken sich eine Ankunftsstunde für HEUTE vor. Daraus entsteht
 * eine anonyme, aggregierte Vorschau der geplanten Auslastung sowie eine
 * persönliche E-Mail-Erinnerung kurz vorher.
 *
 * Speicher: Upstash Redis (REST) über redisPipeline aus store.js — kein SDK.
 *   plan:cnt:<YYYY-MM-DD>  Hash  { stunde -> anzahl }   (NUR Zahlen, öffentlich)
 *   plan:by:<YYYY-MM-DD>   Hash  { memberId -> JSON{hour,email,firstName,remind} } (intern)
 *   plan:rem:<YYYY-MM-DD>  Set   bereits erinnerte memberIds (Doppel-Mails vermeiden)
 * Alle Keys mit TTL bis Tagesende (Berlin). Personenbezug bleibt serverseitig.
 */

const { redisPipeline, hasStore, TZ } = require('./store');

const TZONE = TZ || 'Europe/Berlin';
const MIN_HOUR = parseInt(process.env.PLAN_MIN_HOUR || '5', 10);
const MAX_HOUR = parseInt(process.env.PLAN_MAX_HOUR || '23', 10);
const REMIND_LEAD_MIN = parseInt(process.env.PLAN_REMIND_LEAD_MIN || '45', 10); // Fenster vor der Stunde

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

function ttlEndOfDay(pn) {
  const secNow = pn.hour * 3600 + pn.minute * 60;
  return Math.max(120, 24 * 3600 - secNow + 180); // bis Mitternacht + 3 Min Puffer
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

function normHour(h) {
  const n = parseInt(h, 10);
  return Number.isFinite(n) ? n : null;
}

const K = {
  cnt: (d) => 'plan:cnt:' + d,
  by: (d) => 'plan:by:' + d,
  rem: (d) => 'plan:rem:' + d,
};

// Vormerkung setzen/ändern. Ein Eintrag pro Mitglied/Tag; Zähler wird angepasst.
async function setPlan(memberId, hour, opts, now) {
  if (!hasStore) return { ok: false, error: 'no_store' };
  opts = opts || {};
  const h = normHour(hour);
  const pn = parts(now);
  if (h === null || h < MIN_HOUR || h > MAX_HOUR) return { ok: false, error: 'bad_hour' };
  if (h < pn.hour) return { ok: false, error: 'past' }; // keine vergangene Stunde heute
  const date = pn.date, ttl = String(ttlEndOfDay(pn)), mid = String(memberId);
  const remind = opts.remind !== false;

  const [oldRaw] = await redisPipeline([['HGET', K.by(date), mid]]);
  let oldHour = null;
  if (oldRaw) { try { oldHour = normHour(JSON.parse(oldRaw).hour); } catch (e) {} }

  const rec = JSON.stringify({ hour: h, email: opts.email || '', firstName: opts.firstName || '', remind: remind });
  const cmds = [];
  if (oldHour !== null && oldHour !== h) cmds.push(['HINCRBY', K.cnt(date), String(oldHour), '-1']);
  if (oldHour !== h) cmds.push(['HINCRBY', K.cnt(date), String(h), '1']);
  cmds.push(['HSET', K.by(date), mid, rec]);
  cmds.push(['EXPIRE', K.cnt(date), ttl]);
  cmds.push(['EXPIRE', K.by(date), ttl]);
  if (oldHour !== h) cmds.push(['SREM', K.rem(date), mid]); // bei Zeitwechsel neue Erinnerung zulassen
  await redisPipeline(cmds);
  return { ok: true, plan: { date: date, hour: h, remind: remind } };
}

async function cancelPlan(memberId, now) {
  if (!hasStore) return { ok: false, error: 'no_store' };
  const pn = parts(now), date = pn.date, mid = String(memberId);
  const [oldRaw] = await redisPipeline([['HGET', K.by(date), mid]]);
  if (!oldRaw) return { ok: true, plan: null };
  let oldHour = null; try { oldHour = normHour(JSON.parse(oldRaw).hour); } catch (e) {}
  const cmds = [['HDEL', K.by(date), mid], ['SREM', K.rem(date), mid]];
  if (oldHour !== null) cmds.push(['HINCRBY', K.cnt(date), String(oldHour), '-1']);
  await redisPipeline(cmds);
  return { ok: true, plan: null };
}

async function getMyPlan(memberId, now) {
  if (!hasStore) return null;
  const pn = parts(now);
  const [raw] = await redisPipeline([['HGET', K.by(pn.date), String(memberId)]]);
  if (!raw) return null;
  try { const o = JSON.parse(raw); return { hour: normHour(o.hour), remind: o.remind !== false }; }
  catch (e) { return null; }
}

// Öffentliche, anonyme Aggregation: nur Stunde -> Anzahl (positiv) + Summe.
async function getAggregate(now) {
  if (!hasStore) return { available: false };
  const pn = parts(now);
  const [flat] = await redisPipeline([['HGETALL', K.cnt(pn.date)]]);
  const m = hashToMap(flat);
  const hours = {}; let total = 0;
  Object.keys(m).forEach((k) => {
    const h = normHour(k), c = parseInt(m[k], 10);
    if (h === null || !Number.isFinite(c) || c <= 0) return;
    hours[h] = c; total += c;
  });
  return { available: true, date: pn.date, hours: hours, total: total };
}

// Fällige Erinnerungen: remind=true, E-Mail vorhanden, Stunde startet in 0..LEAD Min,
// noch nicht erinnert.
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
    const h = normHour(o.hour); if (h === null) return;
    const until = h * 60 - nowMin;
    if (until >= 0 && until <= REMIND_LEAD_MIN) {
      due.push({ memberId: String(mid), email: o.email, firstName: o.firstName || '', hour: h });
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

module.exports = {
  setPlan, cancelPlan, getMyPlan, getAggregate, dueReminders, markReminded,
  parts, hasStore, MIN_HOUR, MAX_HOUR,
};
