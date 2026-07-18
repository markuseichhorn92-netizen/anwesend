'use strict';

/**
 * InBody-Körperanalyse (Gerät InBody 270) je Mitglied – Erfolgskontrolle.
 * -------------------------------------------------------------------------
 * Das Mitglied fotografiert seinen InBody-Ergebnisbogen; die KI liest die Werte
 * aus (lib/ai.scanInbody). Hier werden die Messungen datensparsam gespeichert,
 * bewertet (Kategorien mit gesunden Bereichen) und der Verlauf/Trend berechnet.
 * Die aufbereiteten Daten fließen in FINNs Kontext (api/member/coach.js) und ins
 * Vitalalter ein.
 *
 * Key:  inbody:<memberId>  JSON-Array [{ ts, date, ...werte }] (neueste zuerst, gedeckelt).
 * Ohne KV-Store: sauberer No-Op (leere Liste). Jederzeit löschbar (DSGVO).
 */

const { redisPipeline, hasStore } = require('./store');

const MKEY = (id) => 'inbody:' + String(id);
const TTL = 500 * 24 * 3600;   // ~16 Monate, bei jedem Schreiben erneuert
const CAP = 30;                // höchstens so viele Messungen behalten

// ── Reine Logik (ohne KV – unit-testbar) ──

function num(v, lo, hi) {
  const n = Math.round(parseFloat(String(v).replace(',', '.')) * 100) / 100;
  if (!isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}
function isoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }

// Rohe (KI- oder nutzergelieferte) Werte auf ein sauberes Messobjekt abbilden.
function sanitize(input, tsHint) {
  const o = input && typeof input === 'object' ? input : {};
  const sex = (o.sex === 'm' || o.sex === 'w' || o.sex === 'd') ? o.sex : '';
  return {
    ts: (typeof tsHint === 'number' && tsHint > 0) ? tsHint : (parseInt(o.ts, 10) || 0),
    date: isoDate(o.date),
    sex: sex,
    weightKg: num(o.weight != null ? o.weight : o.weightKg, 25, 350),
    heightCm: num(o.height != null ? o.height : o.heightCm, 100, 250),
    age: num(o.age, 10, 120),
    tbwL: num(o.tbw != null ? o.tbw : o.tbwL, 10, 120),
    proteinKg: num(o.protein != null ? o.protein : o.proteinKg, 2, 40),
    mineralKg: num(o.mineral != null ? o.mineral : o.mineralKg, 0.3, 8),
    bfmKg: num(o.bfm != null ? o.bfm : o.bfmKg, 0.5, 200),
    smmKg: num(o.smm != null ? o.smm : o.smmKg, 4, 80),
    ffmKg: num(o.ffm != null ? o.ffm : o.ffmKg, 12, 200),
    pbf: num(o.pbf, 2, 75),
    bmi: num(o.bmi, 8, 80),
    whr: num(o.whr, 0.4, 1.6),
    vfl: num(o.vfl, 1, 40),
    bmr: num(o.bmr, 500, 4000),
    score: num(o.score, 0, 100),
    targetWeightKg: num(o.targetWeight != null ? o.targetWeight : o.targetWeightKg, 25, 350),
    recommendedKcal: num(o.recommendedKcal, 600, 6000),
  };
}

// true, wenn die Messung überhaupt verwertbare Kernwerte enthält.
function hasAny(m) {
  if (!m) return false;
  return !!(m.weightKg || m.pbf || m.smmKg || m.bmi || m.score || m.vfl);
}

// Bewertung je Kennzahl (gesunde Bereiche). sex bevorzugt aus der Messung, sonst Fallback.
// -> [{ key, label, value, unit, cat: 'good'|'warn'|'bad'|'info', note }]
function evaluate(m, fallbackSex) {
  if (!m) return [];
  const sex = m.sex || (fallbackSex === 'm' || fallbackSex === 'w' ? fallbackSex : 'w');
  const out = [];
  const push = (key, label, value, unit, cat, note) => { if (value != null) out.push({ key, label, value, unit, cat, note: note || '' }); };

  if (m.score != null) {
    const s = m.score;
    const cat = s >= 90 ? 'good' : s >= 80 ? 'good' : s >= 70 ? 'warn' : 'bad';
    const note = s >= 90 ? 'Top – sehr muskulös/ausgewogen.' : s >= 80 ? 'Sehr gut.' : s >= 70 ? 'Guter Bereich.' : 'Noch Luft nach oben – dranbleiben lohnt sich.';
    push('score', 'InBody-Score', s, ' / 100', cat, note);
  }
  if (m.pbf != null) {
    // Gesunde Fitness-Bereiche (Richtwerte): Frauen ~18–28 %, Männer ~10–20 %.
    const lo = sex === 'm' ? 10 : 18, hi = sex === 'm' ? 20 : 28;
    const cat = m.pbf < lo ? 'warn' : m.pbf <= hi ? 'good' : (m.pbf <= hi + 7 ? 'warn' : 'bad');
    const note = m.pbf < lo ? 'Sehr niedrig – auf ausreichend Energie & Muskeln achten.' : m.pbf <= hi ? 'Im gesunden Bereich.' : 'Über dem Richtwert – Fettabbau bringt am meisten.';
    push('pbf', 'Körperfettanteil', m.pbf, ' %', cat, note + ' (Richtwert ' + lo + '–' + hi + ' %)');
  }
  if (m.smmKg != null) push('smm', 'Skelettmuskelmasse', m.smmKg, ' kg', 'info', 'Je mehr, desto besser für Stoffwechsel & Kraft – Ziel: halten/steigern.');
  if (m.vfl != null) {
    const cat = m.vfl < 10 ? 'good' : m.vfl <= 14 ? 'warn' : 'bad';
    const note = m.vfl < 10 ? 'Im gesunden Bereich.' : m.vfl <= 14 ? 'Leicht erhöht – im Blick behalten.' : 'Erhöht – Bauchfett gezielt reduzieren (Herz-Kreislauf-Gesundheit).';
    push('vfl', 'Viszerales Fett-Level', m.vfl, '', cat, note);
  }
  if (m.whr != null) {
    const hi = sex === 'm' ? 0.9 : 0.85;
    const cat = m.whr <= hi ? 'good' : 'warn';
    push('whr', 'Taille-Hüft-Verhältnis', m.whr, '', cat, m.whr <= hi ? 'Im gesunden Bereich.' : 'Über dem Richtwert (' + hi + ') – Bauchumfang reduzieren.');
  }
  if (m.bmi != null) {
    const cat = m.bmi < 18.5 ? 'warn' : m.bmi < 25 ? 'good' : m.bmi < 30 ? 'warn' : 'bad';
    push('bmi', 'BMI', m.bmi, ' kg/m²', cat, 'Bei viel Muskelmasse kann der BMI hoch sein, ohne dass Fett das Problem ist.');
  }
  if (m.bmr != null) push('bmr', 'Grundumsatz', m.bmr, ' kcal', 'info', 'Kalorien, die dein Körper in Ruhe verbraucht – Basis für dein Kalorienziel.');
  return out;
}

// Verlauf/Trend: Deltas der neuesten Messung zur vorherigen und zur ersten.
// list = neueste zuerst. -> null bei <2 Messungen, sonst { count, sincePrev:{...}, sinceFirst:{...}, prevDate, firstDate }.
function trend(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (arr.length < 2) return null;
  const cur = arr[0], prev = arr[1], first = arr[arr.length - 1];
  const KEYS = ['weightKg', 'pbf', 'bfmKg', 'smmKg', 'vfl', 'score', 'whr'];
  const diff = (a, b) => { if (a == null || b == null) return null; return Math.round((a - b) * 100) / 100; };
  const build = (o) => { const d = {}; KEYS.forEach((k) => { d[k] = diff(cur[k], o[k]); }); return d; };
  return { count: arr.length, sincePrev: build(prev), sinceFirst: build(first), prevDate: prev.date, firstDate: first.date };
}

// Kompakter Kontext-Block für FINNs System-Prompt (vertraulich). Leerer String, wenn nichts da.
function toPromptText(list, fallbackSex) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (!arr.length) return '';
  const m = arr[0];
  const L = [];
  const bits = [];
  if (m.weightKg != null) bits.push('Gewicht ' + m.weightKg + ' kg');
  if (m.pbf != null) bits.push('Körperfett ' + m.pbf + ' %');
  if (m.smmKg != null) bits.push('Skelettmuskelmasse ' + m.smmKg + ' kg');
  if (m.vfl != null) bits.push('viszerales Fett-Level ' + m.vfl);
  if (m.bmi != null) bits.push('BMI ' + m.bmi);
  if (m.whr != null) bits.push('WHR ' + m.whr);
  if (m.bmr != null) bits.push('Grundumsatz ' + m.bmr + ' kcal');
  if (m.score != null) bits.push('InBody-Score ' + m.score + '/100');
  L.push('InBody-Körperanalyse (InBody 270)' + (m.date ? ' vom ' + m.date : '') + ': ' + bits.join(', ') + '.');
  const t = trend(arr);
  if (t) {
    const s = t.sincePrev; const tb = [];
    const fmt = (v, unit, up) => (v == null || v === 0) ? '' : ((v > 0 ? '+' : '') + v + unit);
    if (s.pbf) tb.push('Körperfett ' + fmt(s.pbf, ' %'));
    if (s.smmKg) tb.push('Muskelmasse ' + fmt(s.smmKg, ' kg'));
    if (s.weightKg) tb.push('Gewicht ' + fmt(s.weightKg, ' kg'));
    if (s.vfl) tb.push('viszerales Fett ' + fmt(s.vfl, ''));
    if (tb.filter(Boolean).length) L.push('Veränderung seit der letzten Messung' + (t.prevDate ? ' (' + t.prevDate + ')' : '') + ': ' + tb.filter(Boolean).join(', ') + '.');
  }
  L.push('Nutze das für fundierte, sichere Empfehlungen (z. B. Muskelaufbau vs. Fettabbau). Stelle KEINE medizinischen Diagnosen; verweise bei Auffälligkeiten auf ärztlichen Rat bzw. die Trainer:innen vor Ort.');
  return 'InBody-Analyse (vertraulich, vom Mitglied freigegeben):\n– ' + L.join('\n– ');
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

module.exports = { MKEY, sanitize, hasAny, evaluate, trend, toPromptText, list, add, remove, clear };
