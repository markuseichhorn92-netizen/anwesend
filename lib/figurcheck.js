'use strict';

/**
 * Figur-Check – die Mess-Journey fürs Mitglied (Figurscout-Stil).
 * -------------------------------------------------------------------------
 * Start → Zwischen → Aktuell: Gewicht + Umfänge (Taille/Hüfte/Brust/Arm/Bein)
 * + optional Körperfett. Zeigt Fortschrittskurven und einen Vorher-Nachher-
 * Vergleich. BEWUSST getrennt vom Coaching-Check-in (nutri:checkins): keine
 * Einschreibung nötig, keine Stimmung/Umsetzung, keine Team-Einschleifung –
 * eine schlichte, freie Selbstvermessung. Eigener Store nutri:figur:<id>.
 *
 * Alle Werte werden serverseitig validiert und geklemmt. Ein Eintrag pro Tag
 * (gleicher Tag ersetzt). Kein medizinischer Anspruch – reine Selbstverfolgung.
 */

const { redisPipeline, hasStore } = require('./store');

const KEY = (id) => 'nutri:figur:' + String(id);
const FIGUR_TTL = 60 * 60 * 24 * 400; // ~13 Monate; jeder Speichervorgang verlängert
const MAX = 60;                       // gekappte Historie

// Messgrößen: Reihenfolge = Anzeigereihenfolge. lo/hi klemmen unplausible Eingaben.
// „dec" = Nachkommastellen. Bewusst KEINE Wertung „kleiner ist besser" – die Deutung
// hängt vom Ziel ab (Aufbau vs. Abnehmen); die App zeigt nur neutrale Deltas.
const METRICS = [
  { key: 'weight', label: 'Gewicht', unit: 'kg', lo: 35, hi: 250, dec: 1 },
  { key: 'waist', label: 'Taille', unit: 'cm', lo: 40, hi: 200, dec: 1 },
  { key: 'hips', label: 'Hüfte', unit: 'cm', lo: 40, hi: 200, dec: 1 },
  { key: 'chest', label: 'Brust', unit: 'cm', lo: 40, hi: 200, dec: 1 },
  { key: 'arm', label: 'Arm', unit: 'cm', lo: 15, hi: 80, dec: 1 },
  { key: 'thigh', label: 'Bein', unit: 'cm', lo: 25, hi: 100, dec: 1 },
  { key: 'bodyFat', label: 'Körperfett', unit: '%', lo: 3, hi: 70, dec: 1 },
];
const METRIC_BY_KEY = METRICS.reduce(function (m, x) { m[x.key] = x; return m; }, {});

// ── KV-Helfer (robust ohne Store) ──
async function kvGetJson(key) {
  if (!hasStore) return null;
  try { const [r] = await redisPipeline([['GET', key]]); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
async function kvSetJson(key, val) {
  if (!hasStore) return false;
  try { await redisPipeline([['SET', key, JSON.stringify(val), 'EX', String(FIGUR_TTL)]]); return true; } catch (e) { return false; }
}

// ── Datum (Europe/Berlin), DST-sicher – wie coaching.berlinToday ──
function berlinToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function isYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function daysBetween(aYMD, bYMD) {
  const a = new Date(String(aYMD) + 'T12:00:00Z').getTime();
  const b = new Date(String(bYMD) + 'T12:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}
function roundTo(n, dec) { const p = Math.pow(10, dec || 0); return Math.round(n * p) / p; }
function clampNum(v, lo, hi, dec) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return roundTo(Math.max(lo, Math.min(hi, n)), dec);
}

async function getRec(id) { return kvGetJson(KEY(id)); }
async function saveRec(id, rec) { rec.updatedAt = Date.now(); return kvSetJson(KEY(id), rec); }

// Validierter Eintrag. data trägt Metrik-Schlüssel (weight/waist/…) + note.
// -> Entry | null (null, wenn KEIN einziger gültiger Messwert dabei ist).
function buildEntry(data, today) {
  data = data || {};
  const values = {};
  METRICS.forEach(function (m) {
    const v = clampNum(data[m.key], m.lo, m.hi, m.dec);
    if (v != null) values[m.key] = v;
  });
  if (!Object.keys(values).length) return null;
  return {
    at: Date.now(),
    date: isYMD(today) ? today : berlinToday(),
    values: values,
    note: String(data.note == null ? '' : data.note).replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

// Eintrag ablegen (max. 1/Tag: gleicher Tag ersetzt), Historie auf MAX gekappt,
// chronologisch (nach Datum aufsteigend) sortiert. -> rec.
function appendEntry(rec, entry) {
  rec = rec || { list: [], updatedAt: 0 };
  rec.list = Array.isArray(rec.list) ? rec.list : [];
  const i = rec.list.map(function (e) { return e.date; }).indexOf(entry.date);
  if (i >= 0) rec.list[i] = entry; else rec.list.push(entry);
  rec.list.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); });
  if (rec.list.length > MAX) rec.list = rec.list.slice(-MAX);
  return rec;
}

function deleteEntry(rec, date) {
  if (!rec || !Array.isArray(rec.list)) return rec || { list: [] };
  rec.list = rec.list.filter(function (e) { return e.date !== date; });
  return rec;
}

function listOf(rec) {
  const list = (rec && Array.isArray(rec.list)) ? rec.list.slice() : [];
  list.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); });
  return list;
}

// Reine Historie (Datum + Werte + Notiz), chronologisch.
function history(rec) {
  return listOf(rec).map(function (e) {
    return { date: e.date, values: e.values || {}, note: e.note || '' };
  });
}

// Vorher-Nachher + Verlauf je Messgröße. -> { count, firstDate, lastDate,
// spanDays, metrics:[{key,label,unit,dec,start,latest,delta,points,series}] }.
// „start" ist der erste erfasste Wert dieser Größe, „latest" der jüngste; nur
// Messgrößen mit mindestens einem Datenpunkt erscheinen.
function summary(rec) {
  const list = listOf(rec);
  if (!list.length) return { count: 0, firstDate: null, lastDate: null, spanDays: 0, metrics: [] };
  const firstDate = list[0].date, lastDate = list[list.length - 1].date;
  const metrics = METRICS.map(function (m) {
    const series = [];
    list.forEach(function (e) {
      const v = e.values && e.values[m.key];
      if (v != null) series.push({ date: e.date, value: v });
    });
    if (!series.length) return null;
    const start = series[0].value, latest = series[series.length - 1].value;
    return {
      key: m.key, label: m.label, unit: m.unit, dec: m.dec,
      start: start, latest: latest,
      delta: roundTo(latest - start, m.dec),
      points: series.length,
      series: series,
    };
  }).filter(Boolean);
  return { count: list.length, firstDate: firstDate, lastDate: lastDate, spanDays: daysBetween(firstDate, lastDate), metrics: metrics };
}

// Kompakter Kontext für die (Premium-)KI-Auswertung: Ziel-neutral, nur Zahlen.
function reviewContext(rec, goal) {
  const s = summary(rec);
  const lines = s.metrics.map(function (m) {
    return m.label + ': Start ' + m.start + ' ' + m.unit + ' → aktuell ' + m.latest + ' ' + m.unit
      + ' (' + (m.delta > 0 ? '+' : '') + m.delta + ' ' + m.unit + ', ' + m.points + ' Messungen)';
  });
  return { goal: goal || '', count: s.count, spanDays: s.spanDays, lines: lines };
}

module.exports = {
  KEY, MAX, METRICS, METRIC_BY_KEY,
  berlinToday, isYMD, daysBetween,
  getRec, saveRec, buildEntry, appendEntry, deleteEntry,
  history, summary, reviewContext,
};
