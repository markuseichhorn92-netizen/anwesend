'use strict';

/**
 * Kassenbuch (Studio-Barkasse) – gemeinsame Datenlogik.
 * -----------------------------------------------------
 * Bildet die Excel-Vorlage nach: pro Tag die verkauften Artikel (Kaffee, Eiweißshake,
 * Eiweißbeutel) + Sonstiges (Freitext/Betrag) + Ausgaben; Einnahmen, laufender Bestand
 * und Beschreibung werden berechnet. Preise sind pflegbar (Preisliste). Monate werden
 * gespeichert und sind abrufbar; ein Monat lässt sich abschließen (sperren) – dabei wird
 * zusätzlich das erzeugte PDF als unveränderlicher Beleg abgelegt.
 *
 * Speichermodell (Upstash/Redis, studioweit – KEIN Personenbezug):
 *   kb:prices        Standard-Preisliste { kaffee, eiweissshake, eiweissbeutel }
 *   kb:index         Set der vorhandenen Monatsschlüssel 'YYYY-MM'
 *   kb:m:<YYYY-MM>   Monatsdaten (Eingaben + Meta + letzte FINN-Prüfung)
 *   kb:pdf:<YYYY-MM> Base64-PDF (nur nach Abschluss – unveränderlicher Beleg)
 *
 * No-Op ohne Store; wirft nie.
 */

const { redisPipeline, hasStore } = require('./store');

const ARTICLES = ['kaffee', 'eiweissshake', 'eiweissbeutel'];
const DEFAULT_PRICES = { kaffee: 1.5, eiweissshake: 2.5, eiweissbeutel: 20.5 };
const ART_LABEL = { kaffee: 'Kaffee', eiweissshake: 'Eiweißshake', eiweissbeutel: 'Eiweißbeutel' };

const IDX_KEY = 'kb:index';
const PRICES_KEY = 'kb:prices';
const MKEY = (k) => 'kb:m:' + k;
const PDFKEY = (k) => 'kb:pdf:' + k;

function isMonthKey(k) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(k || '')); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; }
function int(v) { const n = parseInt(String(v == null ? '' : v).replace(',', '.'), 10); return isFinite(n) && n > 0 ? n : 0; }

// Einen Tages-Eintrag säubern (nur erlaubte Felder, geklammert). -> gesäubertes Objekt.
function sanitizeDay(e) {
  e = e || {};
  return {
    kaffee: int(e.kaffee), eiweissshake: int(e.eiweissshake), eiweissbeutel: int(e.eiweissbeutel),
    sonstigesText: String(e.sonstigesText || '').slice(0, 120),
    sonstigesBetrag: Math.max(0, round2(num(e.sonstigesBetrag))),
    ausgaben: Math.max(0, round2(num(e.ausgaben))),
    ausgabenText: String(e.ausgabenText || '').slice(0, 120),
  };
}

// Ganzes Monatsobjekt säubern (was vom Client kommt). closed/pdf werden NICHT hier gesetzt.
function sanitizeMonth(key, input) {
  input = input || {};
  const prices = Object.assign({}, DEFAULT_PRICES);
  if (input.prices) ARTICLES.forEach((a) => { const p = num(input.prices[a]); if (p > 0) prices[a] = round2(p); });
  const days = {};
  const src = input.days || {};
  for (let d = 1; d <= 31; d++) {
    const e = src[String(d)] || src[d];
    if (!e) continue;
    const s = sanitizeDay(e);
    // Nur speichern, wenn irgendetwas eingetragen ist (spart Platz).
    if (s.kaffee || s.eiweissshake || s.eiweissbeutel || s.sonstigesText || s.sonstigesBetrag || s.ausgaben || s.ausgabenText) days[String(d)] = s;
  }
  const [y, m] = String(key).split('-');
  return {
    key: key, year: parseInt(y, 10), month: parseInt(m, 10),
    blattNr: String(input.blattNr || '').slice(0, 20),
    anfangsbestand: round2(num(input.anfangsbestand)),
    gezaehlterEndbestand: (input.gezaehlterEndbestand === '' || input.gezaehlterEndbestand == null) ? null : round2(num(input.gezaehlterEndbestand)),
    prices: prices, days: days,
  };
}

// Reine Berechnung: Einnahmen/Bestand/Beschreibung je Tag + Summen + Kassensturz-Kontrolle.
// -> { prices, anfangsbestand, rows:[{day,...,einnahmen,ausgaben,beschreibung,bestand,pruefung,hasEntry}],
//      sumEinnahmen, sumAusgaben, endbestand, gezaehlterEndbestand, differenz, kontrolleOk }
function computeMonth(m) {
  m = m || {};
  const prices = Object.assign({}, DEFAULT_PRICES, m.prices || {});
  ARTICLES.forEach((a) => { prices[a] = round2(num(prices[a]) || DEFAULT_PRICES[a]); });
  const days = m.days || {};
  const anfang = round2(num(m.anfangsbestand));
  let running = anfang, sumEin = 0, sumAus = 0;
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const e = days[String(d)] || {};
    const kaffee = int(e.kaffee), shake = int(e.eiweissshake), beutel = int(e.eiweissbeutel);
    const sonst = Math.max(0, round2(num(e.sonstigesBetrag)));
    const aus = Math.max(0, round2(num(e.ausgaben)));
    const einn = round2(kaffee * prices.kaffee + shake * prices.eiweissshake + beutel * prices.eiweissbeutel + sonst);
    const parts = [];
    if (kaffee) parts.push(kaffee + ' Kaffee');
    if (shake) parts.push(shake + ' Eiweißshake');
    if (beutel) parts.push(beutel + ' Eiweißbeutel');
    if (e.sonstigesText && String(e.sonstigesText).trim()) parts.push(String(e.sonstigesText).trim());
    const ausText = (e.ausgabenText && String(e.ausgabenText).trim()) ? String(e.ausgabenText).trim() : '';
    const hasEntry = !!(kaffee || shake || beutel || sonst || aus || parts.length || ausText);
    running = round2(running + einn - aus);
    sumEin = round2(sumEin + einn); sumAus = round2(sumAus + aus);
    rows.push({
      day: d, kaffee: kaffee, eiweissshake: shake, eiweissbeutel: beutel,
      sonstigesText: e.sonstigesText || '', sonstigesBetrag: sonst,
      einnahmen: einn, ausgaben: aus, ausgabenText: ausText,
      beschreibung: parts.join(' + '), pruefung: einn > 0 ? '✓' : '',
      bestand: running, hasEntry: hasEntry,
    });
  }
  const entriesCount = rows.filter((r) => r.hasEntry).length;
  // Archiv-/Import-Monat ohne Tagesdetails: die ERFASSTEN Summen sind maßgeblich.
  if (m.imported && !entriesCount) {
    const ie = round2(num(m.imported.sumEinnahmen));
    const ia = round2(num(m.imported.sumAusgaben));
    const end = (m.imported.endbestand == null) ? round2(anfang + ie - ia) : round2(num(m.imported.endbestand));
    const gezI = (m.gezaehlterEndbestand === '' || m.gezaehlterEndbestand == null) ? null : round2(num(m.gezaehlterEndbestand));
    return {
      prices: prices, anfangsbestand: anfang, rows: rows,
      sumEinnahmen: ie, sumAusgaben: ia, endbestand: end,
      gezaehlterEndbestand: gezI, differenz: gezI == null ? null : round2(gezI - end),
      kontrolleOk: gezI == null ? true : Math.abs(round2(gezI - end)) < 0.005,
      entriesCount: 0, imported: true,
    };
  }
  const endbestand = round2(anfang + sumEin - sumAus);
  const gez = (m.gezaehlterEndbestand === '' || m.gezaehlterEndbestand == null) ? null : round2(num(m.gezaehlterEndbestand));
  const differenz = gez == null ? null : round2(gez - endbestand);
  return {
    prices: prices, anfangsbestand: anfang, rows: rows,
    sumEinnahmen: round2(sumEin), sumAusgaben: round2(sumAus), endbestand: endbestand,
    gezaehlterEndbestand: gez, differenz: differenz,
    kontrolleOk: differenz == null ? true : Math.abs(differenz) < 0.005,
    entriesCount: entriesCount,
  };
}

// Kompakter, NICHT-personenbezogener Kontext-Block für FINNs steuerliche Prüfung.
function toPromptText(month, totals) {
  const t = totals || computeMonth(month);
  const L = [];
  L.push('Kassenbuch (Bar-Nebenkasse eines Fitnessstudios) für ' + String(month.month).padStart(2, '0') + '/' + month.year + '.');
  L.push('Preisliste: Kaffee ' + t.prices.kaffee + ' €, Eiweißshake ' + t.prices.eiweissshake + ' €, Eiweißbeutel ' + t.prices.eiweissbeutel + ' €.');
  L.push('Anfangsbestand: ' + t.anfangsbestand + ' €. Summe Einnahmen: ' + t.sumEinnahmen + ' €. Summe Ausgaben: ' + t.sumAusgaben + ' €. Rechnerischer Endbestand: ' + t.endbestand + ' €.');
  if (t.gezaehlterEndbestand != null) L.push('Gezählter Kassenbestand (Kassensturz): ' + t.gezaehlterEndbestand + ' € → Differenz zum rechnerischen Bestand: ' + t.differenz + ' €.');
  const buchungen = t.rows.filter((r) => r.hasEntry).map((r) => r.day + '.: ' + (r.beschreibung || '—') + (r.einnahmen ? (' | Einnahme ' + r.einnahmen + ' €') : '') + (r.ausgaben ? (' | Ausgabe ' + r.ausgaben + ' €' + (r.ausgabenText ? (' (' + r.ausgabenText + ')') : '')) : ''));
  L.push('Buchungen (' + buchungen.length + '):');
  buchungen.slice(0, 40).forEach((b) => L.push('– ' + b));
  return L.join('\n');
}

// Nächste Blatt-Nummer aus der vorigen ableiten ('843' -> '844', 'Blatt 12' -> 'Blatt 13').
function nextBlattNr(prev) {
  const s = String(prev == null ? '' : prev).trim();
  const m = s.match(/(\d+)\s*$/);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  if (!isFinite(n)) return '';
  return s.slice(0, m.index) + String(n + 1);
}

// ── Store (No-Op ohne KV) ──
async function getPrices() {
  if (!hasStore) return Object.assign({}, DEFAULT_PRICES);
  try { const [v] = await redisPipeline([['GET', PRICES_KEY]]); const o = v ? (typeof v === 'string' ? JSON.parse(v) : v) : null; const p = Object.assign({}, DEFAULT_PRICES); if (o) ARTICLES.forEach((a) => { if (num(o[a]) > 0) p[a] = round2(num(o[a])); }); return p; }
  catch (e) { return Object.assign({}, DEFAULT_PRICES); }
}
async function setPrices(prices) {
  const p = Object.assign({}, DEFAULT_PRICES); ARTICLES.forEach((a) => { if (num(prices && prices[a]) > 0) p[a] = round2(num(prices[a])); });
  if (!hasStore) return p;
  try { await redisPipeline([['SET', PRICES_KEY, JSON.stringify(p)]]); } catch (e) {}
  return p;
}
async function getMonth(key) {
  if (!isMonthKey(key) || !hasStore) return null;
  try { const [v] = await redisPipeline([['GET', MKEY(key)]]); if (!v) return null; return typeof v === 'string' ? JSON.parse(v) : v; }
  catch (e) { return null; }
}
async function saveMonth(key, input) {
  if (!isMonthKey(key)) return { ok: false, error: 'bad_month' };
  const existing = await getMonth(key);
  if (existing && existing.closed) return { ok: false, error: 'closed' };
  const clean = sanitizeMonth(key, input);
  clean.closed = false;
  clean.updatedAt = new Date().toISOString();
  clean.check = existing && existing.check ? existing.check : null;
  if (!hasStore) return { ok: true, month: clean, disabled: true };
  try { await redisPipeline([['SET', MKEY(key), JSON.stringify(clean)], ['SADD', IDX_KEY, key]]); return { ok: true, month: clean }; }
  catch (e) { return { ok: false, error: 'store' }; }
}
async function saveCheck(key, check) {
  const m = await getMonth(key); if (!m) return { ok: false };
  m.check = { at: new Date().toISOString(), text: String((check && check.text) || '').slice(0, 6000) };
  if (!hasStore) return { ok: true, check: m.check };
  try { await redisPipeline([['SET', MKEY(key), JSON.stringify(m)]]); return { ok: true, check: m.check }; } catch (e) { return { ok: false }; }
}
async function closeMonth(key, pdfBase64, byName) {
  const m = await getMonth(key); if (!m) return { ok: false, error: 'not_found' };
  if (m.closed) return { ok: false, error: 'already_closed' };
  m.closed = true; m.closedAt = new Date().toISOString(); m.closedBy = String(byName || '').slice(0, 60);
  if (!hasStore) return { ok: true, month: m, disabled: true };
  try {
    const cmds = [['SET', MKEY(key), JSON.stringify(m)], ['SADD', IDX_KEY, key]];
    if (pdfBase64 && typeof pdfBase64 === 'string' && pdfBase64.length < 4e6) cmds.push(['SET', PDFKEY(key), pdfBase64]);
    await redisPipeline(cmds);
    return { ok: true, month: m };
  } catch (e) { return { ok: false, error: 'store' }; }
}
async function reopenMonth(key) {
  const m = await getMonth(key); if (!m) return { ok: false };
  m.closed = false; delete m.closedAt; delete m.closedBy;
  if (!hasStore) return { ok: true, month: m };
  try { await redisPipeline([['SET', MKEY(key), JSON.stringify(m)], ['DEL', PDFKEY(key)]]); return { ok: true, month: m }; } catch (e) { return { ok: false }; }
}
async function getPdf(key) {
  if (!isMonthKey(key) || !hasStore) return null;
  try { const [v] = await redisPipeline([['GET', PDFKEY(key)]]); return v || null; } catch (e) { return null; }
}
// Einen fertigen Archiv-/Import-Monat ablegen – nur, wenn er noch NICHT existiert
// (idempotent; überschreibt vorhandene Monate nie). rec ist ein vollständiger Datensatz.
async function importMonth(rec) {
  const key = rec && rec.key;
  if (!isMonthKey(key)) return { ok: false, error: 'bad_month' };
  const existing = await getMonth(key);
  if (existing) return { ok: false, skipped: true, reason: 'exists' };
  if (!hasStore) return { ok: false, disabled: true };
  const clean = Object.assign({}, rec, { closedAt: rec.closedAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
  try { await redisPipeline([['SET', MKEY(key), JSON.stringify(clean)], ['SADD', IDX_KEY, key]]); return { ok: true, imported: true }; }
  catch (e) { return { ok: false, error: 'store' }; }
}

// Eröffnungswerte für einen noch nicht erfassten Monat: Anfangsbestand = Endbestand
// des letzten davorliegenden Monats, Blatt-Nr. = dessen Blatt-Nr. + 1 (lückenfest –
// nimmt den jüngsten existierenden Vormonat, auch bei Monatslücken).
async function suggestOpening(key) {
  const out = { anfangsbestand: 0, blattNr: '', carried: false, fromMonth: null };
  if (!isMonthKey(key) || !hasStore) return out;
  let keys = [];
  try { const [r] = await redisPipeline([['SMEMBERS', IDX_KEY]]); keys = Array.isArray(r) ? r : []; } catch (e) { return out; }
  keys = keys.filter(isMonthKey).filter((k) => k < key).sort();   // 'YYYY-MM' sortiert chronologisch
  if (!keys.length) return out;
  const prevKey = keys[keys.length - 1];
  const m = await getMonth(prevKey);
  if (!m) return out;
  const t = computeMonth(m);
  out.anfangsbestand = t.endbestand;
  out.blattNr = nextBlattNr(m.blattNr);
  out.carried = true;
  out.fromMonth = prevKey;
  return out;
}
async function listMonths() {
  if (!hasStore) return [];
  let keys = [];
  try { const [r] = await redisPipeline([['SMEMBERS', IDX_KEY]]); keys = Array.isArray(r) ? r : []; } catch (e) { return []; }
  keys = keys.filter(isMonthKey).sort().reverse();
  const out = [];
  for (const k of keys) {
    const m = await getMonth(k);
    if (!m) continue;
    const t = computeMonth(m);
    out.push({ key: k, year: m.year, month: m.month, closed: !!m.closed, closedAt: m.closedAt || null, updatedAt: m.updatedAt || null, sumEinnahmen: t.sumEinnahmen, sumAusgaben: t.sumAusgaben, endbestand: t.endbestand, entriesCount: t.entriesCount, imported: !!m.imported, blattNr: m.blattNr || '', hasPdf: !!m.closed && !m.imported });
  }
  return out;
}

module.exports = {
  ARTICLES, ART_LABEL, DEFAULT_PRICES, isMonthKey, round2, num, int,
  sanitizeDay, sanitizeMonth, computeMonth, toPromptText, nextBlattNr,
  getPrices, setPrices, getMonth, saveMonth, saveCheck, closeMonth, reopenMonth, getPdf, listMonths, suggestOpening, importMonth, hasStore,
};
