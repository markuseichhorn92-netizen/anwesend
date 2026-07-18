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
    // Segmentale Mageranalyse: Magermasse je Segment (kg) + optional das auf dem
    // Bogen gedruckte Prozent-vom-Ideal (Unter/Normal/Über). RA/LA = Arme, TR = Rumpf, RL/LL = Beine.
    leanRAkg: num(o.leanRA != null ? o.leanRA : o.leanRAkg, 0.3, 15),
    leanLAkg: num(o.leanLA != null ? o.leanLA : o.leanLAkg, 0.3, 15),
    leanTRkg: num(o.leanTR != null ? o.leanTR : o.leanTRkg, 5, 45),
    leanRLkg: num(o.leanRL != null ? o.leanRL : o.leanRLkg, 1, 25),
    leanLLkg: num(o.leanLL != null ? o.leanLL : o.leanLLkg, 1, 25),
    pctRA: num(o.pctRA, 30, 250),
    pctLA: num(o.pctLA, 30, 250),
    pctTR: num(o.pctTR, 30, 250),
    pctRL: num(o.pctRL, 30, 250),
    pctLL: num(o.pctLL, 30, 250),
    // Skelettmuskel-Index: SMI (kg/m²) bzw. appendikuläre Magermasse ASM (kg, Summe der 4 Gliedmaßen).
    smi: num(o.smi, 3, 15),
    asmKg: num(o.asm != null ? o.asm : o.asmKg, 8, 60),
    // Ödem-/Entzündungsindex ECW/TBW (Extrazellular- zu Gesamtkörperwasser).
    ecwtbw: num(o.ecwtbw != null ? o.ecwtbw : o.ecwTbw, 0.3, 0.5),
  };
}

// SMI aus vorhandenen Werten ableiten, wenn nicht direkt gedruckt: ASM/Größe².
// ASM = Summe der vier Gliedmaßen-Magermasse, falls nicht separat vorhanden.
function deriveSmi(m) {
  if (!m) return null;
  if (m.smi != null) return m.smi;
  let asm = m.asmKg;
  if (asm == null) {
    const limbs = [m.leanRAkg, m.leanLAkg, m.leanRLkg, m.leanLLkg];
    if (limbs.every((v) => v != null)) asm = limbs.reduce((a, b) => a + b, 0);
  }
  if (asm == null || !m.heightCm) return null;
  const hm = m.heightCm / 100;
  const smi = Math.round((asm / (hm * hm)) * 100) / 100;
  return (smi >= 3 && smi <= 15) ? smi : null;
}

// true, wenn die Messung überhaupt verwertbare Kernwerte enthält.
function hasAny(m) {
  if (!m) return false;
  return !!(m.weightKg || m.pbf || m.smmKg || m.bmi || m.score || m.vfl);
}

// ── Referenz-Bänder (alters- + geschlechtsspezifisch, „Hybrid"-Ansatz) ──
// Sex normalisieren: InBody druckt m/w; wir behandeln 'm' als männlich, alles andere weiblich.
function normSex(sex, fallback) {
  if (sex === 'm' || sex === 'w' || sex === 'd') return sex === 'd' ? (fallback === 'm' ? 'm' : 'w') : sex;
  return (fallback === 'm') ? 'm' : 'w';
}
function ageBandLabel(age) { return age == null ? '' : (age < 40 ? '20–39' : age < 60 ? '40–59' : '60+'); }

// Körperfett-% nach Gallagher (2000), alters- + geschlechtsspezifisch.
// -> { lo: Ideal-Untergrenze, idealHi: Ideal-Obergrenze, overHi: Overfat-Obergrenze, aged }.
// Ohne Alter: Rückfall auf InBodys feste Geschlechts-Bänder (M 10–20, F 18–28).
function pbfBands(sex, age) {
  const m = sex === 'm';
  if (age == null || age <= 0) return m ? { lo: 10, idealHi: 20, overHi: 25, aged: false } : { lo: 18, idealHi: 28, overHi: 33, aged: false };
  if (m) {
    if (age < 40) return { lo: 8, idealHi: 19, overHi: 25, aged: true };
    if (age < 60) return { lo: 11, idealHi: 21, overHi: 28, aged: true };
    return { lo: 13, idealHi: 24, overHi: 30, aged: true };
  }
  if (age < 40) return { lo: 21, idealHi: 33, overHi: 39, aged: true };
  if (age < 60) return { lo: 23, idealHi: 34, overHi: 40, aged: true };
  return { lo: 24, idealHi: 35, overHi: 42, aged: true };
}

// SMI (kg/m²): klinische Untergrenze (EWGSOP2, fix) + „typischer" Bereich nach Alter/Geschlecht.
function smiRef(sex, age) {
  const m = sex === 'm';
  const a = (age != null && age > 0) ? age : 40;
  const low = m ? 7.0 : 5.5;   // < = wenig Muskelmasse (Sarkopenie-Bereich)
  let typLo;
  if (m) typLo = a < 40 ? 8.5 : a < 60 ? 8.0 : 7.3;
  else typLo = a < 40 ? 6.4 : a < 60 ? 6.1 : 5.7;
  return { low: low, typLo: typLo };
}

// Bewertung je Kennzahl – alters- + geschlechtsspezifisch (Hybrid: Gallagher-Fett,
// EWGSOP2/Perzentil-SMI, InBody-Bänder für Viszeralfett/BMI). sex/age bevorzugt aus
// der Messung, sonst Fallback (Profil).
// -> [{ key, label, value, unit, cat: 'good'|'warn'|'bad'|'info', note, ref }]
function evaluate(m, fallbackSex, fallbackAge) {
  if (!m) return [];
  const sex = normSex(m.sex, fallbackSex);
  const age = (m.age != null && m.age > 0) ? m.age : ((fallbackAge != null && fallbackAge > 0) ? fallbackAge : null);
  const sexLabel = sex === 'm' ? 'Männer' : 'Frauen';
  const ab = ageBandLabel(age);
  const forWhom = sexLabel + (ab ? (' ' + ab) : '');
  const out = [];
  const push = (key, label, value, unit, cat, note, ref) => { if (value != null) out.push({ key, label, value, unit, cat, note: note || '', ref: ref || '' }); };

  if (m.score != null) {
    const s = m.score;
    const cat = s >= 70 ? 'good' : s >= 60 ? 'warn' : 'bad';
    const note = s >= 90 ? 'Top – sehr muskulös/ausgewogen.' : s >= 80 ? 'Sehr gut.' : s >= 70 ? 'Guter, normaler Bereich.' : s >= 60 ? 'Etwas unter dem Schnitt – dranbleiben lohnt sich.' : 'Noch viel Luft nach oben – Muskelaufbau hilft am meisten.';
    push('score', 'InBody-Score', s, ' / 100', cat, note, 'Normal ab 70 · 80+ sehr muskulös');
  }
  if (m.pbf != null) {
    const b = pbfBands(sex, age);
    const cat = m.pbf < b.lo ? 'warn' : m.pbf <= b.idealHi ? 'good' : (m.pbf <= b.overHi ? 'warn' : 'bad');
    const note = m.pbf < b.lo ? 'Unter dem Ideal – auf ausreichend Energie & Muskeln achten.'
      : m.pbf <= b.idealHi ? 'Im gesunden Bereich für dein Alter & Geschlecht.'
      : m.pbf <= b.overHi ? 'Leicht über dem Ideal – etwas Fettabbau hilft.'
      : 'Deutlich über dem Ideal – gezielter Fettabbau bringt am meisten.';
    const ref = 'Ideal ' + b.lo + '–' + b.idealHi + ' % für ' + forWhom + (b.aged ? '' : ' (ohne Alter)');
    push('pbf', 'Körperfettanteil', m.pbf, ' %', cat, note, ref);
  }
  const smi = deriveSmi(m);
  if (smi != null) {
    const r = smiRef(sex, age);
    const cat = smi < r.low ? 'bad' : smi < r.typLo ? 'warn' : 'good';
    const note = smi < r.low ? 'Niedrig – Muskelaufbau ist jetzt am wichtigsten (Sarkopenie-Bereich).'
      : smi < r.typLo ? 'Unteres Normal – etwas mehr Muskel wäre gut fürs Alter.'
      : 'Guter Muskel-Index für dein Alter & Geschlecht.';
    const ref = 'Typisch ≥ ' + r.typLo + ' kg/m² für ' + forWhom + ' · wenig Muskel < ' + r.low;
    push('smi', 'Skelettmuskel-Index (SMI)', smi, ' kg/m²', cat, note, ref);
  }
  if (m.smmKg != null) push('smm', 'Skelettmuskelmasse', m.smmKg, ' kg', 'info', 'Je mehr, desto besser für Stoffwechsel & Kraft – Ziel: halten/steigern.', '');
  if (m.vfl != null) {
    const cat = m.vfl < 10 ? 'good' : m.vfl <= 14 ? 'warn' : 'bad';
    const note = m.vfl < 10 ? 'Im gesunden Bereich.' : m.vfl <= 14 ? 'Leicht erhöht – im Blick behalten.' : 'Erhöht – Bauchfett gezielt reduzieren (Herz-Kreislauf-Gesundheit).';
    push('vfl', 'Viszerales Fett-Level', m.vfl, '', cat, note, 'Gesund < 10 (Level 1–20)');
  }
  if (m.whr != null) {
    const hi = sex === 'm' ? 0.9 : 0.85;
    const cat = m.whr <= hi ? 'good' : 'warn';
    push('whr', 'Taille-Hüft-Verhältnis', m.whr, '', cat, m.whr <= hi ? 'Im gesunden Bereich.' : 'Über dem Richtwert – Bauchumfang reduzieren.', 'Richtwert ≤ ' + hi + ' für ' + sexLabel);
  }
  if (m.bmi != null) {
    const cat = m.bmi < 18.5 ? 'warn' : m.bmi < 25 ? 'good' : m.bmi < 30 ? 'warn' : 'bad';
    push('bmi', 'BMI', m.bmi, ' kg/m²', cat, 'Bei viel Muskelmasse kann der BMI hoch sein, ohne dass Fett das Problem ist.', 'Normal 18,5–25');
  }
  if (m.ecwtbw != null) {
    const cat = m.ecwtbw < 0.39 ? 'good' : m.ecwtbw <= 0.40 ? 'warn' : 'bad';
    const note = m.ecwtbw < 0.39 ? 'Ausgeglichener Wasserhaushalt.' : m.ecwtbw <= 0.40 ? 'Leicht erhöht – oft nach hartem Training, Salz oder wenig Schlaf.' : 'Erhöht – kann auf Wassereinlagerung/Entzündung hindeuten; bei Beschwerden ärztlich abklären.';
    push('ecwtbw', 'Wasserhaushalt (ECW/TBW)', m.ecwtbw, '', cat, note, 'Ausgeglichen < 0,390');
  }
  if (m.bmr != null) push('bmr', 'Grundumsatz', m.bmr, ' kcal', 'info', 'Kalorien, die dein Körper in Ruhe verbraucht – Basis für dein Kalorienziel.', '');
  return out;
}

// Segmentale Mageranalyse: Magermasse je Segment + Einordnung (Unter/Normal/Über).
// Nutzt das gedruckte %-vom-Ideal, falls gescannt; sonst nur die kg (cat 'info').
// -> [{ key, label, kg, pct, cat, band, source }] plus Symmetrie-Hinweis.
function segments(m) {
  if (!m) return [];
  const defs = [
    ['RA', 'Rechter Arm', 'leanRAkg', 'pctRA'],
    ['LA', 'Linker Arm', 'leanLAkg', 'pctLA'],
    ['TR', 'Rumpf', 'leanTRkg', 'pctTR'],
    ['RL', 'Rechtes Bein', 'leanRLkg', 'pctRL'],
    ['LL', 'Linkes Bein', 'leanLLkg', 'pctLL'],
  ];
  return defs.map((d) => {
    const kg = m[d[2]]; const pct = m[d[3]];
    let cat = 'info', band = '';
    if (pct != null) {
      if (pct < 90) { cat = 'warn'; band = 'Unter'; }
      else if (pct <= 110) { cat = 'good'; band = 'Normal'; }
      else { cat = 'good'; band = 'Über'; }
    }
    return { key: d[0], label: d[1], kg: kg != null ? kg : null, pct: pct != null ? pct : null, cat: cat, band: band };
  }).filter((s) => s.kg != null || s.pct != null);
}

// Links-Rechts-Symmetrie (Arme, Beine) aus der Magermasse – >10 % Differenz = Hinweis.
function symmetry(m) {
  if (!m) return null;
  const diff = (a, b) => (a != null && b != null && Math.max(a, b) > 0) ? Math.round(Math.abs(a - b) / Math.max(a, b) * 1000) / 10 : null;
  const arms = diff(m.leanRAkg, m.leanLAkg);
  const legs = diff(m.leanRLkg, m.leanLLkg);
  if (arms == null && legs == null) return null;
  return { arms: arms, legs: legs, flag: (arms != null && arms > 10) || (legs != null && legs > 10) };
}

// Verlauf/Trend: Deltas der neuesten Messung zur vorherigen und zur ersten.
// list = neueste zuerst. -> null bei <2 Messungen, sonst { count, sincePrev:{...}, sinceFirst:{...}, prevDate, firstDate }.
function trend(list) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (arr.length < 2) return null;
  const cur = arr[0], prev = arr[1], first = arr[arr.length - 1];
  const KEYS = ['weightKg', 'pbf', 'bfmKg', 'smmKg', 'smi', 'vfl', 'score', 'whr'];
  cur.smi = deriveSmi(cur); prev.smi = deriveSmi(prev); first.smi = deriveSmi(first);
  const diff = (a, b) => { if (a == null || b == null) return null; return Math.round((a - b) * 100) / 100; };
  const build = (o) => { const d = {}; KEYS.forEach((k) => { d[k] = diff(cur[k], o[k]); }); return d; };
  return { count: arr.length, sincePrev: build(prev), sinceFirst: build(first), prevDate: prev.date, firstDate: first.date };
}

// Kompakter Kontext-Block für FINNs System-Prompt (vertraulich). Leerer String, wenn nichts da.
function toPromptText(list, fallbackSex, fallbackAge) {
  const arr = Array.isArray(list) ? list.filter(hasAny) : [];
  if (!arr.length) return '';
  const m = arr[0];
  const sex = normSex(m.sex, fallbackSex);
  const age = (m.age != null && m.age > 0) ? m.age : ((fallbackAge != null && fallbackAge > 0) ? fallbackAge : null);
  const L = [];
  const bits = [];
  if (m.weightKg != null) bits.push('Gewicht ' + m.weightKg + ' kg');
  if (m.pbf != null) {
    const b = pbfBands(sex, age);
    bits.push('Körperfett ' + m.pbf + ' % (Ideal ' + b.lo + '–' + b.idealHi + ' % für ' + (sex === 'm' ? 'Männer' : 'Frauen') + (age ? ' ' + ageBandLabel(age) : '') + ')');
  }
  if (m.smmKg != null) bits.push('Skelettmuskelmasse ' + m.smmKg + ' kg');
  const smi = deriveSmi(m);
  if (smi != null) { const r = smiRef(sex, age); bits.push('SMI ' + smi + ' kg/m² (typisch ≥ ' + r.typLo + ', wenig < ' + r.low + ')'); }
  if (m.vfl != null) bits.push('viszerales Fett-Level ' + m.vfl);
  if (m.bmi != null) bits.push('BMI ' + m.bmi);
  if (m.whr != null) bits.push('WHR ' + m.whr);
  if (m.ecwtbw != null) bits.push('ECW/TBW ' + m.ecwtbw);
  if (m.bmr != null) bits.push('Grundumsatz ' + m.bmr + ' kcal');
  if (m.score != null) bits.push('InBody-Score ' + m.score + '/100');
  L.push('InBody-Körperanalyse (InBody 270)' + (m.date ? ' vom ' + m.date : '') + (age || sex ? ' – ' + (sex === 'm' ? 'Mann' : 'Frau') + (age ? ', ' + age + ' J.' : '') : '') + ': ' + bits.join(', ') + '.');
  const sym = symmetry(m);
  if (sym && sym.flag) L.push('Auffällige Links-Rechts-Asymmetrie (Arme ' + (sym.arms != null ? sym.arms + ' %' : '–') + ', Beine ' + (sym.legs != null ? sym.legs + ' %' : '–') + ') – ausgleichendes Training sinnvoll.');
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

module.exports = { MKEY, sanitize, hasAny, deriveSmi, evaluate, segments, symmetry, pbfBands, smiRef, trend, toPromptText, list, add, remove, clear };
