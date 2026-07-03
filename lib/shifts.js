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
 *   shf:avi                 SET aller employeeIds mit Verfügbarkeit (für planWeek)
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
const vKey = (id) => 'shf:v:' + id;
const dKey = (date) => 'shf:d:' + date;
const avKey = (id) => 'shf:av:' + id;
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
      board: false, applicants: [], createdAt: now, updatedAt: now,
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
  ROLES, DOW, DAY_KEYS, AV_VALUES,
  mondayOf, addDays, weekDates, shiftLabel, initialsOf,
  listWeek, getShift, createShift, updateShift, deleteShift,
  getAvailability, setAvailability, allAvailabilities,
  createSwap, listSwaps, getSwap, setSwapStatus,
  getThread, listThreads, postMessage,
  planWeek, applyPlan,
  hasStore,
};
