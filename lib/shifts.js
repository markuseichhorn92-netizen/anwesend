'use strict';

/**
 * Schichtplaner fürs Studio-Team (Team-Backend).
 * ----------------------------------------------
 * Eigener Store (Upstash KV, REST) – BEWUSST ohne Magicline-Abhängigkeit.
 * Deckt Dienstplan, Verfügbarkeiten, Schichttausch (Schwarzes Brett) und
 * den Team-Chat (1:1 zwischen Mitarbeitern) ab. Kein SDK, keine Dependencies.
 *
 * Keys (Präfix shf):
 *   shf:seq                 INCR-Zähler für IDs (Schichten 's…', Swaps 'w…')
 *   shf:v:<id>              JSON der Schicht
 *   shf:d:<YYYY-MM-DD>      SET der Schicht-IDs des Tages (Wochen-Query = 7 Lookups)
 *   shf:av:<employeeId>     JSON Verfügbarkeit { name, days:{mo..so}, updatedAt }
 *   shf:avb:<employeeId>    JSON Verfügbarkeit als Bloecke { blocks:{mo:[0,2]}, soft, src }
 *   shf:avi                 SET aller employeeIds mit Verfügbarkeit (für planWeek)
 *   shf:vac:<id>            JSON Urlaubs-/Abwesenheitsantrag
 *   shf:vaci                SET aller Antrags-IDs
 *   shf:swap:<id>           JSON Tauschanfrage
 *   shf:swap:idx            SET der Swap-IDs
 *   shf:tc:<min>:<max>      JSON Chat-Thread zwischen zwei Mitarbeitern
 *   shf:tci:<employeeId>    SET der Thread-Keys des Mitarbeiters
 *
 * Schicht:  { id, date:'YYYY-MM-DD', start:'06:00', end:'14:00',
 *             role:'theke'|'flaeche'|'kurs', assignee:{id,name,initials}|null,
 *             note:'', board:false, applicants:[{id,name,initials}], createdAt, updatedAt }
 * Swap:     { id, shiftId, shiftStr, from:{id,name,initials}, to:{…}|null, note:'',
 *             status:'pending'|'accepted'|'declined'|'withdrawn', createdAt }
 * Thread:   { a:{id,name,initials}, b:{…}, shiftStr:'', messages:[{from,text,at}], updatedAt }
 *
 * Grundsatz (wie im Bestand): wirft NIE. Ohne Store -> leere Daten, keine
 * Persistenz. Jeder externe Zugriff ist try/catch-gekapselt (best effort).
 */

const { redisPipeline, hasStore } = require('./store');

const SEQ = 'shf:seq';
const AV_IDX = 'shf:avi';
const SW_IDX = 'shf:swap:idx';
const VAC_IDX = 'shf:vaci';
const vKey = (id) => 'shf:v:' + id;
const dKey = (date) => 'shf:d:' + date;
const avKey = (id) => 'shf:av:' + id;
const avbKey = (id) => 'shf:avb:' + id;
const vacKey = (id) => 'shf:vac:' + id;
const swKey = (id) => 'shf:swap:' + id;
const tciKey = (id) => 'shf:tci:' + id;
function tcKey(a, b) {
  const x = String(a), y = String(b);
  return x <= y ? ('shf:tc:' + x + ':' + y) : ('shf:tc:' + y + ':' + x);
}

const MAX_MSGS = 200;      // Nachrichten je Thread cappen
const MAX_NOTE = 300;
const MAX_TEXT = 1000;
const MAX_NAME = 80;

// Rollen inkl. Design-Farben (Chip + Karten-Akzent) – Frontend spiegelt diese Werte.
const ROLES = {
  theke:   { label: 'Theke',  chipColor: '#2f6fd6', chipBg: '#E7F0FB', accent: '#F6A964' },
  flaeche: { label: 'Fläche', chipColor: '#176b37', chipBg: '#E7F6EC', accent: '#0e6072' },
  kurs:    { label: 'Kurs',   chipColor: '#6b4fd8', chipBg: '#EFEBFB', accent: '#8E7BF0' },
};

const DOW = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DAY_KEYS = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'];
const AV_VALUES = ['frueh', 'spaet', 'egal', 'frei'];

// ── Normalisierung ──
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function cleanDate(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null;
}
function cleanTime(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ':' + pad2(mi);
}
function cleanRole(r) { return ROLES[String(r || '').trim()] ? String(r).trim() : 'theke'; }
function cleanNote(s) { return String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, MAX_NOTE); }
function cleanText(s) { return String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT); }
function initialsOf(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '')).toUpperCase();
}
// Person {id,name,initials} normalisieren – ohne id -> null.
function normPerson(p) {
  if (!p || typeof p !== 'object' || p.id == null || String(p.id).trim() === '') return null;
  const name = String(p.name || '').trim().slice(0, MAX_NAME);
  return {
    id: String(p.id).trim(),
    name: name || ('Mitarbeiter ' + String(p.id).trim()),
    initials: String(p.initials || '').trim().slice(0, 3).toUpperCase() || initialsOf(name),
  };
}
function defaultDays() {
  const d = {};
  ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'].forEach((k) => { d[k] = 'egal'; });
  return d;
}
function cleanDays(days) {
  const src = (days && typeof days === 'object') ? days : {};
  const out = defaultDays();
  Object.keys(out).forEach((k) => {
    const v = String(src[k] || '').trim();
    if (AV_VALUES.indexOf(v) >= 0) out[k] = v;
  });
  return out;
}

// ── Datums-Helfer (lokale Zeit, DST-unkritisch da nur Kalendertage) ──
function parseISO(s) {
  const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}
function dateISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function mondayOf(s) {
  let d = parseISO(s) || new Date();
  d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateISO(d);
}
function addDays(iso, n) {
  const d = parseISO(iso) || new Date();
  d.setDate(d.getDate() + (Number(n) || 0));
  return dateISO(d);
}
function weekDates(mondayISO) {
  const mon = mondayOf(mondayISO);
  const out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(mon, i));
  return out;
}
// Kurzlabel einer Schicht, z. B. "Do 02.07. · 06:00–14:00 Theke".
function shiftLabel(sh) {
  const d = parseISO(sh && sh.date);
  const dow = d ? DOW[d.getDay()] : '';
  const dm = d ? (pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.') : '';
  const role = (ROLES[sh && sh.role] || ROLES.theke).label;
  return ((dow + ' ' + dm).trim() + ' · ' + (sh && sh.start) + '–' + (sh && sh.end) + ' ' + role).trim();
}

async function nextId(prefix) {
  const r = await redisPipeline([['INCR', SEQ]]);
  return prefix + (Number(r && r[0]) || 1);
}

// ── Feste Wochen-Schichtvorlage des Studios (Ist-Zustand, KEIN Magicline-Call) ──
// Die Studio-Schichten sind fix und gelten jede Woche gleich. Index = Wochentag wie
// Date.getDay() (0=So … 6=Sa). Zeiten in lokaler Studio-Zeit. Rolle default 'theke';
// pro Schicht im Editor änderbar. Quelle: Studioleitung (Mo–Fr 5, Sa 2, So 2 Schichten).
const WEEKDAY_SHIFTS = [
  ['09:30', '11:30'], ['11:30', '13:00'],
  ['15:00', '17:30'], ['17:30', '19:30'], ['19:30', '21:30'],
];
const WEEKLY_TEMPLATE = {
  0: [['09:00', '12:00'], ['12:00', '15:00']],   // Sonntag
  1: WEEKDAY_SHIFTS, 2: WEEKDAY_SHIFTS, 3: WEEKDAY_SHIFTS, 4: WEEKDAY_SHIFTS, 5: WEEKDAY_SHIFTS,   // Mo–Fr
  6: [['13:00', '16:00'], ['16:00', '18:00']],   // Samstag
};
// Schicht-Specs für die Woche (dates = ISO-Tage) aus der festen Wochenvorlage.
function templateSpecs(dates) {
  const out = [];
  (Array.isArray(dates) ? dates : []).forEach((iso) => {
    const day = cleanDate(iso); if (!day) return;
    const d = parseISO(day); if (!d) return;
    (WEEKLY_TEMPLATE[d.getDay()] || []).forEach((t) => {
      out.push({ date: day, start: t[0], end: t[1], role: 'theke' });
    });
  });
  return out;
}

// ── Schichten aus Öffnungszeiten ableiten (rein rechnerisch, KEIN Magicline-Call) ──
// Der Endpunkt liest die Magicline-Öffnungszeiten und übergibt sie hier als
// Array { dayOfWeekFrom, dayOfWeekTo, timeFrom:'06:00:00', timeTo:'23:00:00' }.
const DOW_ENUM = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 };
function hhmm(t) {
  const m = String(t == null ? '' : t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ':' + pad2(mi);
}
function toMin(t) { const p = t.split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
function fromMin(x) { return pad2(Math.floor(x / 60)) + ':' + pad2(x % 60); }
// Öffnungsfenster je Wochentag (0=So..6=Sa) -> { dow: [{from,to}] }. Tagesbereiche werden expandiert.
function windowsByDow(openingHours) {
  const out = {};
  (Array.isArray(openingHours) ? openingHours : []).forEach((e) => {
    if (!e) return;
    const from = hhmm(e.timeFrom || e.from || e.openingTime);
    const to = hhmm(e.timeTo || e.to || e.closingTime);
    if (!from || !to || to <= from) return;
    const a = DOW_ENUM[String(e.dayOfWeekFrom || e.dayOfWeek || '').toUpperCase()];
    let b = DOW_ENUM[String(e.dayOfWeekTo || e.dayOfWeekFrom || e.dayOfWeek || '').toUpperCase()];
    if (a == null) return;
    if (b == null) b = a;
    let d = a;
    for (let i = 0; i < 7; i++) { (out[d] = out[d] || []).push({ from: from, to: to }); if (d === b) break; d = (d + 1) % 7; }
  });
  return out;
}
// Ein Öffnungsfenster in Schicht-Specs schneiden. split: 'early_late'|'single'|'blocks'.
function splitWindow(date, from, to, split, blockH) {
  const a = toMin(from), b = toMin(to), out = [];
  if (b <= a) return out;
  if (split === 'single') { out.push({ date: date, start: from, end: to, role: 'theke' }); return out; }
  if (split === 'blocks') {
    const step = Math.max(60, blockH * 60); let s = a;
    while (s < b) { const e = Math.min(s + step, b); out.push({ date: date, start: fromMin(s), end: fromMin(e), role: 'theke' }); s = e; }
    return out;
  }
  // early_late: bei 14:00 teilen, sofern das Fenster darüber hinausreicht
  const mid = 14 * 60;
  if (b <= mid || a >= mid) { out.push({ date: date, start: from, end: to, role: 'theke' }); }
  else { out.push({ date: date, start: from, end: fromMin(mid), role: 'theke' }); out.push({ date: date, start: fromMin(mid), end: to, role: 'theke' }); }
  return out;
}
// Schicht-Specs für die Woche (dates = ISO-Tage) aus den Öffnungszeiten.
function shiftSpecsFromHours(dates, openingHours, opts) {
  opts = opts || {};
  const split = ['early_late', 'single', 'blocks'].indexOf(opts.split) >= 0 ? opts.split : 'early_late';
  const blockH = Math.max(2, Math.min(12, Number(opts.blockHours) || 4));
  const wins = windowsByDow(openingHours);
  const specs = [];
  (Array.isArray(dates) ? dates : []).forEach((iso) => {
    const d = parseISO(iso); if (!d) return;
    const dow = d.getDay();
    (wins[dow] || []).forEach((w) => { splitWindow(iso, w.from, w.to, split, blockH).forEach((s) => specs.push(s)); });
  });
  return specs;
}

// ── Schichten: CRUD ──
async function getShift(id) {
  if (!hasStore || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', vKey(String(id))]]); } catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function createShift(o) {
  o = o || {};
  const date = cleanDate(o.date), start = cleanTime(o.start), end = cleanTime(o.end);
  if (!hasStore || !date || !start || !end) return null;
  try {
    const id = await nextId('s');
    const now = Date.now();
    const shift = {
      id: id, date: date, start: start, end: end, role: cleanRole(o.role),
      assignee: normPerson(o.assignee), note: cleanNote(o.note),
      board: false, postMode: null, deadline: null, applicants: [],
      createdAt: now, updatedAt: now,
    };
    await redisPipeline([['SET', vKey(id), JSON.stringify(shift)], ['SADD', dKey(date), id]]);
    return shift;
  } catch (e) { return null; }
}

// Patch darf date/start/end/role/assignee/note/board/applicants enthalten.
// Datumswechsel pflegt den Tages-Index mit um.
async function updateShift(id, patch) {
  if (!hasStore || !id) return null;
  patch = patch || {};
  try {
    const shift = await getShift(id);
    if (!shift) return null;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const oldDate = shift.date;
    if (has('date')) { const d = cleanDate(patch.date); if (d) shift.date = d; }
    if (has('start')) { const t = cleanTime(patch.start); if (t) shift.start = t; }
    if (has('end')) { const t = cleanTime(patch.end); if (t) shift.end = t; }
    if (has('role')) shift.role = cleanRole(patch.role);
    if (has('assignee')) shift.assignee = normPerson(patch.assignee);
    if (has('note')) shift.note = cleanNote(patch.note);
    if (has('board')) shift.board = !!patch.board;
    if (has('postMode')) {
      const m = String(patch.postMode || '').trim();
      shift.postMode = POST_MODES.indexOf(m) >= 0 ? m : null;
    }
    if (has('deadline')) {
      shift.deadline = patch.deadline == null ? null : String(patch.deadline).trim().slice(0, 40) || null;
    }
    if (has('applicants')) {
      shift.applicants = (Array.isArray(patch.applicants) ? patch.applicants : [])
        .map(normPerson).filter(Boolean).slice(0, 20);
    }
    shift.updatedAt = Date.now();
    const cmds = [['SET', vKey(shift.id), JSON.stringify(shift)]];
    if (shift.date !== oldDate) {
      cmds.push(['SREM', dKey(oldDate), shift.id]);
      cmds.push(['SADD', dKey(shift.date), shift.id]);
    }
    await redisPipeline(cmds);
    return shift;
  } catch (e) { return null; }
}

async function deleteShift(id) {
  if (!hasStore || !id) return false;
  try {
    const shift = await getShift(id);
    if (!shift) return false;
    await redisPipeline([['DEL', vKey(shift.id)], ['SREM', dKey(shift.date), shift.id]]);
    return true;
  } catch (e) { return false; }
}

// Alle Schichten der übergebenen Tage: [{date, shifts:[…]}] (Reihenfolge der
// Eingabe, Schichten nach Startzeit). Ohne Store -> leere Tage. Wirft nie.
async function listWeek(dates) {
  const ds = (Array.isArray(dates) ? dates : []).map(cleanDate).filter(Boolean);
  const days = ds.map((d) => ({ date: d, shifts: [] }));
  if (!hasStore || !ds.length) return days;
  let idsPer;
  try { idsPer = await redisPipeline(ds.map((d) => ['SMEMBERS', dKey(d)])); }
  catch (e) { return days; }
  const all = [];
  (idsPer || []).forEach((ids) => { (Array.isArray(ids) ? ids : []).forEach((id) => { all.push(id); }); });
  if (!all.length) return days;
  let res;
  try { res = await redisPipeline(all.map((id) => ['GET', vKey(id)])); }
  catch (e) { return days; }
  const byDate = {};
  days.forEach((d) => { byDate[d.date] = d; });
  (res || []).forEach((s) => {
    if (!s) return;
    try { const sh = JSON.parse(s); if (byDate[sh.date]) byDate[sh.date].shifts.push(sh); } catch (e) {}
  });
  days.forEach((d) => {
    d.shifts.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (String(a.id) < String(b.id) ? -1 : 1)));
  });
  return days;
}

// ── Verfügbarkeiten ──
async function getAvailability(employeeId) {
  const empty = { name: null, days: defaultDays(), updatedAt: 0 };
  if (!hasStore || employeeId == null || String(employeeId).trim() === '') return empty;
  let s;
  try { [s] = await redisPipeline([['GET', avKey(String(employeeId).trim())]]); }
  catch (e) { return empty; }
  if (!s) return empty;
  try {
    const av = JSON.parse(s);
    return { name: av.name || null, days: cleanDays(av.days), updatedAt: av.updatedAt || 0 };
  } catch (e) { return empty; }
}

async function setAvailability(employeeId, name, days) {
  const id = String(employeeId == null ? '' : employeeId).trim();
  if (!hasStore || !id) return null;
  try {
    const av = {
      name: String(name || '').trim().slice(0, MAX_NAME) || null,
      days: cleanDays(days),
      updatedAt: Date.now(),
    };
    await redisPipeline([['SET', avKey(id), JSON.stringify(av)], ['SADD', AV_IDX, id]]);
    return av;
  } catch (e) { return null; }
}

async function allAvailabilities() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', AV_IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', avKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s, i) => {
    if (!s) return;
    try {
      const av = JSON.parse(s);
      out.push({ employeeId: String(ids[i]), name: av.name || null, days: cleanDays(av.days), updatedAt: av.updatedAt || 0 });
    } catch (e) {}
  });
  out.sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)));
  return out;
}

// ── Verfügbarkeit als Blöcke ────────────────────────────────────────────────
// Die grobe Form oben (frueh/spaet/egal/frei) ist im Bestand und wird von
// planWeek und der Telefonansicht benutzt. Der Schichtplaner braucht es genauer:
// welche der festen Schichtblöcke des Tages jemand übernehmen kann.
//
// Damit nicht zwei Wahrheiten entstehen, schreibt setAvailBlocks BEIDE Formen -
// die grobe wird aus den Blöcken abgeleitet. Wer Blöcke meldet, meldet damit
// automatisch auch die grobe Angabe, und der Bestand liest weiter wie bisher.
function blocksOfDow(dow) { return WEEKLY_TEMPLATE[dow] || []; }
// Wochentagsschlüssel ('mo') -> Index wie Date.getDay()
function dowOfKey(key) { const i = DAY_KEYS.indexOf(String(key || '')); return i < 0 ? null : i; }

function emptyBlocks() {
  const o = {};
  DAY_KEYS.forEach((k) => { o[k] = []; });
  return o;
}
function cleanBlocks(blocks) {
  const src = (blocks && typeof blocks === 'object') ? blocks : {};
  const out = emptyBlocks();
  DAY_KEYS.forEach((k) => {
    const max = blocksOfDow(dowOfKey(k)).length;
    const list = Array.isArray(src[k]) ? src[k] : [];
    const seen = {};
    list.forEach((v) => {
      const n = parseInt(v, 10);
      if (!isFinite(n) || n < 0 || n >= max || seen[n]) return;
      seen[n] = 1; out[k].push(n);
    });
    out[k].sort((a, b) => a - b);
  });
  return out;
}
function cleanSoft(soft) {
  const src = (soft && typeof soft === 'object') ? soft : {};
  const out = {};
  DAY_KEYS.forEach((k) => { out[k] = !!src[k]; });
  return out;
}
// Grobe Angabe aus den Blöcken: nichts gewählt -> frei, alles -> egal,
// nur vor 14 Uhr -> frueh, nur ab 14 Uhr -> spaet, gemischt -> egal.
function deriveDays(blocks) {
  const out = defaultDays();
  DAY_KEYS.forEach((k) => {
    const dow = dowOfKey(k);
    const all = blocksOfDow(dow);
    const sel = (blocks && blocks[k]) || [];
    if (!all.length) { out[k] = 'frei'; return; }
    if (!sel.length) { out[k] = 'frei'; return; }
    if (sel.length === all.length) { out[k] = 'egal'; return; }
    let frueh = false, spaet = false;
    sel.forEach((i) => { if (all[i] && all[i][0] < '14:00') frueh = true; else spaet = true; });
    out[k] = (frueh && spaet) ? 'egal' : (frueh ? 'frueh' : 'spaet');
  });
  return out;
}
// Stunden, die die gewählten Blöcke eines Tages ergeben.
function blockHours(dowKey, sel) {
  const all = blocksOfDow(dowOfKey(dowKey));
  return (Array.isArray(sel) ? sel : []).reduce((n, i) => {
    const b = all[i];
    return b ? (n + (toMin(b[1]) - toMin(b[0])) / 60) : n;
  }, 0);
}

function emptyAvailBlocks() {
  return { blocks: emptyBlocks(), soft: cleanSoft(null), src: 'self', reported: false, updatedAt: 0, name: null };
}
async function getAvailBlocks(employeeId) {
  const id = String(employeeId == null ? '' : employeeId).trim();
  if (!hasStore || !id) return emptyAvailBlocks();
  let s;
  try { [s] = await redisPipeline([['GET', avbKey(id)]]); } catch (e) { return emptyAvailBlocks(); }
  if (!s) return emptyAvailBlocks();
  try {
    const a = JSON.parse(s);
    return {
      blocks: cleanBlocks(a.blocks), soft: cleanSoft(a.soft),
      src: a.src === 'lead' ? 'lead' : 'self',
      reported: true, updatedAt: a.updatedAt || 0, name: a.name || null,
    };
  } catch (e) { return emptyAvailBlocks(); }
}

// src='lead' heisst: die Leitung hat es eingetragen, nicht die Person selbst.
// Der Entwurf faerbt das unterschiedlich ein - und das ist keine Zierde: es sagt,
// wessen Angabe man vor sich hat.
async function setAvailBlocks(employeeId, name, blocks, soft, src) {
  const id = String(employeeId == null ? '' : employeeId).trim();
  if (!hasStore || !id) return null;
  try {
    const rec = {
      name: String(name || '').trim().slice(0, MAX_NAME) || null,
      blocks: cleanBlocks(blocks), soft: cleanSoft(soft),
      src: src === 'lead' ? 'lead' : 'self',
      updatedAt: Date.now(),
    };
    const grob = { name: rec.name, days: deriveDays(rec.blocks), updatedAt: rec.updatedAt };
    await redisPipeline([
      ['SET', avbKey(id), JSON.stringify(rec)],
      ['SET', avKey(id), JSON.stringify(grob)],
      ['SADD', AV_IDX, id],
    ]);
    return Object.assign({ reported: true }, rec);
  } catch (e) { return null; }
}

async function allAvailBlocks() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', AV_IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', avbKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s, i) => {
    if (!s) return;
    try {
      const a = JSON.parse(s);
      out.push({
        employeeId: String(ids[i]), name: a.name || null,
        blocks: cleanBlocks(a.blocks), soft: cleanSoft(a.soft),
        src: a.src === 'lead' ? 'lead' : 'self', reported: true, updatedAt: a.updatedAt || 0,
      });
    } catch (e) {}
  });
  out.sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)));
  return out;
}

// ── Mitarbeiter-Stammdaten ──────────────────────────────────────────────────
// Magicline kennt Namen und IDs. Was der Schichtplan braucht, kennt es nicht:
// fuer welchen Bereich jemand freigegeben ist, wie viele Stunden im Monat gehen
// und wie viel Urlaub im Jahr zusteht. Das steht deshalb hier - und wird von der
// Leitung unter „Mitarbeiter & Qualifikationen" gepflegt.
const AREAS = ['flaeche', 'reinigung', 'theke', 'kurs'];
const EMP_IDX = 'shf:empi';
const empKey = (id) => 'shf:emp:' + id;
const MAX_MONTH = 400;
const MAX_VACDAYS = 60;

function cleanAreas(a) {
  const list = Array.isArray(a) ? a : [];
  const out = [];
  list.forEach((x) => { const v = String(x || '').trim(); if (AREAS.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v); });
  return out.length ? out : ['flaeche'];
}
function num(v, def, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
}
function defaultStaff(id, name) {
  const nm = String(name || '').trim().slice(0, MAX_NAME) || ('Mitarbeiter ' + id);
  return {
    id: String(id), name: nm, initials: initialsOf(nm),
    type: 'Vollzeit', areas: ['flaeche'], monthMax: 160, vacDays: 30,
    active: true, updatedAt: 0, stored: false,
  };
}

async function getStaff(id, fallbackName) {
  const key = String(id == null ? '' : id).trim();
  if (!key) return null;
  if (!hasStore) return defaultStaff(key, fallbackName);
  let s;
  try { [s] = await redisPipeline([['GET', empKey(key)]]); } catch (e) { return defaultStaff(key, fallbackName); }
  if (!s) return defaultStaff(key, fallbackName);
  try {
    const e = JSON.parse(s);
    const nm = String(e.name || fallbackName || '').trim().slice(0, MAX_NAME) || ('Mitarbeiter ' + key);
    return {
      id: key, name: nm, initials: String(e.initials || '').trim().slice(0, 3).toUpperCase() || initialsOf(nm),
      type: String(e.type || 'Vollzeit').trim().slice(0, 40) || 'Vollzeit',
      areas: cleanAreas(e.areas), monthMax: num(e.monthMax, 160, 1, MAX_MONTH),
      vacDays: num(e.vacDays, 30, 0, MAX_VACDAYS),
      active: e.active !== false, updatedAt: e.updatedAt || 0, stored: true,
    };
  } catch (e) { return defaultStaff(key, fallbackName); }
}

async function setStaff(id, patch) {
  const key = String(id == null ? '' : id).trim();
  if (!hasStore || !key) return null;
  patch = patch || {};
  try {
    const cur = await getStaff(key, patch.name);
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has('name')) { const n = String(patch.name || '').trim().slice(0, MAX_NAME); if (n) { cur.name = n; cur.initials = initialsOf(n); } }
    if (has('type')) cur.type = String(patch.type || '').trim().slice(0, 40) || cur.type;
    if (has('areas')) cur.areas = cleanAreas(patch.areas);
    if (has('monthMax')) cur.monthMax = num(patch.monthMax, cur.monthMax, 1, MAX_MONTH);
    if (has('vacDays')) cur.vacDays = num(patch.vacDays, cur.vacDays, 0, MAX_VACDAYS);
    if (has('active')) cur.active = !!patch.active;
    cur.updatedAt = Date.now(); cur.stored = true;
    await redisPipeline([['SET', empKey(key), JSON.stringify(cur)], ['SADD', EMP_IDX, key]]);
    return cur;
  } catch (e) { return null; }
}

async function removeStaff(id) {
  const key = String(id == null ? '' : id).trim();
  if (!hasStore || !key) return false;
  try {
    await redisPipeline([['DEL', empKey(key)], ['SREM', EMP_IDX, key]]);
    return true;
  } catch (e) { return false; }
}

async function allStaff() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', EMP_IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const e = await getStaff(ids[i]);
    if (e) out.push(e);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  return out;
}

// Geleistete Stunden im Monat des Stichtags – aus den Schichten, nicht gepflegt.
// Gepflegte Zahlen laufen auseinander; gerechnete nicht.
async function monthHours(iso) {
  const d = parseISO(iso) || new Date();
  const jahr = d.getFullYear(), monat = d.getMonth();
  const erster = new Date(jahr, monat, 1), letzter = new Date(jahr, monat + 1, 0);
  const tage = [];
  for (let t = new Date(erster); t <= letzter; t.setDate(t.getDate() + 1)) tage.push(dateISO(t));
  const out = {};
  try {
    const days = await listWeek(tage);
    days.forEach((tag) => {
      tag.shifts.forEach((sh) => {
        if (!sh.assignee || sh.assignee.id == null) return;
        const k = String(sh.assignee.id);
        out[k] = Math.round(((out[k] || 0) + (toMin(sh.end) - toMin(sh.start)) / 60) * 10) / 10;
      });
    });
  } catch (e) {}
  return out;
}

// ── Urlaub und Abwesenheit ──────────────────────────────────────────────────
const VAC_KINDS = ['urlaub', 'krank', 'sonstiges'];
const VAC_STATUS = ['pending', 'approved', 'declined'];
const MAX_VAC_DAYS = 90;      // ein Antrag ueber ein Vierteljahr ist ein Tippfehler
const MAX_VAC_READ = 500;

function cleanKind(k) { return VAC_KINDS.indexOf(String(k || '').trim()) >= 0 ? String(k).trim() : 'urlaub'; }
// Tage einschliesslich beider Enden. Reine Kalendertage - keine Zeitzone im Spiel.
function vacDays(from, to) {
  const a = parseISO(from), b = parseISO(to);
  if (!a || !b) return 0;
  const n = Math.round((b - a) / 86400000) + 1;
  return n > 0 ? n : 0;
}
function vacCovers(v, iso) {
  const d = cleanDate(iso);
  return !!(v && d && v.status !== 'declined' && d >= v.from && d <= v.to);
}

async function getVacation(id) {
  if (!hasStore || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', vacKey(String(id))]]); } catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function createVacation(o) {
  o = o || {};
  const person = normPerson({ id: o.employeeId, name: o.name, initials: o.initials });
  let from = cleanDate(o.from), to = cleanDate(o.to) || from;
  if (!hasStore || !person || !from || !to) return null;
  if (to < from) { const t = from; from = to; to = t; }      // rueckwaerts gewaehlt: umdrehen
  const days = vacDays(from, to);
  if (!days || days > MAX_VAC_DAYS) return null;
  try {
    const id = await nextId('u');
    const rec = {
      id: id, employeeId: person.id, name: person.name, initials: person.initials,
      from: from, to: to, days: days, kind: cleanKind(o.kind),
      status: 'pending', note: cleanNote(o.note),
      decidedBy: null, decidedAt: 0, createdAt: Date.now(),
    };
    await redisPipeline([['SET', vacKey(id), JSON.stringify(rec)], ['SADD', VAC_IDX, id]]);
    return rec;
  } catch (e) { return null; }
}

async function listVacations(opts) {
  opts = opts || {};
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', VAC_IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.slice(0, MAX_VAC_READ).map((id) => ['GET', vacKey(id)])); }
  catch (e) { return []; }
  const emp = opts.employeeId == null ? null : String(opts.employeeId).trim();
  const out = [];
  (res || []).forEach((s) => {
    if (!s) return;
    try {
      const v = JSON.parse(s);
      if (emp && String(v.employeeId) !== emp) return;
      if (opts.status && v.status !== opts.status) return;
      if (opts.fromISO && v.to < opts.fromISO) return;
      if (opts.toISO && v.from > opts.toISO) return;
      out.push(v);
    } catch (e) {}
  });
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return out;
}

// Entscheiden ist ein Leitungsakt: wer und wann wird mitgeschrieben.
async function decideVacation(id, ok, who) {
  if (!hasStore || !id) return null;
  try {
    const v = await getVacation(id);
    if (!v) return null;
    v.status = ok ? 'approved' : 'declined';
    v.decidedBy = String((who && who.name) || '').trim().slice(0, MAX_NAME) || null;
    v.decidedAt = Date.now();
    await redisPipeline([['SET', vacKey(v.id), JSON.stringify(v)]]);
    return v;
  } catch (e) { return null; }
}

async function deleteVacation(id) {
  if (!hasStore || !id) return false;
  try {
    const v = await getVacation(id);
    if (!v) return false;
    await redisPipeline([['DEL', vacKey(v.id)], ['SREM', VAC_IDX, v.id]]);
    return true;
  } catch (e) { return false; }
}

// Wer ist an diesem Tag weg? Nur genehmigte und noch offene Antraege zaehlen -
// ein abgelehnter Antrag darf niemanden aus dem Plan nehmen.
function vacationsOn(vacs, iso) {
  return (Array.isArray(vacs) ? vacs : []).filter((v) => vacCovers(v, iso));
}
function isOnVacation(vacs, employeeId, iso) {
  const e = String(employeeId == null ? '' : employeeId).trim();
  if (!e) return false;
  return vacationsOn(vacs, iso).some((v) => String(v.employeeId) === e);
}

// ── Ausschreibungen ─────────────────────────────────────────────────────────
// mode 'apply'   = Bewerbung, die Leitung entscheidet.
// mode 'instant' = Sofort-Uebernahme, wer zuerst zusagt bekommt sie.
const POST_MODES = ['apply', 'instant'];

async function postShift(id, mode, deadline) {
  const m = POST_MODES.indexOf(String(mode || '').trim()) >= 0 ? String(mode).trim() : 'apply';
  const sh = await getShift(id);
  if (!sh) return null;
  return updateShift(id, {
    board: true, postMode: m, assignee: null, applicants: [],
    deadline: deadline == null ? null : String(deadline).trim().slice(0, 40),
  });
}
async function unpostShift(id) {
  const sh = await getShift(id);
  if (!sh) return null;
  return updateShift(id, { board: false, postMode: null, deadline: null, applicants: [] });
}
async function applyForShift(id, person) {
  const p = normPerson(person);
  const sh = await getShift(id);
  if (!p || !sh) return null;
  if (sh.assignee) return null;                       // schon vergeben
  const list = (Array.isArray(sh.applicants) ? sh.applicants : []).slice();
  if (list.some((x) => String(x.id) === p.id)) return sh;
  // Sofort-Uebernahme: wer zuerst zusagt, bekommt sie - ohne Zwischenschritt.
  if (sh.postMode === 'instant') {
    return updateShift(id, { assignee: p, board: false, postMode: null, deadline: null, applicants: [] });
  }
  list.push(p);
  return updateShift(id, { applicants: list });
}
async function withdrawApplication(id, personId) {
  const pid = String(personId == null ? '' : personId).trim();
  const sh = await getShift(id);
  if (!pid || !sh) return null;
  const list = (Array.isArray(sh.applicants) ? sh.applicants : []).filter((x) => String(x.id) !== pid);
  return updateShift(id, { applicants: list });
}
// Zusage: die Schicht geht an eine Person, die Ausschreibung endet, und die
// anderen Bewerbungen sind damit beantwortet - deshalb kommen sie zurueck.
async function acceptApplicant(id, personId) {
  const pid = String(personId == null ? '' : personId).trim();
  const sh = await getShift(id);
  if (!pid || !sh) return null;
  const list = Array.isArray(sh.applicants) ? sh.applicants : [];
  const winner = list.filter((x) => String(x.id) === pid)[0];
  if (!winner) return null;
  const rejected = list.filter((x) => String(x.id) !== pid);
  const updated = await updateShift(id, {
    assignee: winner, board: false, postMode: null, deadline: null, applicants: [],
  });
  return updated ? { shift: updated, accepted: winner, rejected: rejected } : null;
}

// ── Tausch (Schwarzes Brett) ──
async function getSwap(id) {
  if (!hasStore || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', swKey(String(id))]]); } catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// from = der Anfragende ("Ich möchte die Brett-Schicht übernehmen"),
// to   = aktueller Besitzer der Schicht.
async function createSwap(o) {
  o = o || {};
  const from = normPerson(o.from);
  const shiftId = String(o.shiftId || '').trim();
  if (!hasStore || !from || !shiftId) return null;
  try {
    const id = await nextId('w');
    const swap = {
      id: id, shiftId: shiftId, shiftStr: String(o.shiftStr || '').trim().slice(0, 120),
      from: from, to: normPerson(o.to), note: cleanNote(o.note),
      status: 'pending', createdAt: Date.now(),
    };
    await redisPipeline([['SET', swKey(id), JSON.stringify(swap)], ['SADD', SW_IDX, id]]);
    return swap;
  } catch (e) { return null; }
}

async function listSwaps() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', SW_IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', swKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

// Statuswechsel (nur von 'pending' aus). Bei 'accepted' wird die Schicht auf
// den Anfragenden (from) umgeschrieben und vom Schwarzen Brett genommen.
async function setSwapStatus(id, status) {
  if (!hasStore || !id) return null;
  if (['accepted', 'declined', 'withdrawn'].indexOf(status) < 0) return null;
  try {
    const swap = await getSwap(id);
    if (!swap || swap.status !== 'pending') return null;
    if (status === 'accepted') {
      await updateShift(swap.shiftId, { assignee: swap.from, board: false });
    }
    swap.status = status;
    swap.updatedAt = Date.now();
    await redisPipeline([['SET', swKey(swap.id), JSON.stringify(swap)]]);
    return swap;
  } catch (e) { return null; }
}

// ── Team-Chat (1:1) ──
async function getThread(aId, bId) {
  if (!hasStore || aId == null || bId == null) return null;
  const key = tcKey(aId, bId);
  let s;
  try { [s] = await redisPipeline([['GET', key]]); } catch (e) { return null; }
  if (!s) return null;
  try { const t = JSON.parse(s); t.key = key; return t; } catch (e) { return null; }
}

async function listThreads(empId) {
  if (!hasStore || empId == null || String(empId).trim() === '') return [];
  let keys;
  try { [keys] = await redisPipeline([['SMEMBERS', tciKey(String(empId).trim())]]); }
  catch (e) { return []; }
  if (!Array.isArray(keys) || !keys.length) return [];
  let res;
  try { res = await redisPipeline(keys.map((k) => ['GET', k])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s, i) => {
    if (!s) return;
    try { const t = JSON.parse(s); t.key = keys[i]; out.push(t); } catch (e) {}
  });
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// Nachricht senden (legt den Thread bei Bedarf an, aktualisiert shiftStr).
async function postMessage(me, other, text, shiftStr) {
  const m = normPerson(me), o = normPerson(other);
  const t = cleanText(text);
  if (!hasStore || !m || !o || !t || m.id === o.id) return null;
  const key = tcKey(m.id, o.id);
  try {
    let thread = null;
    const [s] = await redisPipeline([['GET', key]]);
    if (s) { try { thread = JSON.parse(s); } catch (e) {} }
    if (!thread) {
      const first = m.id <= o.id ? m : o;
      const second = first === m ? o : m;
      thread = { a: first, b: second, shiftStr: '', messages: [] };
    }
    if (shiftStr != null && String(shiftStr).trim()) thread.shiftStr = String(shiftStr).trim().slice(0, 120);
    thread.messages.push({ from: m.id, text: t, at: Date.now() });
    if (thread.messages.length > MAX_MSGS) thread.messages = thread.messages.slice(-MAX_MSGS);
    thread.updatedAt = Date.now();
    await redisPipeline([
      ['SET', key, JSON.stringify(thread)],
      ['SADD', tciKey(m.id), key],
      ['SADD', tciKey(o.id), key],
    ]);
    thread.key = key;
    return thread;
  } catch (e) { return null; }
}

// ── KI-Matcher (deterministisch, KEIN AI-Call) ──
// Offene Schichten der Woche fair nach Verfügbarkeit verteilen:
//   start < '14:00' -> Slot 'frueh', sonst 'spaet'. 'egal' passt immer,
//   'frei' (bzw. Mitarbeiter ohne gespeicherte Verfügbarkeit) passt nie.
//   Fairness = geringste Wochen-Last (zugewiesen + bereits vorgeschlagen) zuerst.
async function planWeek(dates) {
  const empty = { proposals: [], leftover: [], summary: '0 von 0 Schichten zugewiesen – fair nach Verfügbarkeit verteilt.' };
  try {
    const days = await listWeek(dates);
    const avails = await allAvailabilities();
    const load = {};
    const open = [];
    days.forEach((d) => {
      d.shifts.forEach((sh) => {
        if (sh.assignee && sh.assignee.id != null) {
          const k = String(sh.assignee.id);
          load[k] = (load[k] || 0) + 1;
        } else {
          open.push(sh);
        }
      });
    });
    const proposals = [], leftover = [];
    open.forEach((sh) => {
      const slot = sh.start < '14:00' ? 'frueh' : 'spaet';
      const d = parseISO(sh.date);
      const dow = DAY_KEYS[d ? d.getDay() : 0];
      let best = null, bestLoad = Infinity;
      avails.forEach((av) => {
        const v = (av.days && av.days[dow]) || 'egal';
        if (v === 'frei') return;
        if (v !== 'egal' && v !== slot) return;
        const l = load[String(av.employeeId)] || 0;
        if (l < bestLoad) { best = av; bestLoad = l; }
      });
      if (best) {
        const emp = {
          id: String(best.employeeId),
          name: best.name || ('Mitarbeiter ' + best.employeeId),
          initials: initialsOf(best.name || ('M ' + best.employeeId)),
        };
        load[emp.id] = (load[emp.id] || 0) + 1;
        proposals.push({ shiftId: sh.id, shiftStr: shiftLabel(sh), employee: emp });
      } else {
        leftover.push(shiftLabel(sh));
      }
    });
    return {
      proposals: proposals,
      leftover: leftover,
      summary: proposals.length + ' von ' + open.length + ' Schichten zugewiesen – fair nach Verfügbarkeit verteilt.',
    };
  } catch (e) { return empty; }
}

// Vorschläge übernehmen: [{shiftId, employee:{id,name,initials}}] -> zuweisen.
async function applyPlan(assignments) {
  let applied = 0;
  const list = Array.isArray(assignments) ? assignments : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || !a.shiftId) continue;
    const p = normPerson(a.employee);
    if (!p) continue;
    try { const r = await updateShift(String(a.shiftId), { assignee: p, board: false }); if (r) applied++; }
    catch (e) {}
  }
  return { applied: applied };
}

module.exports = {
  ROLES, DOW, DAY_KEYS, AV_VALUES, VAC_KINDS, VAC_STATUS, POST_MODES, AREAS,
  getStaff, setStaff, removeStaff, allStaff, monthHours,
  mondayOf, addDays, weekDates, shiftLabel, initialsOf,
  listWeek, getShift, createShift, updateShift, deleteShift,
  getAvailability, setAvailability, allAvailabilities,
  getAvailBlocks, setAvailBlocks, allAvailBlocks,
  blocksOfDow, dowOfKey, cleanBlocks, deriveDays, blockHours,
  getVacation, createVacation, listVacations, decideVacation, deleteVacation,
  vacDays, vacCovers, vacationsOn, isOnVacation,
  postShift, unpostShift, applyForShift, withdrawApplication, acceptApplicant,
  createSwap, listSwaps, getSwap, setSwapStatus,
  getThread, listThreads, postMessage,
  planWeek, applyPlan, shiftSpecsFromHours,
  WEEKLY_TEMPLATE, templateSpecs,
  hasStore,
};
