'use strict';

/*
 * Trainings-Aufzeichnung (Puls) – Speicher + reine Auswertung.
 * ------------------------------------------------------------
 * Ein „Workout" ist eine mit dem Brustgurt aufgezeichnete Einheit (indoor oder
 * outdoor). Der Client streamt den Puls über dieselbe BLE-Anbindung wie der
 * Vital-Check (moBleStart) und schickt am Ende eine (heruntergerechnete)
 * Puls-Reihe; hier wird sie serverseitig zur maßgeblichen Zusammenfassung
 * aggregiert (Zonen, Ø/Max, kcal, TRIMP-Last) und abgelegt.
 *
 * Speicher-Muster wie lib/morning.js (redisPipeline, TTL, CAP). Reine Logik
 * (aggregate/zoneIndex/…) ist ohne Store unit-testbar.
 */

const { redisPipeline, hasStore } = require('./store');
const MO = require('./morning');

const KEY = (id) => 'workout:' + String(id);
const TTL = 400 * 24 * 3600;   // ~13 Monate, bei jedem Schreiben erneuert
const CAP = 200;               // höchstens so viele Einheiten behalten
const VP_PER_WORKOUT = 40;     // Vitalpunkte je aufgezeichnetem Training

// Aktivitätstypen (indoor + outdoor). Key -> Label.
const ACTIVITIES = {
  studio: 'Studio-Training', kraft: 'Krafttraining', cardio: 'Cardio', kurs: 'Kurs',
  laufen: 'Laufen', radfahren: 'Radfahren', gehen: 'Gehen', wandern: 'Wandern', outdoor: 'Outdoor',
};
const OUTDOOR = { laufen: 1, radfahren: 1, gehen: 1, wandern: 1, outdoor: 1 };

function n(v, lo, hi) { const x = Math.round(parseFloat(String(v).replace(',', '.'))); if (!isFinite(x)) return null; if (x < lo || x > hi) return null; return x; }
function nf(v, lo, hi) { const x = parseFloat(String(v).replace(',', '.')); if (!isFinite(x)) return null; if (x < lo || x > hi) return null; return Math.round(x * 1e5) / 1e5; }
function str(v, max) { return String(v == null ? '' : v).slice(0, max || 60); }

// Max-Herzfrequenz nach Tanaka (208 − 0,7·Alter); Fallback 190.
function hrMaxFromAge(age) { return (age > 0) ? Math.round(208 - 0.7 * age) : 190; }

// Zonen-Index 0..4 für einen Puls anhand der trainingZones-Tabelle (bpmLo je Zone). −1 = unter Z1.
function zoneIndex(bpm, table) {
  if (!Array.isArray(table)) return -1;
  for (let i = table.length - 1; i >= 0; i--) { if (bpm >= table[i].bpmLo) return i; }
  return -1;
}

// Puls-Reihe [{t(ms), bpm}] -> maßgebliche Zusammenfassung. opts: {age, weightKg, sex, hrRest}.
function aggregate(samples, opts) {
  opts = opts || {};
  const s = (Array.isArray(samples) ? samples : [])
    .map((x) => ({ t: (x && x.t) || 0, bpm: (x && x.bpm) || 0 }))
    .filter((x) => x.bpm >= 30 && x.bpm <= 240 && x.t > 0)
    .sort((a, b) => a.t - b.t);
  if (s.length < 3) return null;
  const age = n(opts.age, 5, 120) || 0;
  const zones = MO.trainingZones(age || 30) || { hrMax: hrMaxFromAge(age), table: [] };
  const hrMax = zones.hrMax;
  const table = zones.table;
  const durationSec = Math.max(1, Math.round((s[s.length - 1].t - s[0].t) / 1000));
  let sum = 0, maxHr = 0, minHr = 999;
  const zoneSecs = [0, 0, 0, 0, 0];
  const hrRest = n(opts.hrRest, 30, 110) || 60;
  const w = n(opts.weightKg, 30, 250) || 75;
  const sex = (opts.sex === 'f' || opts.sex === 'w' || opts.sex === 'weiblich') ? 'f' : 'm';
  let trimp = 0;
  for (let i = 0; i < s.length; i++) {
    const bpm = s[i].bpm; sum += bpm; if (bpm > maxHr) maxHr = bpm; if (bpm < minHr) minHr = bpm;
    // Dauer, die dieser Messwert repräsentiert = Abstand zum nächsten (gedeckelt gegen Aussetzer).
    const dt = (i < s.length - 1) ? Math.min(30, Math.max(0, (s[i + 1].t - s[i].t) / 1000)) : 0;
    const zi = zoneIndex(bpm, table);
    if (zi >= 0) zoneSecs[zi] += dt;
    // TRIMP (Banister, exponentiell) über die Herzfrequenzreserve.
    const hrr = Math.min(1, Math.max(0, (bpm - hrRest) / Math.max(1, (hrMax - hrRest))));
    const k = (sex === 'f') ? 1.67 : 1.92;
    trimp += (dt / 60) * hrr * 0.64 * Math.exp(k * hrr);
  }
  const avgHr = Math.round(sum / s.length);
  const min = durationSec / 60;
  // Kalorien (HF-basiert, Keytel-Formel).
  let kcal;
  if (sex === 'f') kcal = min * ((-20.4022 + 0.4472 * avgHr - 0.1263 * w + 0.074 * (age || 30)) / 4.184);
  else kcal = min * ((-55.0969 + 0.6309 * avgHr + 0.1988 * w + 0.2017 * (age || 30)) / 4.184);
  kcal = Math.max(0, Math.round(kcal));
  return {
    durationSec, avgHr, maxHr: maxHr || avgHr, minHr: (minHr === 999 ? avgHr : minHr),
    zoneSecs: zoneSecs.map((x) => Math.round(x)), kcal, trimp: Math.round(trimp), hrMax,
  };
}

// Eingehende Einheit säubern (client-berechnet ODER server-aggregiert).
function sanitizeSession(o, tsNow) {
  o = o && typeof o === 'object' ? o : {};
  const kind = (o.kind === 'outdoor') ? 'outdoor' : 'indoor';
  let activity = ACTIVITIES[o.activity] ? o.activity : (kind === 'outdoor' ? 'laufen' : 'studio');
  const sess = {
    ts: (typeof tsNow === 'number' && tsNow > 0) ? tsNow : (n(o.ts, 1, 9e15) || 0),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? String(o.date) : '',
    kind, activity,
    durationSec: n(o.durationSec, 5, 86400) || 0,
    avgHr: n(o.avgHr, 30, 230),
    maxHr: n(o.maxHr, 30, 240),
    minHr: n(o.minHr, 25, 220),
    zoneSecs: Array.isArray(o.zoneSecs) ? o.zoneSecs.slice(0, 5).map((x) => n(x, 0, 86400) || 0) : [0, 0, 0, 0, 0],
    kcal: n(o.kcal, 0, 6000) || 0,
    trimp: n(o.trimp, 0, 1000) || 0,
    note: str(o.note, 140),
  };
  if (kind === 'outdoor') {
    sess.distanceM = n(o.distanceM, 0, 300000);
    sess.paceSec = n(o.paceSec, 60, 3600);      // Sekunden pro km
    sess.elevM = n(o.elevM, 0, 15000);
    if (Array.isArray(o.route)) {
      sess.route = o.route.slice(0, 600)
        .map((p) => (Array.isArray(p) ? [nf(p[0], -90, 90), nf(p[1], -180, 180)] : null))
        .filter((p) => p && p[0] != null && p[1] != null);
    }
  }
  return sess;
}
function validSession(s) { return !!(s && s.durationSec >= 10 && s.avgHr > 0); }

async function list(id) {
  if (!hasStore || id == null) return [];
  try {
    const [v] = await redisPipeline([['GET', KEY(id)]]);
    if (!v) return [];
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map((x) => sanitizeSession(x, x && x.ts)).filter(validSession) : [];
  } catch (e) { return []; }
}

async function add(id, session, tsNow) {
  const s = sanitizeSession(session, tsNow);
  if (!validSession(s)) return { ok: false, error: 'empty', list: await list(id) };
  if (!hasStore || id == null) return { ok: true, list: [s], saved: false, session: s };
  try {
    const arr = await list(id);
    arr.unshift(s);
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const trimmed = arr.slice(0, CAP);
    await redisPipeline([['SET', KEY(id), JSON.stringify(trimmed), 'EX', String(TTL)]]);
    return { ok: true, list: trimmed, saved: true, session: s };
  } catch (e) { return { ok: false, error: 'save_failed', list: await list(id) }; }
}

async function remove(id, sel) {
  if (!hasStore || id == null) return { ok: true, list: [] };
  try {
    const arr = await list(id);
    const keep = arr.filter((x) => String(x.ts) !== String(sel));
    await redisPipeline([['SET', KEY(id), JSON.stringify(keep), 'EX', String(TTL)]]);
    return { ok: true, list: keep };
  } catch (e) { return { ok: false, list: await list(id) }; }
}

async function clear(id) {
  if (!hasStore || id == null) return { ok: true };
  try { await redisPipeline([['DEL', KEY(id)]]); return { ok: true }; } catch (e) { return { ok: false }; }
}

// 7-Tage-Trainingslast (Summe TRIMP) + Sessions + Minuten – speist Erholung/Bereitschaft.
function weeklyLoad(arr) {
  const list0 = Array.isArray(arr) ? arr : [];
  const cut = Date.now() - 7 * 864e5;
  const w = list0.filter((s) => (s.ts || 0) >= cut);
  const trimp = w.reduce((a, s) => a + (s.trimp || 0), 0);
  const minutes = Math.round(w.reduce((a, s) => a + (s.durationSec || 0), 0) / 60);
  const last = list0[0] || null;
  return { sessions: w.length, trimp: Math.round(trimp), minutes, lastTs: last ? last.ts : null, lastLoad: last ? (last.trimp || 0) : 0 };
}

module.exports = {
  KEY, TTL, CAP, VP_PER_WORKOUT, ACTIVITIES, OUTDOOR,
  hrMaxFromAge, zoneIndex, aggregate, sanitizeSession, validSession, weeklyLoad,
  list, add, remove, clear,
};
