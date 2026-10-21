'use strict';

/**
 * GET /api/team/mitarbeiter-termine?employeeId=<id>&days=60
 *   -> { ok, employeeId, days, pending, appointments:[{bookingId,title,category,start,end,status,member}] }
 *   Künftige Termine (ab heute, Studio-Zeit), denen der Mitarbeiter in Magicline als Instructor
 *   zugewiesen ist. Quelle: studioweiter Termin-Feed aus den APPOINTMENT_BOOKING_*-Webhooks
 *   (lib/mlEvents). Stornierte raus. Feed-Einträge ohne Mitarbeiter-Zuordnung (Altbestand vor dem
 *   Detail-Abruf) werden per GET /appointments/booking/{id} nachgeladen und zurückgeschrieben –
 *   höchstens MAX_ENRICH je Aufruf, der Rest beim nächsten Mal (pending = noch offen).
 *   member = „Vorname N." (datensparsam). Nutzer: Familien-Hub (Kalender „Fit-Inn Termine").
 *
 * GET /api/team/mitarbeiter-termine?email=<adresse>
 *   -> { ok, employeeId }  NUR die Mitarbeiter-ID (Einrichtung), Abgleich über GET /employees.
 *
 * POST /api/team/mitarbeiter-termine  { action:'nachlauf', customerIds:[…] }   (VORBEREITET)
 *   Einmaliger Nachlauf für Termine vor dem Webhook-Start: je Kunde GET /appointments/booking
 *   ?customerId= (±2 Wochen laut API), jede Buchung mit Details in den Feed. Max. 25 Kunden je
 *   Aufruf. Nur auf ausdrückliche Freigabe ausführen.
 *
 * Absicherung: Authorization: Bearer <HUB_FEED_KEY> (zeitkonstanter Vergleich). Ohne gesetzte
 * Variable ist der Endpunkt AUS (503), falscher/fehlender Schlüssel -> 401. Keine Team-Sitzung.
 */

const crypto = require('node:crypto');
const MlEvents = require('../../lib/mlEvents');
const B = require('../../lib/mlBooking');

const MAX_ENRICH = 40;
const MAX_NACHLAUF = 25;
const TZ = 'Europe/Berlin';

function send(res, code, obj) { res.statusCode = code; res.end(JSON.stringify(obj)); }

function keyOk(req) {
  const want = String(process.env.HUB_FEED_KEY || '');
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!want || !m) return false;
  // Hash auf gleiche Länge, dann timingSafeEqual (verrät auch die Länge nicht)
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function todayStudio(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
  return p; // YYYY-MM-DD
}

// Ende eines Termins (ISO mit oder ohne Offset) grob vergleichbar machen: ohne Offset = Studio-Zeit,
// für den Filter „ab heute" reicht der Tagesvergleich.
function dayOf(iso) { const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }

function pub(a) {
  return {
    bookingId: String(a.bookingId), title: a.title || 'Termin', category: a.category || null,
    start: a.start, end: a.end || null,
    status: a.appointmentStatus || a.bookingStatus || null,
    member: a.memberName || null,
  };
}

async function mitarbeiterTermine(employeeId, days, now) {
  const from = todayStudio(now);
  const list = await MlEvents.listAppointmentsSpan(from, days);
  const offen = list.filter((a) => !a.detailAt || !Array.isArray(a.instructorIds));
  const neu = offen.length ? await B.enrichMany(offen, MAX_ENRICH, 4) : new Map();
  const alle = list.map((a) => neu.get(String(a.bookingId)) || a);
  const pending = alle.filter((a) => !a.detailAt || !Array.isArray(a.instructorIds)).length;
  const meine = alle.filter((a) => Array.isArray(a.instructorIds) && a.instructorIds.indexOf(String(employeeId)) >= 0)
    .filter((a) => !B.isCancelled(a))
    .filter((a) => (dayOf(a.end || a.start) || '') >= from)
    .map(pub);
  return { appointments: meine, pending: pending, scanned: list.length };
}

// Vorbereiteter Nachlauf (nicht automatisch): Buchungen bekannter Kunden in den Feed holen.
async function nachlauf(customerIds) {
  const M = require('../../lib/members');
  const ids = (Array.isArray(customerIds) ? customerIds : []).map((x) => String(x).trim()).filter((x) => /^\d{1,20}$/.test(x)).slice(0, MAX_NACHLAUF);
  let gefunden = 0, gespeichert = 0;
  for (const cid of ids) {
    let r; try { r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(cid)); } catch (e) { r = null; }
    const arr = r && Array.isArray(r.json) ? r.json : [];
    for (const a of arr) {
      const bid = a && (a.bookingId != null ? a.bookingId : a.id);
      if (bid == null || !a.startDateTime) continue;
      gefunden++;
      const ok = await MlEvents.upsertAppointment({ bookingId: bid, title: a.title || 'Termin', start: a.startDateTime, end: a.endDateTime || null, customerId: cid });
      if (ok && await B.enrich({ bookingId: String(bid), title: a.title, start: a.startDateTime, end: a.endDateTime, customerId: cid })) gespeichert++;
    }
  }
  return { kunden: ids.length, gefunden: gefunden, gespeichert: gespeichert };
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (!process.env.HUB_FEED_KEY) return send(res, 503, { ok: false, error: 'not_configured' });
  if (!keyOk(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET') {
    // Nur-Lese-Diagnose der Magicline-API (21.10.2026): ?diag=customers|trial|markus|scan
    const diag = url.searchParams.get('diag');
    if (diag != null) {
      const q = { employeeId: url.searchParams.get('employeeId'), customerId: url.searchParams.get('customerId'),
        emails: url.searchParams.getAll('email').slice(0, 3), offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'), status: url.searchParams.get('status') };
      const r = await require('../../lib/mlDiag').run(String(diag), q);
      return send(res, r.ok ? 200 : 400, r);
    }
    const email = url.searchParams.get('email');
    if (email != null) {
      const e = String(email).trim();
      if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(e)) return send(res, 400, { ok: false, error: 'bad_email' });
      const TS = require('../../lib/teamStaff');
      const emp = await TS.findEmployeeByEmail(e);
      if (!emp) return send(res, 404, { ok: false, error: 'not_found' });
      return send(res, 200, { ok: true, employeeId: String(emp.id) });   // NUR die ID
    }
    const employeeId = String(url.searchParams.get('employeeId') || '').trim();
    if (!/^\d{1,20}$/.test(employeeId)) return send(res, 400, { ok: false, error: 'bad_employeeId' });
    let days = parseInt(url.searchParams.get('days') || '60', 10);
    if (!(days > 0)) days = 60; if (days > 90) days = 90;
    if (!MlEvents.hasStore) return send(res, 503, { ok: false, error: 'no_store' });
    const r = await mitarbeiterTermine(employeeId, days);
    try { console.log('[mitarbeiter-termine]', JSON.stringify({ n: r.appointments.length, scanned: r.scanned, pending: r.pending })); } catch (e) {}
    return send(res, 200, { ok: true, employeeId: employeeId, days: days, pending: r.pending, appointments: r.appointments });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await require('../../lib/members').readBody(req); } catch (e) { body = {}; }
    if (body && body.action === 'nachlauf') {
      if (!MlEvents.hasStore) return send(res, 503, { ok: false, error: 'no_store' });
      const r = await nachlauf(body.customerIds);
      return send(res, 200, Object.assign({ ok: true }, r));
    }
    return send(res, 400, { ok: false, error: 'unknown_action' });
  }
  return send(res, 405, { ok: false, error: 'method_not_allowed' });
}

module.exports = handler;
module.exports._intern = { mitarbeiterTermine, nachlauf, keyOk, todayStudio };
