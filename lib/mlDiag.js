'use strict';

/**
 * Magicline-API-Diagnose (NUR LESEN) für den Magicline-Kalender (21.10.2026, Freigabe Markus
 * „nur lesend testen"). Frage: Findet eine regelmäßige Abfrage ohne Webhooks Markus' Termine
 * inkl. Probetrainings? Aufruf über GET /api/team/mitarbeiter-termine?diag=<modus> (Bearer HUB_FEED_KEY).
 *
 * Ausschließlich GET-Anfragen. Ausgabe nur Zählungen, Feldnamen (Pfade), Statuswerte, IDs und
 * höchstens „Vorname N." – keine Nachnamen, E-Mails, Telefonnummern, Adressen.
 * Zeitbudget je Aufruf ~45 s (Function-Limit 60 s). Wirft nie.
 */

const B = require('./mlBooking');

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;
const BUDGET_MS = 45000;

// GET mit Rate-Limit-Headern und Dauer. Methode fest GET – hier wird nie geschrieben.
async function get(path) {
  const t0 = Date.now();
  const c = new AbortController(); const to = setTimeout(() => { try { c.abort(); } catch (e) {} }, 10000);
  let r;
  try { r = await fetch(BASE + path, { method: 'GET', headers: { 'x-api-key': API_KEY, Accept: 'application/json' }, signal: c.signal }); }
  catch (e) { clearTimeout(to); return { status: 0, json: null, ms: Date.now() - t0, rl: {} }; }
  clearTimeout(to);
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  const rl = {};
  try { r.headers.forEach((v, k) => { if (/rate|limit|retry|quota/i.test(k)) rl[k] = String(v).slice(0, 60); }); } catch (e) {}
  return { status: r.status, json, ms: Date.now() - t0, rl };
}

function listOf(j) { return Array.isArray(j) ? j : (j && Array.isArray(j.result) ? j.result : []); }

// Feldpfade (ohne Werte), Arrays als []. Tiefe begrenzt.
function keyPaths(o, prefix, out, depth) {
  out = out || new Set(); prefix = prefix || ''; depth = depth || 0;
  if (depth > 4 || o == null || typeof o !== 'object') return out;
  if (Array.isArray(o)) { o.slice(0, 5).forEach((x) => keyPaths(x, prefix + '[]', out, depth + 1)); return out; }
  Object.keys(o).forEach((k) => { const p = prefix ? prefix + '.' + k : k; out.add(p); keyPaths(o[k], p, out, depth + 1); });
  return out;
}

// Pfade, an denen ein bestimmter Wert (z. B. Mitarbeiter-ID) vorkommt.
function findValue(o, want, prefix, out, depth) {
  out = out || []; prefix = prefix || ''; depth = depth || 0;
  if (depth > 6 || o == null) return out;
  if (typeof o !== 'object') { if (String(o) === String(want)) out.push(prefix); return out; }
  if (Array.isArray(o)) { o.forEach((x, i) => findValue(x, want, prefix + '[' + i + ']', out, depth + 1)); return out; }
  Object.keys(o).forEach((k) => findValue(o[k], want, prefix ? prefix + '.' + k : k, out, depth + 1));
  return out;
}

// Ressourcen/Instructors ohne Namen: Namensfelder nur als Typ-Platzhalter.
function safeRes(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 10).map((x) => {
    const o = {};
    if (!x || typeof x !== 'object') return o;
    Object.keys(x).forEach((k) => {
      const v = x[k];
      if (/name|mail|phone|first|last/i.test(k)) { o[k] = '<' + typeof v + '>'; return; }
      if (v == null || typeof v !== 'object') o[k] = v; else o[k] = '<' + (Array.isArray(v) ? 'array' : 'object') + '>';
    });
    return o;
  });
}

function countBy(list, field) {
  const m = {};
  list.forEach((x) => { const v = x && x[field] != null ? String(x[field]) : '(fehlt)'; m[v] = (m[v] || 0) + 1; });
  return m;
}

function statusFields(x) { return Object.keys(x || {}).filter((k) => /status|type|state|prospect|lead|member/i.test(k) && (x[k] == null || typeof x[k] !== 'object')); }

// (1) Kundenliste: Gesamtzahl, Statusverteilung, Feldnamen, Wirkung von Filterparametern.
async function customers(opts) {
  const t0 = Date.now();
  const out = { pages: 0, total: 0, statusFields: {}, sampleKeys: [], filters: {}, msPerPage: null, rateHeaders: {}, complete: false };
  let offset = null; const all = [];
  for (let page = 0; page < 400; page++) {
    if (Date.now() - t0 > BUDGET_MS - 8000) break;
    const r = await get('/customers?sliceSize=100' + (offset != null ? '&offset=' + encodeURIComponent(offset) : ''));
    if (page === 0) { out.firstStatus = r.status; out.rateHeaders = r.rl; out.envelopeKeys = r.json && !Array.isArray(r.json) ? Object.keys(r.json) : (Array.isArray(r.json) ? ['<array>'] : []); }
    if (r.status !== 200) { out.lastStatus = r.status; break; }
    out.pages++; out.msPerPage = (out.msPerPage == null ? r.ms : Math.round((out.msPerPage * (out.pages - 1) + r.ms) / out.pages));
    const list = listOf(r.json);
    list.forEach((c) => all.push(c));
    if (page === 0 && list[0]) out.sampleKeys = Array.from(keyPaths(list[0])).filter((k) => k.split('.').length <= 2).sort();
    if (!r.json || !r.json.hasNext || !list.length) { out.complete = true; break; }
    offset = r.json.offset != null ? r.json.offset : null;
    if (offset == null) break;
  }
  out.total = all.length;
  const sf = new Set(); all.slice(0, 50).forEach((c) => statusFields(c).forEach((k) => sf.add(k)));
  sf.forEach((k) => { out.statusFields[k] = countBy(all, k); });
  // Filterversuche (nur 1 Seite, Anzahl + Status der Antwort)
  if (opts.filters !== false) {
    for (const q of ['customerStatus=PROSPECT', 'status=PROSPECT', 'customerStatus=MEMBER', 'customerStatus=FORMER_MEMBER']) {
      if (Date.now() - t0 > BUDGET_MS) break;
      const r = await get('/customers?sliceSize=100&' + q);
      const l = listOf(r.json);
      out.filters[q] = { status: r.status, n: l.length, hasNext: !!(r.json && r.json.hasNext), verteilung: sf.size ? countBy(l, Array.from(sf)[0]) : null };
    }
  }
  out.ms = Date.now() - t0;
  out._ids = all.map((c) => ({ id: c && c.id, st: c && (c.customerStatus || c.status || null) }));
  return out;
}

// (2) Probetraining-/Lead-Endpunkte abtasten (nur Statuscodes + Feldnamen + Anzahl).
async function trialProbe() {
  const now = new Date(); const d = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  const paths = [
    '/trial-sessions', '/trialsessions', '/trialsession', '/trial-offers', '/trialoffers',
    '/appointments/trial-sessions', '/appointments/trialsession', '/appointments/booking',
    '/appointments/booking?startDate=' + d(0) + '&endDate=' + d(7),
    '/appointments?startDate=' + d(0) + '&endDate=' + d(7),
    '/appointments/bookable?sliceSize=100', '/leads', '/leads/config', '/prospects',
    '/customers/prospects', '/employees/1210006580', '/employees/1210006580/appointments',
    '/resources', '/appointments/resources', '/studios', '/class-slots', '/classes',
  ];
  const out = {};
  for (const p of paths) {
    const r = await get(p);
    const l = listOf(r.json);
    out[p] = {
      status: r.status,
      n: Array.isArray(r.json) || (r.json && r.json.result) ? l.length : null,
      keys: r.status === 200 && r.json ? Array.from(keyPaths(l[0] || r.json)).filter((k) => k.split('.').length <= 2 && !/mail|phone|street|birth/i.test(k)).slice(0, 40) : undefined,
      err: r.status !== 200 && r.json ? String(r.json.message || r.json.error || r.json.errorCode || '').slice(0, 120) || null : undefined,
    };
  }
  return out;
}

// Buchungen eines Kunden: Liste + Detail, Feldnamen, Fundstellen der Mitarbeiter-ID.
async function bookingsFor(cid, employeeId, withKeys) {
  const r = await get('/appointments/booking?customerId=' + encodeURIComponent(cid));
  const list = listOf(r.json);
  const res = { status: r.status, n: list.length, ms: r.ms, rl: r.rl, bookings: [] };
  if (withKeys && list[0]) res.listKeys = Array.from(keyPaths(list[0])).sort();
  for (const a of list.slice(0, 15)) {
    const bid = a && (a.bookingId != null ? a.bookingId : a.id);
    const d = bid != null ? await get('/appointments/booking/' + encodeURIComponent(bid)) : { status: 0, json: null };
    const j = d.json || {};
    const b = {
      bookingId: bid, start: a.startDateTime || j.startDateTime || null, title: a.title || j.title || null, category: j.category || null,
      bookingStatus: j.bookingStatus || a.bookingStatus || null, detailStatus: d.status,
      employeeIdInList: findValue(a, employeeId), employeeIdInDetail: findValue(j, employeeId),
      instructors: safeRes(j.instructors), resources: safeRes(j.resources || j.bookedResources || j.resourceAssignments),
    };
    if (withKeys) b.detailKeys = Array.from(keyPaths(j)).sort();
    res.bookings.push(b);
  }
  return res;
}

// (3) Markus' Testtermin: Kunde per E-Mail/Kunden-ID suchen, Buchungen + Detail prüfen.
async function findMarkus(q, employeeId) {
  const out = { lookups: [] };
  let cid = q.customerId && /^\d{1,20}$/.test(q.customerId) ? q.customerId : null;
  for (const e of (q.emails || [])) {
    if (cid) break;
    const r = await get('/customers/by?email=' + encodeURIComponent(e));
    const l = r.json ? (Array.isArray(r.json) ? r.json : (r.json.id != null ? [r.json] : listOf(r.json))) : [];
    out.lookups.push({ status: r.status, n: l.length });
    if (l[0] && l[0].id != null) { cid = String(l[0].id); out.customerStatus = l[0].customerStatus || l[0].status || null; out.name = B.shortName(l[0].firstName, l[0].lastName); }
  }
  const emp = await get('/employees/' + encodeURIComponent(employeeId));
  out.employee = { status: emp.status, keys: emp.json ? Array.from(keyPaths(emp.json)).filter((k) => !/mail|phone|address|birth|street/i.test(k)).sort() : [] };
  if (emp.json && emp.json.customerId != null && !cid) cid = String(emp.json.customerId);
  out.customerId = cid;
  if (cid) out.bookings = await bookingsFor(cid, employeeId, true);
  return out;
}

// (4) Scan: Buchungen für einen Ausschnitt der Kundenliste (Aufwand messen, Treffer zählen).
async function scan(offsetIdx, limit, employeeId, statusFilter) {
  const t0 = Date.now();
  const c = await customers({ filters: false });
  let ids = c._ids;
  if (statusFilter) ids = ids.filter((x) => String(x.st || '').toUpperCase() === statusFilter.toUpperCase());
  const part = ids.slice(offsetIdx, offsetIdx + limit);
  const out = { customersTotal: c.total, customersListComplete: c.complete, listMs: c.ms, filter: statusFilter || null, candidates: ids.length, scanned: 0, withBookings: 0, bookings: 0,
    hitsMarkus: [], resourceTypes: {}, msPerCustomer: null, statusCodes: {}, rateHeaders: {} };
  const PAR = 4; let i = 0; const tScan = Date.now();
  async function worker() {
    while (i < part.length && Date.now() - t0 < BUDGET_MS) {
      const x = part[i++];
      const r = await get('/appointments/booking?customerId=' + encodeURIComponent(x.id));
      out.scanned++; out.statusCodes[r.status] = (out.statusCodes[r.status] || 0) + 1;
      if (Object.keys(r.rl).length) out.rateHeaders = r.rl;
      const l = listOf(r.json);
      if (l.length) { out.withBookings++; out.bookings += l.length; }
      for (const a of l.slice(0, 10)) {
        if (Date.now() - t0 > BUDGET_MS) break;
        const bid = a && (a.bookingId != null ? a.bookingId : a.id); if (bid == null) continue;
        const d = await get('/appointments/booking/' + encodeURIComponent(bid));
        const j = d.json || {};
        (Array.isArray(j.resources) ? j.resources : []).forEach((rs) => { const t = String((rs && (rs.type || rs.resourceType)) || '(ohne)'); out.resourceTypes[t] = (out.resourceTypes[t] || 0) + 1; });
        const hit = findValue(j, employeeId);
        if (hit.length) out.hitsMarkus.push({ bookingId: bid, start: j.startDateTime || a.startDateTime, title: j.title || a.title, customerStatus: x.st, paths: hit });
      }
    }
  }
  await Promise.all(Array.from({ length: PAR }, worker));
  out.msPerCustomer = out.scanned ? Math.round((Date.now() - tScan) / out.scanned * PAR) : null;
  out.nextOffset = offsetIdx + out.scanned;
  out.ms = Date.now() - t0;
  return out;
}

async function run(mode, q) {
  if (!API_KEY) return { ok: false, error: 'no_ml_key' };
  q = q || {};
  const employeeId = /^\d{1,20}$/.test(String(q.employeeId || '')) ? String(q.employeeId) : '1210006580';
  try {
    if (mode === 'customers') { const c = await customers({}); delete c._ids; return { ok: true, customers: c }; }
    if (mode === 'trial') return { ok: true, trial: await trialProbe() };
    if (mode === 'markus') return { ok: true, markus: await findMarkus(q, employeeId) };
    if (mode === 'scan') return { ok: true, scan: await scan(Math.max(0, parseInt(q.offset || '0', 10) || 0), Math.min(400, Math.max(1, parseInt(q.limit || '100', 10) || 100)), employeeId, q.status || null) };
    return { ok: false, error: 'unknown_mode' };
  } catch (e) { return { ok: false, error: 'diag_failed' }; }
}

module.exports = { run, keyPaths, findValue, safeRes };
