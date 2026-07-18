'use strict';

/**
 * Morgen-Check je Mitglied (Polar H9 Brustgurt) – Trainingsbereitschaft.
 * -------------------------------------------------------------------------
 * Das Mitglied verbindet morgens den H9 per Bluetooth und misst ~2–3 min ruhig.
 * Der Client leitet daraus Ruhepuls (RHR) und – wenn ein stabiler R-R-Stream
 * ankommt – HRV (RMSSD), optional Atemfrequenz und einen Orthostase-Test ab.
 * Hier werden die Werte datensparsam gespeichert, gegen die PERSÖNLICHE Baseline
 * bewertet (Ampel: grün/gelb/rot) und der Verlauf/Trend berechnet. Die
 * aufbereiteten Daten fließen in FINN (api/member/coach.js) und in die
 * FINN-Auswertung (lib/ai.coachMorningCheck).
 *
 * WICHTIG: Herz-/HRV-Werte sind Gesundheitsdaten (DSGVO Art. 9). Speicherung nur
 * mit ausdrücklicher Einwilligung (api/member/morning.js). Kein Medizinprodukt –
 * die Auswertung ist ein Wellness-Signal, KEINE Diagnose.
 *
 * Key:  morning:<memberId>   JSON-Array [{ ts, date, rhr, ... }] (neueste zuerst, gedeckelt).
 * Ohne KV-Store: sauberer No-Op (leere Liste). Jederzeit löschbar (DSGVO).
 */

const { redisPipeline, hasStore } = require('./store');

const MKEY = (id) => 'morning:' + String(id);
const TKEY = (id) => 'morning:tr:' + String(id);   // Trainings-Check-ins (getrennt von der Baseline)
const TTL = 400 * 24 * 3600;   // ~13 Monate, bei jedem Schreiben erneuert
const CAP = 180;               // höchstens so viele Morgen-Messungen behalten (~½ Jahr täglich)
const TCAP = 60;               // höchstens so viele Trainings-Check-ins behalten

const BASE_WINDOW = 10;        // so viele frühere Messungen fließen in die Baseline
const MIN_CALIB = 4;           // so viele Vergleichsmessungen braucht es für eine belastbare Baseline
const VP_PER_CHECK = 30;       // Vitalpunkte je Tag mit Morgen-Check
const SELF = ['schlecht', 'ok', 'gut'];
const STRESS = ['niedrig', 'mittel', 'hoch'];
const SORE = ['kein', 'leicht', 'stark'];

// ── Reine Logik (ohne KV – unit-testbar) ──

function num(v, lo, hi) {
  const n = Math.round(parseFloat(String(v).replace(',', '.')) * 100) / 100;
  if (!isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}
function isoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
function oneOf(v, allowed) { const s = String(v == null ? '' : v).trim().toLowerCase(); return allowed.indexOf(s) >= 0 ? s : ''; }
function str(v, max) { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : ''; }
function median(vals) {
  const a = (vals || []).filter((v) => v != null).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  const m = a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  return Math.round(m * 10) / 10;
}

// Rohe (vom BLE gelieferte oder nutzergelieferte) Werte auf ein sauberes Messobjekt abbilden.
function sanitize(input, tsHint) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    ts: (typeof tsHint === 'number' && tsHint > 0) ? tsHint : (parseInt(o.ts, 10) || 0),
    date: isoDate(o.date),
    rhr: num(o.rhr != null ? o.rhr : o.restingHr, 30, 130),
    hrvRmssd: num(o.hrvRmssd != null ? o.hrvRmssd : o.hrv, 3, 300),
    hrvSdnn: num(o.hrvSdnn != null ? o.hrvSdnn : o.sdnn, 2, 400),
    hrMin: num(o.hrMin, 25, 130),
    respRate: num(o.respRate, 4, 40),
    orthostaticDelta: num(o.orthostaticDelta != null ? o.orthostaticDelta : o.orthostatic, 0, 80),
    sleepSelf: oneOf(o.sleepSelf, SELF),
    moodSelf: oneOf(o.moodSelf, SELF),
    sleepHours: num(o.sleepHours, 0, 14),
    stressSelf: oneOf(o.stressSelf, STRESS),
    soreness: oneOf(o.soreness, SORE),
    sick: (o.sick === true || o.sick === 1 || o.sick === '1' || o.sick === 'ja') ? 1
      : (o.sick === false || o.sick === 0 || o.sick === '0' || o.sick === 'nein') ? 0 : null,
    kind: (o.kind === 'training') ? 'training' : 'morgen',
    note: str(o.note, 200),
  };
}

// true, wenn die Messung überhaupt verwertbare Kernwerte enthält.
function hasAny(m) { return !!(m && (m.rhr != null || m.hrvRmssd != null || m.respRate != null)); }

// ── Persönliche Baseline ──
// Referenz = Median der bis zu BASE_WINDOW vorherigen Messungen (OHNE die neueste,
// denn die wird gegen die Baseline bewertet). list ist neueste-zuerst.
function baseline(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  const prior = arr.slice(1, 1 + BASE_WINDOW);
  const rhrVals = prior.map((m) => m.rhr).filter((v) => v != null);
  const hrvVals = prior.map((m) => m.hrvRmssd).filter((v) => v != null);
  // Eine belastbare Baseline entsteht erst ab MIN_CALIB Vergleichsmessungen (je Kennzahl).
  const rhr = rhrVals.length >= MIN_CALIB ? median(rhrVals) : null;
  const hrv = hrvVals.length >= MIN_CALIB ? median(hrvVals) : null;
  return {
    rhr: rhr,
    hrv: hrv,
    rhrN: rhrVals.length,
    hrvN: hrvVals.length,
    calibrating: rhr == null && hrv == null,
    remaining: Math.max(0, MIN_CALIB - Math.max(rhrVals.length, hrvVals.length)),
  };
}

// Bewertung je Kennzahl – gegen die persönliche Baseline (Hybrid-Ansatz: RHR-Delta,
// HRV-Verhältnis). base aus baseline(list). -> [{ key, label, value, unit, cat, note, ref }]
function evaluate(m, base) {
  if (!m) return [];
  base = base || {};
  const out = [];
  const push = (key, label, value, unit, cat, note, ref) => { if (value != null) out.push({ key, label, value, unit, cat, note: note || '', ref: ref || '' }); };

  if (m.rhr != null) {
    if (base.rhr != null) {
      const d = Math.round((m.rhr - base.rhr) * 10) / 10;
      const cat = d <= 3 ? 'good' : d <= 6 ? 'warn' : 'bad';
      const note = d <= 3 ? (d <= -3 ? 'Niedriger als sonst – gut erholt.' : 'Im Bereich deiner persönlichen Baseline.')
        : d <= 6 ? 'Leicht erhöht – oft Schlafmangel, Stress oder Alkohol.'
          : 'Deutlich erhöht – dein Körper steht unter Last (Stress, zu wenig Schlaf oder beginnender Infekt).';
      push('rhr', 'Ruhepuls', m.rhr, ' bpm', cat, note, 'Deine Baseline ' + base.rhr + ' bpm');
    } else {
      const cat = m.rhr >= 100 ? 'warn' : 'info';
      push('rhr', 'Ruhepuls', m.rhr, ' bpm', cat, 'Kalibrierung läuft – noch keine persönliche Baseline.', '');
    }
  }
  if (m.hrvRmssd != null) {
    if (base.hrv != null) {
      const ratio = m.hrvRmssd / base.hrv;
      const cat = ratio >= 0.9 ? 'good' : ratio >= 0.75 ? 'warn' : 'bad';
      const note = ratio >= 0.9 ? 'Gute Erholung – dein Parasympathikus (Ruhenerv) ist aktiv.'
        : ratio >= 0.75 ? 'Unter deinem Schnitt – du bist noch nicht ganz erholt.'
          : 'Deutlich unter deinem Schnitt – dein Körper braucht heute eher Erholung.';
      push('hrv', 'HRV (RMSSD)', m.hrvRmssd, ' ms', cat, note, 'Dein Schnitt ' + base.hrv + ' ms · höher = erholter');
    } else {
      push('hrv', 'HRV (RMSSD)', m.hrvRmssd, ' ms', 'info', 'Kalibrierung läuft – die Baseline entsteht über mehrere Messungen.', '');
    }
  }
  if (m.hrvSdnn != null) {
    push('sdnn', 'HRV (SDNN)', m.hrvSdnn, ' ms', 'info', 'Gesamt-Variabilität deiner Herzschläge – ergänzt den RMSSD.', '');
  }
  if (m.respRate != null) {
    const cat = m.respRate <= 20 ? 'info' : 'warn';
    push('resp', 'Atemfrequenz', m.respRate, ' /min', cat, cat === 'info' ? 'Ruhige Atmung.' : 'Erhöhte Ruhe-Atemfrequenz – kann auf Belastung oder einen Infekt hindeuten.', 'Ruhe meist 12–20 /min');
  }
  if (m.orthostaticDelta != null) {
    const cat = m.orthostaticDelta <= 30 ? 'good' : 'warn';
    push('ortho', 'Orthostase (Δ Puls)', m.orthostaticDelta, ' bpm', cat, cat === 'good' ? 'Normale Kreislaufreaktion beim Aufstehen.' : 'Große Reaktion beim Aufstehen – oft Flüssigkeitsmangel oder Erschöpfung.', 'Normal ≤ 30 bpm');
  }
  return out;
}

// Deterministische Bereitschafts-Ampel (Fallback, wenn keine KI verfügbar ist).
// -> { level:'gruen'|'gelb'|'rot'|'kalibrierung', score:0–100|null, headline, hasBaseline, calibrating }
function readiness(m, base) {
  base = base || {};
  const hasB = base.rhr != null || base.hrv != null;
  if (!m || (m.rhr == null && m.hrvRmssd == null)) {
    return { level: 'kalibrierung', score: null, headline: 'Noch keine Messung', hasBaseline: hasB, calibrating: !hasB };
  }
  if (!hasB) {
    return { level: 'kalibrierung', score: null, headline: 'Kalibrierung läuft', hasBaseline: false, calibrating: true };
  }
  let score = 100;
  if (base.rhr != null && m.rhr != null) {
    const d = m.rhr - base.rhr;
    if (d > 2) score -= Math.min(45, (d - 2) * 7);
    if (d < -8) score -= Math.min(15, (-d - 8) * 2);   // ungewöhnlich niedrig kann Übermüdung sein
  }
  if (base.hrv != null && m.hrvRmssd != null) {
    const ratio = m.hrvRmssd / base.hrv;
    if (ratio < 1) score -= Math.min(45, (1 - ratio) * 70);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 75 ? 'gruen' : score >= 55 ? 'gelb' : 'rot';
  const headline = level === 'gruen' ? 'Bereit für Vollgas' : level === 'gelb' ? 'Moderat starten' : 'Heute auf Erholung setzen';
  return { level: level, score: score, headline: headline, hasBaseline: true, calibrating: false };
}

// Trainings-Bereitschaft JETZT (kurzer Puls-Check direkt vorm Workout) – gegen die
// MORGEN-Baseline. Nutzt dieselbe Ampel-Logik wie readiness(), aber trainingsbezogene
// Worte. base kommt aus baseline(morgenListe). -> { level, score, headline, advice, hasBaseline }
function trainReadiness(m, base) {
  base = base || {};
  const hasB = base.rhr != null || base.hrv != null;
  const r = readiness(m, base);
  if (!hasB || r.level === 'kalibrierung') {
    return { level: 'kalibrierung', score: null, headline: 'Noch keine Baseline', advice: 'Mach zuerst ein paar Morgen-Check-ins – dann kann der Trainings-Check-in deinen Puls einordnen.', hasBaseline: hasB };
  }
  const headline = r.level === 'gruen' ? 'Bereit fürs Training' : r.level === 'gelb' ? 'Locker rangehen' : 'Heute besser regenerieren';
  const advice = r.level === 'gruen' ? 'Dein Puls liegt im Bereich deiner Baseline – du kannst voll durchstarten.'
    : r.level === 'gelb' ? 'Etwas über deiner Baseline – halt die Intensität heute moderat, kein Maximalreiz.'
      : 'Deutlich über deiner Baseline – dein Körper ist noch nicht bereit. Heute lieber locker oder Pause.';
  return { level: r.level, score: r.score, headline: headline, advice: advice, hasBaseline: true };
}

// Vegetative Balance „Anspannung ↔ Regeneration" (0 = stark sympathisch/angespannt,
// 100 = stark parasympathisch/erholt). Aus HRV-Verhältnis (Parasympathikus) + RHR-Abweichung
// (Sympathikus) gegen die persönliche Baseline. -> { value, level, label, hasBaseline } | null.
function balance(m, base) {
  base = base || {};
  if (!m || (m.rhr == null && m.hrvRmssd == null)) return null;
  if (base.rhr == null && base.hrv == null) return { value: null, level: 'kalibrierung', label: 'Kalibrierung', hasBaseline: false };
  let hrvComp = null, rhrComp = null;
  if (base.hrv != null && m.hrvRmssd != null) {
    const ratio = m.hrvRmssd / base.hrv;                       // < 1 = weniger HRV = angespannter
    hrvComp = Math.max(0, Math.min(100, Math.round((ratio - 0.6) / (1.3 - 0.6) * 100)));
  }
  if (base.rhr != null && m.rhr != null) {
    const d = m.rhr - base.rhr;                                // höher = angespannter
    rhrComp = Math.max(0, Math.min(100, Math.round((12 - d) / 18 * 100)));
  }
  let value;
  if (hrvComp != null && rhrComp != null) value = Math.round(0.6 * hrvComp + 0.4 * rhrComp);
  else value = (hrvComp != null) ? hrvComp : rhrComp;
  const level = value >= 66 ? 'regeneration' : value >= 34 ? 'ausgeglichen' : 'anspannung';
  const label = level === 'regeneration' ? 'Erholt · Regeneration' : level === 'ausgeglichen' ? 'Ausgeglichen' : 'Angespannt · Belastung';
  return { value: value, level: level, label: label, hasBaseline: true };
}

// HRV-Fitnessalter (grobe Orientierung, KEIN medizinischer Wert): erwarteter RMSSD
// ~42 ms mit 40 J., ~-0,5 ms/Jahr. Nutzt die stabile Baseline-HRV, sonst die Tagesmessung.
// -> { age, actualAge, delta, rmssd, calibrated } | null.
function hrvAge(m, actualAge, base) {
  base = base || {};
  const rmssd = (base.hrv != null) ? base.hrv : (m && m.hrvRmssd != null ? m.hrvRmssd : null);
  if (rmssd == null) return null;
  let age = Math.round(40 + (42 - rmssd) * 2);
  age = Math.max(18, Math.min(90, age));
  const actual = (actualAge != null && actualAge > 0) ? Math.round(actualAge) : null;
  return { age: age, actualAge: actual, delta: (actual != null ? age - actual : null), rmssd: rmssd, calibrated: base.hrv != null };
}

// Subjektive Signale aus dem Morgen-Fragebogen (Whoop-Journal-Stil). Kappen die
// Belastungs-Empfehlung nach unten, überschreiben aber NICHT die Physiologie (RHR/HRV).
// -> { any, notes:[..], cap:'ruhe'|'moderat'|null }
function subjectiveFlags(m) {
  if (!m) return { any: false, notes: [], cap: null };
  const notes = []; let cap = null;
  if (m.sick === 1) { notes.push('fühlt sich angeschlagen'); cap = 'ruhe'; }
  if (m.soreness === 'stark') { notes.push('starker Muskelkater'); if (cap !== 'ruhe') cap = 'moderat'; }
  if (m.sleepSelf === 'schlecht') { notes.push('schlecht geschlafen'); if (cap == null) cap = 'moderat'; }
  if (m.stressSelf === 'hoch') { notes.push('hoher Stress'); if (cap == null) cap = 'moderat'; }
  return { any: notes.length > 0, notes: notes, cap: cap };
}

// Belastungssteuerung: konkrete Trainings-Empfehlung aus der Ampel, nach unten
// gekappt durch subjektive Signale (m optional). -> { key, title, detail }.
function trainingLoad(r, m) {
  r = r || {};
  let base;
  if (!r.level || r.level === 'kalibrierung') base = { key: 'kalibrierung', title: 'Baseline wird kalibriert', detail: 'Miss ein paar Tage – dann gibt es eine klare Belastungs-Empfehlung.' };
  else if (r.level === 'gruen') base = { key: 'voll', title: 'Volle Belastung möglich', detail: 'Dein System ist erholt – heute darfst du intensiv/hart trainieren.' };
  else if (r.level === 'gelb') base = { key: 'moderat', title: 'Moderat trainieren', detail: 'Teilweise erholt – heute locker bis mittel, kein Maximalreiz.' };
  else base = { key: 'ruhe', title: 'Regeneration heute', detail: 'Dein Körper steht unter Last – heute Ruhetag, Spaziergang oder lockeres Cardio.' };
  if (base.key === 'kalibrierung') return base;
  const f = subjectiveFlags(m);
  const rank = { ruhe: 0, moderat: 1, voll: 2 };
  if (f.cap && rank[f.cap] < rank[base.key]) {
    if (f.cap === 'ruhe') return { key: 'ruhe', title: 'Regeneration heute', detail: 'Deine Herzwerte wären ok, aber du fühlst dich angeschlagen – heute Ruhetag und auf dich hören.' };
    return { key: 'moderat', title: 'Heute moderat', detail: 'Deine Herzwerte wären besser, aber ' + f.notes.join(', ') + ' – heute lieber locker bis mittel.' };
  }
  return base;
}

// Whoop-artige Muster-Erkenntnisse: verknüpft die Fragebogen-Antworten mit den
// gemessenen Werten über die Zeit. Braucht genug Daten. -> [String].
function insights(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (arr.length < 8) return [];
  const avg = (sub, f) => { const v = sub.map((m) => m[f]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const out = [];
  const goodSleep = arr.filter((m) => m.sleepSelf === 'gut');
  const badSleep = arr.filter((m) => m.sleepSelf === 'schlecht');
  if (goodSleep.length >= 3 && badSleep.length >= 3) {
    const rG = avg(goodSleep, 'rhr'), rB = avg(badSleep, 'rhr');
    if (rG != null && rB != null) { const d = Math.round((rB - rG) * 10) / 10; if (Math.abs(d) >= 1) out.push('An Tagen mit gutem Schlaf ist dein Ruhepuls im Schnitt ' + Math.abs(d) + ' bpm ' + (d > 0 ? 'niedriger' : 'höher') + ' als nach schlechtem Schlaf.'); }
    const hG = avg(goodSleep, 'hrvRmssd'), hB = avg(badSleep, 'hrvRmssd');
    if (hG != null && hB != null) { const dh = Math.round(hG - hB); if (Math.abs(dh) >= 2) out.push('Nach gutem Schlaf ist deine HRV im Schnitt ' + Math.abs(dh) + ' ms ' + (dh > 0 ? 'höher' : 'niedriger') + ' – ein Zeichen besserer Erholung.'); }
  }
  const lowS = arr.filter((m) => m.stressSelf === 'niedrig');
  const hiS = arr.filter((m) => m.stressSelf === 'hoch');
  if (lowS.length >= 3 && hiS.length >= 3) {
    const rL = avg(lowS, 'rhr'), rH = avg(hiS, 'rhr');
    if (rL != null && rH != null) { const ds = Math.round((rH - rL) * 10) / 10; if (Math.abs(ds) >= 1) out.push('An Tagen mit wenig Stress ist dein Ruhepuls im Schnitt ' + Math.abs(ds) + ' bpm niedriger.'); }
  }
  return out.slice(0, 3);
}

// Verlauf/Trend: Deltas der neuesten Messung zur vorherigen und zur ersten.
// list = neueste zuerst. -> null bei <2 Messungen.
function trend(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (arr.length < 2) return null;
  const cur = arr[0], prev = arr[1], first = arr[arr.length - 1];
  const KEYS = ['rhr', 'hrvRmssd', 'hrvSdnn', 'respRate', 'orthostaticDelta'];
  const diff = (a, b) => { if (a == null || b == null) return null; return Math.round((a - b) * 100) / 100; };
  const build = (o) => { const d = {}; KEYS.forEach((k) => { d[k] = diff(cur[k], o[k]); }); return d; };
  return { count: arr.length, sincePrev: build(prev), sinceFirst: build(first), prevDate: prev.date, firstDate: first.date };
}

// Vitalpunkte-Ledger: +VP_PER_CHECK je Tag mit Morgen-Check (Dedup nach Datum).
function vpLedger(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  const seen = {}; const out = [];
  arr.forEach((m) => { const d = m.date || ''; if (!d || seen[d]) return; seen[d] = true; out.push({ date: d, pts: VP_PER_CHECK, reason: 'Morgen-Check' }); });
  return out;
}

// Kompakter Kontext-Block für FINNs System-Prompt (vertraulich). Leerer String, wenn nichts da.
function toPromptText(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (!arr.length) return '';
  const m = arr[0];
  const base = baseline(arr);
  const bits = [];
  if (m.rhr != null) bits.push('Ruhepuls ' + m.rhr + ' bpm' + (base.rhr != null ? (' (Baseline ' + base.rhr + ')') : ''));
  if (m.hrvRmssd != null) bits.push('HRV/RMSSD ' + m.hrvRmssd + ' ms' + (base.hrv != null ? (' (Schnitt ' + base.hrv + ')') : ''));
  if (m.hrvSdnn != null) bits.push('SDNN ' + m.hrvSdnn + ' ms');
  if (m.respRate != null) bits.push('Atemfrequenz ' + m.respRate + '/min');
  if (m.orthostaticDelta != null) bits.push('Orthostase Δ ' + m.orthostaticDelta + ' bpm');
  if (m.sleepSelf) bits.push('Schlaf (Selbstauskunft) ' + m.sleepSelf + (m.sleepHours != null ? (', ' + m.sleepHours + ' h') : ''));
  if (m.moodSelf) bits.push('Energie/Befinden ' + m.moodSelf);
  if (m.stressSelf) bits.push('Stress ' + m.stressSelf);
  if (m.soreness && m.soreness !== 'kein') bits.push('Muskelkater ' + m.soreness);
  if (m.sick === 1) bits.push('fühlt sich angeschlagen/krank');
  const r = readiness(m, base);
  const L = [];
  L.push('Morgen-Check (Polar H9)' + (m.date ? (' vom ' + m.date) : '') + ': ' + bits.join(', ') + '.');
  if (r && r.level && r.level !== 'kalibrierung') L.push('Bereitschafts-Ampel: ' + r.level.toUpperCase() + ' (Score ' + r.score + '/100).');
  else L.push('Persönliche Baseline wird noch kalibriert (' + base.rhrN + ' Vergleichsmessungen).');
  const bal = balance(m, base);
  if (bal && bal.value != null) L.push('Vegetative Balance Anspannung↔Regeneration: ' + bal.value + '/100 (' + bal.label + ') – niedrig = sympathisch/angespannt, hoch = parasympathisch/erholt.');
  const t = trend(arr);
  if (t && t.sincePrev) {
    const s = t.sincePrev; const tb = [];
    const fmt = (v, u) => (v == null || v === 0) ? '' : ((v > 0 ? '+' : '') + v + u);
    if (s.rhr) tb.push('Ruhepuls ' + fmt(s.rhr, ' bpm'));
    if (s.hrvRmssd) tb.push('HRV ' + fmt(s.hrvRmssd, ' ms'));
    if (tb.filter(Boolean).length) L.push('Veränderung seit der letzten Messung' + (t.prevDate ? (' (' + t.prevDate + ')') : '') + ': ' + tb.filter(Boolean).join(', ') + '.');
  }
  L.push('Nutze das für eine sichere, alltagstaugliche Empfehlung zur Trainingsbereitschaft. Stelle KEINE Diagnose; werte Auffälligkeiten als Wellness-Signal und verweise bei anhaltenden Beschwerden auf ärztlichen Rat bzw. die Trainer:innen vor Ort.');
  return 'Morgen-Check (vertraulich, vom Mitglied freigegeben):\n– ' + L.join('\n– ');
}

// ── KV-gebundene Operationen (No-Op ohne Store) ──

async function list(id) {
  if (!hasStore || id == null) return [];
  try {
    const [v] = await redisPipeline([['GET', MKEY(id)]]);
    if (!v) return [];
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map((m) => sanitize(m, m && m.ts)).filter(hasAny) : [];
  } catch (e) { return []; }
}

async function add(id, measurement, tsNow) {
  const m = sanitize(measurement, tsNow);
  if (!hasAny(m)) return { ok: false, error: 'empty', list: await list(id) };
  if (!hasStore || id == null) return { ok: true, list: [m], saved: false };
  try {
    const arr = await list(id);
    // Dedup nach Datum: gleiche Messung (gleicher Tag) ersetzen.
    const filtered = m.date ? arr.filter((x) => x.date !== m.date) : arr;
    filtered.unshift(m);
    filtered.sort((a, b) => {
      const da = a.date || '', db = b.date || '';
      if (da && db && da !== db) return da < db ? 1 : -1;
      return (b.ts || 0) - (a.ts || 0);
    });
    const trimmed = filtered.slice(0, CAP);
    await redisPipeline([['SET', MKEY(id), JSON.stringify(trimmed), 'EX', String(TTL)]]);
    return { ok: true, list: trimmed, saved: true };
  } catch (e) { return { ok: false, error: 'save_failed', list: await list(id) }; }
}

// Eine Messung entfernen (per date oder ts).
async function remove(id, sel) {
  if (!hasStore || id == null) return { ok: true, list: [] };
  try {
    const arr = await list(id);
    const s = String(sel || '');
    const filtered = arr.filter((x) => (x.date || '') !== s && String(x.ts || '') !== s);
    await redisPipeline([['SET', MKEY(id), JSON.stringify(filtered), 'EX', String(TTL)]]);
    return { ok: true, list: filtered };
  } catch (e) { return { ok: false, error: 'del_failed', list: await list(id) }; }
}

async function clear(id) {
  if (!hasStore || id == null) return { ok: true };
  try { await redisPipeline([['DEL', MKEY(id)]]); return { ok: true }; } catch (e) { return { ok: false }; }
}

// ── Trainings-Check-ins (kurzer Puls-Check vorm Workout) ──
// Eigener Schlüssel: diese Messungen fließen bewusst NICHT in die Morgen-Baseline ein
// (andere Tageszeit/Umstände). Mehrere pro Tag erlaubt (kein Datums-Dedup).
async function trList(id) {
  if (!hasStore || id == null) return [];
  try {
    const [v] = await redisPipeline([['GET', TKEY(id)]]);
    if (!v) return [];
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.map((m) => sanitize(m, m && m.ts)).filter(hasAny) : [];
  } catch (e) { return []; }
}

async function trAdd(id, measurement, tsNow) {
  const m = sanitize(Object.assign({}, measurement, { kind: 'training' }), tsNow);
  if (!hasAny(m)) return { ok: false, error: 'empty', list: await trList(id) };
  if (!hasStore || id == null) return { ok: true, list: [m], saved: false };
  try {
    const arr = await trList(id);
    arr.unshift(m);
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const trimmed = arr.slice(0, TCAP);
    await redisPipeline([['SET', TKEY(id), JSON.stringify(trimmed), 'EX', String(TTL)]]);
    return { ok: true, list: trimmed, saved: true };
  } catch (e) { return { ok: false, error: 'save_failed', list: await trList(id) }; }
}

async function trRemove(id, sel) {
  if (!hasStore || id == null) return { ok: true, list: [] };
  try {
    const arr = await trList(id);
    const s = String(sel || '');
    const filtered = arr.filter((x) => String(x.ts || '') !== s && (x.date || '') !== s);
    await redisPipeline([['SET', TKEY(id), JSON.stringify(filtered), 'EX', String(TTL)]]);
    return { ok: true, list: filtered };
  } catch (e) { return { ok: false, error: 'del_failed', list: await trList(id) }; }
}

async function trClear(id) {
  if (!hasStore || id == null) return { ok: true };
  try { await redisPipeline([['DEL', TKEY(id)]]); return { ok: true }; } catch (e) { return { ok: false }; }
}

// ── Einwilligung (DSGVO Art. 9) – eigener Schlüssel, ohne Kopplung an memberProfile ──
const CKEY = (id) => 'morning:consent:' + String(id);

async function getConsent(id) {
  if (!hasStore || id == null) return false;
  try { const [v] = await redisPipeline([['GET', CKEY(id)]]); return v === '1' || v === 1; } catch (e) { return false; }
}

// on=true: Einwilligung setzen. on=false: Einwilligung UND alle Messwerte löschen (Widerruf = Datenlöschung).
async function setConsent(id, on) {
  if (!hasStore || id == null) return { ok: true, consent: !!on };
  try {
    if (on) { await redisPipeline([['SET', CKEY(id), '1']]); }
    else { await redisPipeline([['DEL', CKEY(id)], ['DEL', MKEY(id)], ['DEL', TKEY(id)]]); }
    return { ok: true, consent: !!on };
  } catch (e) { return { ok: false, consent: await getConsent(id) }; }
}

module.exports = {
  MKEY, TKEY, MIN_CALIB, VP_PER_CHECK,
  sanitize, hasAny, baseline, evaluate, readiness, trainReadiness, balance, hrvAge, subjectiveFlags, trainingLoad, insights, trend, vpLedger, toPromptText,
  list, add, remove, clear, trList, trAdd, trRemove, trClear, getConsent, setConsent,
};
