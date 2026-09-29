'use strict';

/**
 * FINN Journeys – Trainingshäufigkeit je Mitglied aus Check-ins.
 * -----------------------------------------------------------------------------
 * Gefüllt vom Magicline-Webhook CUSTOMER_CHECKIN (ein Besuch je Kalendertag, Berlin)
 * und einmalig per Nachlauf aus der Check-in-Historie (backfill.js).
 *
 * jr:eng:<kundenId>  (Hash, EIN Schlüssel je Person – der Datenschutz-Export
 *                     durchsucht höchstens 10.000 Schlüssel)
 *   d:<YYYYMMDD>  1 (Besuchstag, 70 Tage)       w:<YYYY-Www>  Besuchstage je ISO-Woche (30 Wochen)
 *   tot  Besuchstage gesamt (seit Nachlauf/Eintritt)   first/last  ms   lastYmd
 *   bf   Nachlauf erledigt (ms)                  ms:<n> Meilenstein erreicht (ms)
 *
 * metrics() und classify() sind reine Funktionen (testbar, ohne Speicher).
 * Wochenserie = gleiche Regel wie lib/social.checkinVitals().weekStreak
 * (Wochen in Folge mit mindestens einem Besuch; läuft die aktuelle Woche noch
 * ohne Besuch, zählt ab der Vorwoche).
 */

const KV = require('../finn/kv');
const Quiet = require('./quiet');

const TTL = 400 * 86400;
const DAY = 86400000;
const DAY_KEEP = 70, WEEK_KEEP = 30;
const MILESTONES = [10, 25, 50, 100, 250, 500];
const STREAKS = [4, 8, 12, 26, 52];
const K = (cid) => 'jr:eng:' + String(cid);

function ymd(ts) { return Quiet.parts(ts).ymd; }
// ISO-Woche des Berliner Kalendertags.
function weekKey(ts) {
  const p = Quiet.parts(ts);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const wd = (d.getUTCDay() + 6) % 7;             // Mo=0
  d.setUTCDate(d.getUTCDate() - wd + 3);           // Donnerstag der Woche
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return y + '-W' + String(w).padStart(2, '0');
}
function ymdToTs(s) { return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12); }

/**
 * Einen Besuch zählen. Liefert { counted, first, tot, milestone } – milestone nur,
 * wenn der Nachlauf erledigt ist (sonst wäre „dein 50. Besuch" geraten).
 */
async function recordVisit(cid, at) {
  if (!/^[0-9]{1,12}$/.test(String(cid || ''))) return { counted: false };
  at = at || Date.now();
  const key = K(cid);
  const h = await KV.hgetall(key);
  const day = ymd(at);
  const last = Number(h.last) || 0;
  if (h['d:' + day] != null || h.lastYmd === day) {
    if (at > last) await KV.hset(key, { last: at }, TTL);
    return { counted: false, first: false, tot: Number(h.tot) || 0 };
  }
  const tot = await KV.hincrby(key, 'tot', 1, TTL);
  await KV.hincrby(key, 'w:' + weekKey(at), 1, TTL);
  const patch = { ['d:' + day]: 1 };
  if (at >= last) { patch.last = at; patch.lastYmd = day; }
  if (!h.first || at < Number(h.first)) patch.first = at;
  await KV.hset(key, patch, TTL);
  let milestone = null;
  const tracked = !!(h.bf || h.track);
  if (tracked && MILESTONES.indexOf(Number(tot)) >= 0 && !h['ms:' + tot]) { milestone = Number(tot); await KV.hset(key, { ['ms:' + tot]: at }, TTL); }
  if ((Number(tot) || 0) % 10 === 0) await prune(cid, h, at);
  // Erster Besuch nur bei Mitgliedern, die ab Vertragsbeginn mitgezählt werden –
  // bei Bestandsmitgliedern ohne Nachlauf wäre das geraten.
  return { counted: true, first: !h.first && !!h.track && !h.bf, tot: Number(tot) || 0, milestone: milestone };
}

// Neue Mitglieder: ab Vertragsabschluss wird vollständig mitgezählt (kein Nachlauf nötig).
async function startTracking(cid, at) {
  if (!/^[0-9]{1,12}$/.test(String(cid || ''))) return false;
  const h = await KV.hgetall(K(cid));
  if (h.track || h.bf) return true;
  return KV.hset(K(cid), { track: at || Date.now() }, TTL);
}

async function prune(cid, h, now) {
  h = h || (await KV.hgetall(K(cid)));
  const minDay = ymd(now - DAY_KEEP * DAY);
  const minWeek = weekKey(now - WEEK_KEEP * 7 * DAY);
  const del = Object.keys(h).filter((f) => (f.indexOf('d:') === 0 && f.slice(2) < minDay) || (f.indexOf('w:') === 0 && f.slice(2) < minWeek));
  if (del.length) await KV.hdel(K(cid), del);
}

async function read(cid) { return /^[0-9]{1,12}$/.test(String(cid || '')) ? KV.hgetall(K(cid)) : {}; }

// Nachlauf: Besuchstage aus der Historie setzen (idempotent, setzt bf).
async function applyHistory(cid, times, now) {
  now = now || Date.now();
  const days = new Set(); const weeks = {};
  let first = null, last = null;
  (times || []).forEach((t) => {
    if (!t || !isFinite(t)) return;
    const d = ymd(t); if (days.has(d)) return;
    days.add(d);
    const w = weekKey(t); weeks[w] = (weeks[w] || 0) + 1;
    if (first == null || t < first) first = t; if (last == null || t > last) last = t;
  });
  const minDay = ymd(now - DAY_KEEP * DAY), minWeek = weekKey(now - WEEK_KEEP * 7 * DAY);
  const cur = await read(cid);
  const patch = { bf: now, tot: Math.max(days.size, Number(cur.tot) || 0) };
  days.forEach((d) => { if (d >= minDay) patch['d:' + d] = 1; });
  Object.keys(weeks).forEach((w) => { if (w >= minWeek) patch['w:' + w] = Math.max(weeks[w], Number(cur['w:' + w]) || 0); });
  if (first != null && (!cur.first || first < Number(cur.first))) patch.first = first;
  if (last != null && last >= (Number(cur.last) || 0)) { patch.last = last; patch.lastYmd = ymd(last); }
  // Bereits überschrittene Meilensteine gelten als gefeiert – nichts nachträglich melden.
  MILESTONES.forEach((n) => { if (patch.tot >= n && !cur['ms:' + n]) patch['ms:' + n] = 1; });
  await KV.hset(K(cid), patch, TTL);
  return { days: days.size };
}

/**
 * Kennzahlen aus dem Hash. goal = Besuche pro Woche (Profil `freq`, Standard 2).
 * -> { v7, v28, last14, prev14, trend, goal, ratio, daysSince, weekStreak, goalStreak,
 *      belowGoalWeeks, tot, first, last, tracked }
 */
function metrics(h, now, goal) {
  h = h || {}; now = now || Date.now();
  goal = Math.max(1, Math.min(7, Number(goal) || 2));
  const days = Object.keys(h).filter((f) => f.indexOf('d:') === 0).map((f) => f.slice(2));
  const today = ymd(now);
  const inLast = (n) => { const min = ymd(now - (n - 1) * DAY); return days.filter((d) => d >= min && d <= today).length; };
  const v7 = inLast(7), v28 = inLast(28), last14 = inLast(14);
  const prev14 = v28 - last14;
  const last = Number(h.last) || null;
  const daysSince = last ? Math.max(0, Math.floor((ymdToTs(today) - ymdToTs(ymd(last))) / DAY)) : null;
  // Wochen rückwärts ab der aktuellen
  const wk = (off) => Number(h['w:' + weekKey(now - off * 7 * DAY)]) || 0;
  let start = wk(0) > 0 ? 0 : 1, weekStreak = 0;
  for (let i = start; i < WEEK_KEEP; i++) { if (wk(i) > 0) weekStreak++; else break; }
  let goalStreak = wk(0) >= goal ? 1 : 0;
  for (let i = 1; i < WEEK_KEEP; i++) { if (wk(i) >= goal) goalStreak++; else break; }
  const belowGoalWeeks = (wk(1) < goal ? 1 : 0) + (wk(1) < goal && wk(2) < goal ? 1 : 0);
  return {
    v7: v7, v28: v28, last14: last14, prev14: prev14, trend: last14 - prev14, goal: goal,
    ratio: Math.round((v28 / (goal * 4)) * 100) / 100, daysSince: daysSince,
    weekStreak: weekStreak, goalStreak: goalStreak, belowGoalWeeks: belowGoalWeeks,
    tot: Number(h.tot) || 0, first: Number(h.first) || null, last: last, tracked: !!(h.bf || h.track),
  };
}

/**
 * Stufe für Journeys und Team-Profil:
 *   gekuendigt | neu | unbekannt | inaktiv28 | inaktiv21 | inaktiv14 | inaktiv10 | auf_kurs | rutscht_ab | dabei
 */
function classify(m, facts, now) {
  facts = facts || {}; now = now || Date.now();
  if (facts.cancelled) return 'gekuendigt';
  if (facts.joinAt && now - facts.joinAt < 90 * DAY) return 'neu';
  if (!m || m.daysSince == null) return 'unbekannt';
  if (m.daysSince >= 28) return 'inaktiv28';
  if (m.daysSince >= 21) return 'inaktiv21';
  if (m.daysSince >= 14) return 'inaktiv14';
  if (m.daysSince >= 10) return 'inaktiv10';
  if (m.ratio >= 0.75) return 'auf_kurs';
  if (m.belowGoalWeeks >= 2) return 'rutscht_ab';
  return 'dabei';
}

const STAGE_LABEL = { gekuendigt: 'Gekündigt', neu: 'Neu (erste 90 Tage)', unbekannt: 'Noch keine Daten', inaktiv28: '28+ Tage nicht da', inaktiv21: '21+ Tage nicht da', inaktiv14: '14+ Tage nicht da', inaktiv10: '10+ Tage nicht da', auf_kurs: 'Auf Kurs', rutscht_ab: 'Rutscht ab', dabei: 'Dabei' };

// Besuchstage seit einem Zeitpunkt (für Onboarding: „seit Eintritt").
function visitsSince(h, since) {
  const min = ymd(since || 0);
  return Object.keys(h || {}).filter((f) => f.indexOf('d:') === 0 && f.slice(2) >= min).length;
}

module.exports = { K, TTL, MILESTONES, STREAKS, STAGE_LABEL, ymd, weekKey, recordVisit, startTracking, applyHistory, read, metrics, classify, visitsSince, prune };
