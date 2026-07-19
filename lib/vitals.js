'use strict';

/**
 * lib/vitals.js — Passive Vitalwerte aus Apple Health / Google Fit (Apple Watch,
 * Garmin, Waage). Tages-Schnappschüsse (ein Eintrag pro Tag) mit persönlicher
 * Baseline, Erholungs-Ampel (Whoop/Oura-artig) aus Ruhepuls + HRV + Schlaf,
 * Schlaf-Referenz und Prompt-Text für FINN.
 *
 * WICHTIG – Abgrenzung zum Morgen-Check (lib/morning.js):
 *  - morning.js misst HRV als RMSSD (Brustgurt, R-R-Intervalle).
 *  - Apple Health liefert HRV als SDNN. Andere Skala – deshalb ein EIGENER Store
 *    und eine eigene Baseline, damit sich RMSSD (Gurt) und SDNN (Watch) nicht
 *    vermischen. Verglichen wird immer SDNN gegen die eigene SDNN-Baseline
 *    (Verhältnis ist skalenunabhängig).
 *
 * Herz-/HRV-/Schlafdaten sind Gesundheitsdaten (DSGVO Art. 9): Speicherung nur
 * mit ausdrücklicher Einwilligung (dieselbe wie der Vital-Check), jederzeit
 * widerrufbar. Kein Medizinprodukt – Wellness-Signal, keine Diagnose.
 * Ohne KV-Store: No-Op.
 */

const { redisPipeline, hasStore } = require('./store');

const VKEY = (id) => 'health:vitals:' + String(id);
const CAP = 120;                    // bis zu 120 Tage Verlauf
const TTL = 400 * 24 * 3600;        // ~13 Monate
const BASE_WINDOW = 28;             // Baseline aus bis zu 28 Vortagen
const MIN_CALIB = 3;                // belastbare Baseline ab 3 Vergleichstagen

function num(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return Math.round(n * 10) / 10;
}
function intv(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  const r = Math.round(n);
  if (r < lo || r > hi) return null;
  return r;
}
function isoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
function median(vals) {
  const a = vals.slice().sort((x, y) => x - y); const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2 * 10) / 10;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

// Rohwerte vom Client säubern -> normalisierter Tages-Schnappschuss.
function sanitize(input, tsHint) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    ts: (typeof tsHint === 'number' && tsHint > 0) ? tsHint : (parseInt(o.ts, 10) || 0),
    date: isoDate(o.date) || todayIso(),
    restingHr: num(o.restingHr != null ? o.restingHr : o.rhr, 30, 130),
    hrv: num(o.hrv != null ? o.hrv : o.sdnn, 2, 400),   // SDNN aus Apple Health
    sleepMin: intv(o.sleepMin, 0, 1000),
    // Schlafphasen (Oura-artig) – nur wenn die Quelle sie liefert (Apple Watch iOS 16+).
    sleepDeepMin: intv(o.sleepDeepMin, 0, 1000),
    sleepRemMin: intv(o.sleepRemMin, 0, 1000),
    sleepLightMin: intv(o.sleepLightMin, 0, 1000),
    sleepAwakeMin: intv(o.sleepAwakeMin, 0, 600),
    sleepInBedMin: intv(o.sleepInBedMin, 0, 1200),
    vo2max: num(o.vo2max, 10, 90),
    steps: intv(o.steps, 0, 100000),
    weightKg: num(o.weightKg, 30, 400),
    bodyFatPct: num(o.bodyFatPct, 3, 70),
    source: 'health',
  };
}

// true, wenn überhaupt ein verwertbarer Wert enthalten ist.
function hasAny(m) {
  return !!(m && (m.restingHr != null || m.hrv != null || m.sleepMin != null || m.steps != null || m.vo2max != null || m.weightKg != null || m.bodyFatPct != null));
}

// ── Persönliche Baseline ── Median der bis zu BASE_WINDOW Vortage (OHNE heute).
// list ist neueste-zuerst.
function baseline(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  const prior = arr.slice(1, 1 + BASE_WINDOW);
  const rhrVals = prior.map((m) => m.restingHr).filter((v) => v != null);
  const hrvVals = prior.map((m) => m.hrv).filter((v) => v != null);
  const slpVals = prior.map((m) => m.sleepMin).filter((v) => v != null);
  const rhr = rhrVals.length >= MIN_CALIB ? median(rhrVals) : null;
  const hrv = hrvVals.length >= MIN_CALIB ? median(hrvVals) : null;
  const sleepMin = slpVals.length >= MIN_CALIB ? median(slpVals) : null;
  return {
    rhr: rhr, hrv: hrv, sleepMin: sleepMin,
    rhrN: rhrVals.length, hrvN: hrvVals.length, sleepN: slpVals.length,
    calibrating: rhr == null && hrv == null,
    remaining: Math.max(0, MIN_CALIB - Math.max(rhrVals.length, hrvVals.length)),
  };
}

// ── Erholungs-Ampel (Whoop/Oura-artig) ── aus Ruhepuls-Delta + HRV-Verhältnis +
// Schlafdauer gegen die persönliche Baseline. -> { level, score, headline, hasBaseline }
function readiness(m, base) {
  base = base || {};
  const hasB = base.rhr != null || base.hrv != null;
  if (!m || (m.restingHr == null && m.hrv == null && m.sleepMin == null)) {
    return { level: 'kalibrierung', score: null, headline: 'Noch keine Werte', hasBaseline: hasB, calibrating: !hasB };
  }
  if (!hasB) {
    return { level: 'kalibrierung', score: null, headline: 'Kalibrierung läuft', hasBaseline: false, calibrating: true };
  }
  let score = 100;
  if (base.rhr != null && m.restingHr != null) {
    const d = m.restingHr - base.rhr;
    if (d > 2) score -= Math.min(40, (d - 2) * 6);
    if (d < -8) score -= Math.min(12, (-d - 8) * 2);   // ungewöhnlich niedrig -> evtl. Übermüdung
  }
  if (base.hrv != null && m.hrv != null) {
    const ratio = m.hrv / base.hrv;
    if (ratio < 1) score -= Math.min(40, (1 - ratio) * 65);
  }
  if (m.sleepMin != null) {
    const h = m.sleepMin / 60;
    if (h < 6) score -= Math.min(20, (6 - h) * 10);
    else if (h < 7) score -= 5;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 75 ? 'gruen' : score >= 55 ? 'gelb' : 'rot';
  const headline = level === 'gruen' ? 'Bereit für Vollgas' : level === 'gelb' ? 'Moderat starten' : 'Heute auf Erholung setzen';
  return { level: level, score: score, headline: headline, hasBaseline: true, calibrating: false };
}

// Schlaf-Referenz für das Morgen-Briefing (braucht keine Baseline – absolute Stunden).
function sleepRef(m, base) {
  if (!m || m.sleepMin == null) return null;
  const h = m.sleepMin / 60;
  const label = Math.floor(m.sleepMin / 60) + 'h ' + (m.sleepMin % 60) + 'm';
  let cat, note;
  if (h >= 7 && h <= 9.5) { cat = 'good'; note = 'Solide Nachtruhe – gute Basis für heute.'; }
  else if (h >= 6) { cat = 'warn'; note = 'Etwas kurz – halt die Intensität heute im Blick.'; }
  else { cat = 'bad'; note = 'Wenig Schlaf – heute eher regenerativ trainieren.'; }
  const ref = (base && base.sleepMin != null) ? ('Dein Schnitt ' + Math.floor(base.sleepMin / 60) + 'h ' + (base.sleepMin % 60) + 'm') : '';
  return { label: label, hours: Math.round(h * 10) / 10, cat: cat, note: note, ref: ref };
}

// Detaillierte Schlaf-Auswertung (Oura-artig): Phasen, Effizienz, Score.
// -> { totalMin, deepMin, remMin, lightMin, awakeMin, inBedMin, efficiency, score, hasStages } | null
function sleepDetail(m) {
  if (!m || !(m.sleepMin > 0)) return null;
  const tot = m.sleepMin;
  const hasStages = (m.sleepDeepMin != null || m.sleepRemMin != null);
  const inBed = (m.sleepInBedMin != null && m.sleepInBedMin >= tot) ? m.sleepInBedMin : null;
  const awake = (m.sleepAwakeMin != null) ? m.sleepAwakeMin : null;
  const denom = inBed || ((awake != null) ? (tot + awake) : null);
  // Effizienz nur, wenn es einen echten Wachanteil/Bett-Überhang gibt (denom > tot).
  // Fehlt der Uhr die „im Bett"-/Wach-Phase, wäre Effizienz trivial 100 % – kein
  // echter Messwert und würde Anzeige wie Score künstlich schönen. Dann lieber weglassen.
  const efficiency = (denom && denom > tot) ? Math.max(0, Math.min(100, Math.round(tot / denom * 100))) : null;
  // Score: Dauer (50 %) + Effizienz (20 %) + Tief-% (15 %) + REM-% (15 %). Ziel-Anteile
  // Tief ~15 %, REM ~22 % der Schlafzeit; 7–10 h Dauer = voll.
  const parts = [];
  const durScore = tot >= 420 ? (tot <= 600 ? 100 : Math.max(75, 100 - (tot - 600) / 6)) : Math.max(0, Math.round((tot - 180) / 240 * 100));
  parts.push([Math.min(100, durScore), 0.5]);
  if (efficiency != null) parts.push([Math.max(0, Math.min(100, Math.round((efficiency - 60) / 35 * 100))), 0.2]);
  if (m.sleepDeepMin != null) parts.push([Math.min(100, Math.round((m.sleepDeepMin / tot) / 0.15 * 100)), 0.15]);
  if (m.sleepRemMin != null) parts.push([Math.min(100, Math.round((m.sleepRemMin / tot) / 0.22 * 100)), 0.15]);
  const wsum = parts.reduce((a, p) => a + p[1], 0);
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum)));
  return {
    totalMin: tot,
    deepMin: (m.sleepDeepMin != null) ? m.sleepDeepMin : null,
    remMin: (m.sleepRemMin != null) ? m.sleepRemMin : null,
    lightMin: (m.sleepLightMin != null) ? m.sleepLightMin : null,
    awakeMin: awake, inBedMin: inBed,
    efficiency: efficiency, score: score, hasStages: hasStages,
  };
}

// Bewertung je Kennzahl (für die UI). -> [{ key, label, value, unit, cat, note, ref }]
function evaluate(m, base) {
  if (!m) return [];
  base = base || {};
  const out = [];
  const push = (key, label, value, unit, cat, note, ref) => { if (value != null) out.push({ key: key, label: label, value: value, unit: unit, cat: cat, note: note || '', ref: ref || '' }); };
  if (m.restingHr != null) {
    if (base.rhr != null) {
      const d = Math.round((m.restingHr - base.rhr) * 10) / 10;
      const cat = d <= 3 ? 'good' : d <= 6 ? 'warn' : 'bad';
      const note = d <= 3 ? 'Im Bereich deiner Baseline.' : d <= 6 ? 'Leicht erhöht – Schlaf, Stress oder Alkohol?' : 'Deutlich erhöht – dein Körper steht unter Last.';
      push('rhr', 'Ruhepuls', m.restingHr, ' bpm', cat, note, 'Baseline ' + base.rhr + ' bpm');
    } else push('rhr', 'Ruhepuls', m.restingHr, ' bpm', 'info', 'Kalibrierung läuft.', '');
  }
  if (m.hrv != null) {
    if (base.hrv != null) {
      const ratio = m.hrv / base.hrv;
      const cat = ratio >= 0.9 ? 'good' : ratio >= 0.75 ? 'warn' : 'bad';
      const note = ratio >= 0.9 ? 'Gute Erholung.' : ratio >= 0.75 ? 'Unter deinem Schnitt.' : 'Deutlich unter deinem Schnitt – heute eher Erholung.';
      push('hrv', 'HRV', m.hrv, ' ms', cat, note, 'Schnitt ' + base.hrv + ' ms · höher = erholter');
    } else push('hrv', 'HRV', m.hrv, ' ms', 'info', 'Kalibrierung läuft.', '');
  }
  const sr = sleepRef(m, base);
  if (sr) push('sleep', 'Schlaf', sr.label, '', sr.cat, sr.note, sr.ref);
  if (m.vo2max != null) push('vo2max', 'VO₂max', m.vo2max, '', 'info', 'Ausdauer-Kennzahl (höher = fitter).', '');
  if (m.steps != null) push('steps', 'Schritte', m.steps, '', 'info', '', '');
  return out;
}

// Veränderung seit dem Vortag. -> { prevDate, since:{ rhr, hrv, sleepMin } } | null
function trend(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (arr.length < 2) return null;
  const cur = arr[0], prev = arr[1];
  const diff = (a, b) => (a != null && b != null) ? Math.round((a - b) * 10) / 10 : null;
  return { prevDate: prev.date || '', since: { rhr: diff(cur.restingHr, prev.restingHr), hrv: diff(cur.hrv, prev.hrv), sleepMin: diff(cur.sleepMin, prev.sleepMin) } };
}

// Prompt-Text für FINN (coach.js). Vertraulich, nur bei Einwilligung anhängen.
function toPromptText(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (!arr.length) return '';
  const m = arr[0];
  const base = baseline(arr);
  const bits = [];
  if (m.restingHr != null) bits.push('Ruhepuls ' + m.restingHr + ' bpm' + (base.rhr != null ? (' (Baseline ' + base.rhr + ')') : ''));
  if (m.hrv != null) bits.push('HRV/SDNN ' + m.hrv + ' ms' + (base.hrv != null ? (' (Schnitt ' + base.hrv + ')') : ''));
  if (m.sleepMin != null) bits.push('Schlaf letzte Nacht ' + Math.floor(m.sleepMin / 60) + 'h ' + (m.sleepMin % 60) + 'm' + (base.sleepMin != null ? (' (Schnitt ' + Math.floor(base.sleepMin / 60) + 'h ' + (base.sleepMin % 60) + 'm)') : ''));
  if (m.vo2max != null) bits.push('VO₂max ' + m.vo2max);
  if (m.steps != null) bits.push('Schritte zuletzt ' + m.steps);
  if (m.weightKg != null) bits.push('Gewicht ' + m.weightKg + ' kg');
  if (m.bodyFatPct != null) bits.push('Körperfett ' + m.bodyFatPct + ' %');
  const r = readiness(m, base);
  const L = [];
  L.push('Passive Vitalwerte von Apple Watch/Health' + (m.date ? (' (' + m.date + ')') : '') + ': ' + bits.join(', ') + '.');
  if (r && r.level && r.level !== 'kalibrierung') L.push('Erholungs-Ampel (passiv): ' + r.level.toUpperCase() + ' (Score ' + r.score + '/100).');
  else L.push('Erholungs-Baseline wird noch kalibriert (' + Math.max(base.rhrN, base.hrvN) + ' Vergleichstage).');
  const sd = sleepDetail(m);
  if (sd) {
    const seg = [];
    if (sd.deepMin != null) seg.push('Tief ' + sd.deepMin + ' min');
    if (sd.remMin != null) seg.push('REM ' + sd.remMin + ' min');
    if (sd.lightMin != null) seg.push('Leicht ' + sd.lightMin + ' min');
    if (sd.awakeMin != null) seg.push('Wach ' + sd.awakeMin + ' min');
    L.push('Schlaf-Score ' + sd.score + '/100' + (sd.efficiency != null ? (', Effizienz ' + sd.efficiency + ' %') : '') + (seg.length ? (' – Phasen: ' + seg.join(', ')) : ' (nur Gesamtdauer, keine Phasen)') + '.');
  }
  const t = trend(arr);
  if (t && t.since) {
    const tb = [];
    if (t.since.rhr) tb.push('Ruhepuls ' + (t.since.rhr > 0 ? '+' : '') + t.since.rhr + ' bpm');
    if (t.since.hrv) tb.push('HRV ' + (t.since.hrv > 0 ? '+' : '') + t.since.hrv + ' ms');
    if (tb.length) L.push('Veränderung seit gestern: ' + tb.join(', ') + '.');
  }
  L.push('Beziehe Schlaf und Erholung in deine Empfehlung zu Training & Intensität ein. Keine Diagnose; Auffälligkeiten sind Wellness-Signale.');
  return 'Vitalwerte aus Apple Health (vertraulich, vom Mitglied freigegeben):\n– ' + L.join('\n– ');
}

// ── KV-gebundene Operationen (No-Op ohne Store) ──
async function list(id) {
  if (!hasStore || id == null) return [];
  try {
    const [v] = await redisPipeline([['GET', VKEY(id)]]);
    if (!v) return [];
    const arr = (typeof v === 'string') ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function latest(list) { const arr = Array.isArray(list) ? list.filter(hasAny) : []; return arr[0] || null; }

// Tages-Schnappschuss speichern. Ein Eintrag pro Tag: gleiches Datum -> ersetzen
// (Apple Health liefert die aktuellsten Tageswerte). Neueste zuerst, gedeckelt.
async function add(id, snapshot, tsNow) {
  const m = sanitize(snapshot, tsNow);
  if (!hasAny(m)) return { ok: false, error: 'empty' };
  if (!hasStore || id == null) return { ok: true, saved: m, stored: false };
  try {
    const cur = await list(id);
    const rest = cur.filter((x) => x && x.date !== m.date);
    const next = [m].concat(rest).slice(0, CAP);
    await redisPipeline([['SET', VKEY(id), JSON.stringify(next), 'EX', String(TTL)]]);
    return { ok: true, saved: m, stored: true };
  } catch (e) { return { ok: false, error: 'store_failed' }; }
}

async function clear(id) {
  if (!hasStore || id == null) return { ok: true };
  try { await redisPipeline([['DEL', VKEY(id)]]); return { ok: true }; } catch (e) { return { ok: false }; }
}

module.exports = {
  VKEY, MIN_CALIB, BASE_WINDOW,
  sanitize, hasAny, baseline, readiness, sleepRef, sleepDetail, evaluate, trend, toPromptText,
  list, latest, add, clear,
};
