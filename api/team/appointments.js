'use strict';

/**
 * Team-Backend: Termine.
 *   GET  ?memberId=<id>          -> { ok, appointments:[{bookingId,title,start,end}] }
 *                                   Termine eines Mitglieds (403/leer -> []).
 *   GET  ?from=<iso>&to=<iso>    -> { ok, available, appointments:[…] }
 *                                   Studio-weite Terminübersicht (best effort). Kennt die
 *                                   Open API den customerId-losen Abruf nicht (403/400/unbekannt),
 *                                   degradieren wir sauber zu available:false.
 *   POST { action:'cancel', bookingId }               -> Termin absagen
 *                                   (Muster wie api/member/appointment-cancel.js: DELETE
 *                                   /appointments/booking/{id}). { ok } bzw. { ok:false, message }.
 *   POST { action:'book', memberId, title, start, … } -> Termin best-effort eintragen.
 *                                   Liegt eine buchbare Slot-ID vor, versuchen wir die echte
 *                                   Open-API-Buchung; klappt sie nicht (unsicher!) -> Fallback:
 *                                   Inbox-Vorgang (type 'termin') + Studio-Benachrichtigung.
 *                                   Antwort { ok:true, via:'fallback', message:… }. Der Wunsch
 *                                   geht nie verloren.
 *
 * Graceful Degradation: Jeder Magicline-Zugriff ist 403-/fehlersicher; nichts wirft.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');
const Studio = require('../../lib/studioReply');
const MlEvents = require('../../lib/mlEvents');

// Stornierte/abgesagte Buchungen erkennen (Magicline liefert sie weiter in der Liste).
function isCancelledAppt(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true || a.deleted === true) return true;
  if (a.active === false) return true;
  const s = [a.status, a.appointmentStatus, a.bookingStatus, a.state].filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN|DELET|ABGESAGT|ABGELEHNT|NO_?SHOW|DECLIN/.test(s);
}

function mapAppt(a) {
  return {
    bookingId: a.bookingId != null ? a.bookingId : (a.id != null ? a.id : (a.appointmentId != null ? a.appointmentId : null)),
    title: a.title || a.name || 'Termin',
    start: a.startDateTime || null,
    end: a.endDateTime || null,
  };
}

// Termine eines Mitglieds. 403/Fehler/leer -> [].
async function memberAppointments(memberId) {
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(memberId));
    const list = Array.isArray(r.json) ? r.json : [];
    return list.filter((a) => !isCancelledAppt(a)).map(mapAppt).filter((a) => a.start)
      .sort((x, y) => new Date(x.start) - new Date(y.start));
  } catch (e) { return []; }
}

// Studio-weite Terminübersicht.
// WICHTIG: Die Magicline Open API kennt KEINEN studioweiten Terminabruf – jeder
// Booking-Endpunkt ist kundengebunden (customerId Pflicht). Der customerId-lose
// Versuch bleibt best effort (falls Magicline ihn je freischaltet), die eigentliche
// Datenquelle ist der studioweite LIVE-Feed aus den APPOINTMENT_BOOKING_*-Webhooks.
// Der Feed füllt sich vorwärts: Termine, die seit Aktivierung neu gebucht/geändert
// wurden. Bereits vorher bestehende Termine liefert Magicline NICHT nach.
// Rückgabe: { available, appointments, source, feedReady }.
async function studioAppointments(from, to) {
  // 1) Direkter (customerId-loser) API-Abruf – i. d. R. nicht unterstützt (nur best effort).
  let apiOk = false; let apiList = []; let apiStatus = 0;
  try {
    const qs = [];
    if (from) qs.push('from=' + encodeURIComponent(from));
    if (to) qs.push('to=' + encodeURIComponent(to));
    const r = await M.ml('GET', '/appointments/booking' + (qs.length ? ('?' + qs.join('&')) : ''));
    apiStatus = r.status || 0;
    if ((r.status >= 200 && r.status < 300) && Array.isArray(r.json)) {
      apiOk = true;
      apiList = r.json.filter((a) => !isCancelledAppt(a)).map(mapAppt).filter((a) => a.start);
    }
  } catch (e) {}
  // 2) Studioweiter LIVE-Feed aus den Webhooks (APPOINTMENT_BOOKING_*).
  let feed = [];
  try { feed = await MlEvents.listAppointments(from, to); } catch (e) {}
  const feedReady = !!MlEvents.hasStore;   // Feed-Mechanik grundsätzlich einsatzbereit?
  // 3) Mergen (dedupe über bookingId), API hat Vorrang.
  const byId = {};
  apiList.forEach((a) => { if (a.bookingId != null) byId[String(a.bookingId)] = a; });
  feed.forEach((f) => { const k = String(f.bookingId); if (!byId[k]) byId[k] = { bookingId: f.bookingId, title: f.title, start: f.start, end: f.end || null }; });
  const appointments = Object.keys(byId).map((k) => byId[k]).filter((a) => a.start)
    .sort((x, y) => new Date(x.start) - new Date(y.start)).slice(0, 300);
  // Nicht-personenbezogene Diagnose (nur Status/Zähler) für die Vercel-Logs.
  try { console.log('[studio-appts]', JSON.stringify({ apiStatus: apiStatus, apiOk: apiOk, feed: feed.length, feedReady: feedReady })); } catch (e) {}
  const source = apiOk ? 'api' : (feed.length ? 'feed' : (feedReady ? 'feed_empty' : 'none'));
  // "available": Der Kalender kann angezeigt werden, sobald wir eine Quelle haben ODER
  // der Live-Feed grundsätzlich bereit ist (leerer Feed = "noch keine Termine", NICHT "kaputt").
  return { available: apiOk || feedReady, appointments: appointments, source: source, feedReady: feedReady };
}

// Termin absagen – exakt nach dem Muster aus api/member/appointment-cancel.js
// (DELETE /appointments/booking/{id}). Ohne Member-Session, daher keine
// Eigentümer-Prüfung: das Team darf jeden Termin absagen.
async function cancelBooking(bookingId) {
  try {
    const r = await M.ml('DELETE', '/appointments/booking/' + encodeURIComponent(bookingId));
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) { return { ok: false, status: 0 }; }
}

// Buchbare Terminarten des Studios (BOOKABLE_APPOINTMENTS_READ). 403/Fehler -> available:false.
async function loadBookable() {
  try {
    const r = await M.ml('GET', '/appointments/bookable?sliceSize=100');
    if (!(r.status >= 200 && r.status < 300)) return { available: false, types: [] };
    const arr = (r.json && Array.isArray(r.json.result)) ? r.json.result : (Array.isArray(r.json) ? r.json : []);
    const types = arr.map((a) => ({ id: a.id, title: a.title || 'Termin', duration: a.duration || null, category: a.category || '' })).filter((t) => t.id != null);
    return { available: true, types: types };
  } catch (e) { return { available: false, types: [] }; }
}

const SLOT_WINDOW = 6;   // max. daysAhead laut API
function ymd(d) { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

// Freie Slots einer Terminart für ein bestimmtes Mitglied (echte Verfügbarkeit).
// Mehrere 6-Tage-Fenster zusammengeführt; Vergangenes raus, nach Startzeit sortiert.
async function loadMemberSlots(bookableId, memberId, days) {
  days = days || 21; if (!(days > 0)) days = 21; if (days > 42) days = 42;
  const starts = []; const today = new Date();
  for (let off = 0; off < days; off += SLOT_WINDOW) { const d = new Date(today.getTime()); d.setDate(d.getDate() + off); starts.push(ymd(d)); }
  const cid = memberId != null ? ('&customerId=' + encodeURIComponent(memberId)) : '';
  const base = '/appointments/bookable/' + encodeURIComponent(bookableId) + '/slots';
  try {
    const results = await Promise.all(starts.map((sd) =>
      M.ml('GET', base + '?daysAhead=' + SLOT_WINDOW + '&slotWindowStartDate=' + sd + cid)
        .then((r) => Array.isArray(r.json) ? r.json : []).catch(() => [])));
    const seen = {}, out = [], now = Date.now();
    results.forEach((arr) => arr.forEach((s) => {
      if (!s || !s.startDateTime || seen[s.startDateTime]) return;
      const t = Date.parse(s.startDateTime); if (!isNaN(t) && t <= now) return;
      seen[s.startDateTime] = 1;
      const ins = Array.isArray(s.instructors) ? s.instructors : [];
      const first = ins[0] || null;
      out.push({ start: s.startDateTime, end: s.endDateTime || null,
        instructorIds: ins.map((i) => i.id).filter((x) => x != null),
        instructor: first ? (first.publicName || ((first.firstName || '') + ' ' + (first.lastName || '')).trim()) : '' });
    }));
    out.sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0));
    return out;
  } catch (e) { return []; }
}

// Echte Open-API-Buchung – nur wenn eine buchbare Terminart-ID (+ Start/Ende)
// vorliegt (Muster aus api/member/appointment-book.js). Sonst gar nicht versucht.
async function attemptOpenApiBook(body) {
  const bid = body.bookableAppointmentId;
  const start = body.start || body.startDateTime;
  const end = body.end || body.endDateTime;
  const memberId = body.memberId;
  if (bid == null || !start || !end || memberId == null) return { attempted: false, ok: false };
  const payload = {
    customerId: Number(memberId),
    bookableAppointmentId: Number(bid),
    startDateTime: String(start),
    endDateTime: String(end),
  };
  if (Array.isArray(body.instructorIds) && body.instructorIds.length) {
    const ids = body.instructorIds.map(Number).filter((n) => !isNaN(n));
    if (ids.length) payload.instructorIds = ids;
  }
  try {
    const r = await M.ml('POST', '/appointments/booking/book', payload);
    const ok = r.status >= 200 && r.status < 300;
    return { attempted: true, ok: ok, status: r.status, bookingStatus: (r.json && r.json.bookingStatus) || null };
  } catch (e) { return { attempted: true, ok: false, status: 0 }; }
}

// Fallback: Buchungswunsch dauerhaft festhalten (Inbox-Vorgang) UND das Studio
// benachrichtigen. So geht der Wunsch nie verloren, auch wenn die Open-API-Buchung
// nicht möglich ist. Liefert immer ok:true / via:'fallback'.
async function bookFallback(memberId, title, start) {
  const startTxt = start ? String(start) : '';
  let vorgang = null;
  try {
    vorgang = await Inbox.addVorgang(memberId, {
      type: 'termin',
      subject: 'Termin eintragen: ' + title,
      systemText: 'Das Team möchte einen Termin eintragen: ' + title + (startTxt ? (' – ' + startTxt) : '') + '.',
      teamStatus: 'bearbeitung',
    });
  } catch (e) {}
  try {
    let mem = null; try { mem = await M.getMember(memberId); } catch (e) {}
    await Studio.notifyStudio({
      member: mem || { id: memberId },
      vorgang: vorgang || {},
      subject: '📅 Termin eintragen – ' + title,
      text: 'Für ein Mitglied soll ein Termin eingetragen werden.\n\n'
        + 'Termin: ' + title + (startTxt ? ('\nWunschzeit: ' + startTxt) : '')
        + '\nMitglied-ID: ' + memberId
        + '\n\n(Eine automatische Buchung über die Open API war nicht möglich – bitte im Magicline-Kalender manuell eintragen.)',
    });
  } catch (e) {}
  return { ok: true, via: 'fallback', message: 'Wunsch ans Studio übergeben.' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'appointments.manage', res)) return;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const memberId = url.searchParams.get('memberId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    // Buchbare Terminarten (für den echten Buchungs-Ablauf im Profil).
    if (url.searchParams.get('bookable')) {
      const b = await loadBookable();
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: b.available, types: b.types }));
    }
    // Freie Slots einer Terminart für ein Mitglied.
    const slotsFor = url.searchParams.get('slotsFor');
    if (slotsFor) {
      if (!/^\d+$/.test(String(slotsFor))) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_id' })); }
      const days = parseInt(url.searchParams.get('days') || '21', 10);
      const slots = await loadMemberSlots(slotsFor, memberId, days);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, slots: slots }));
    }
    if (memberId) {
      const appointments = await memberAppointments(memberId);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, appointments }));
    }
    if (from || to) {
      const r = await studioAppointments(from, to);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: r.available, appointments: r.appointments, source: r.source }));
    }
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_params' }));
  }

  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const action = body.action;

    if (action === 'cancel') {
      const bookingId = body.bookingId;
      if (bookingId == null || bookingId === '') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_bookingId' })); }
      const r = await cancelBooking(bookingId);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: r.ok, message: r.ok ? 'Termin abgesagt.' : 'Absage fehlgeschlagen – bitte später erneut.' }));
    }

    if (action === 'book') {
      const memberId = body.memberId != null ? String(body.memberId).trim() : '';
      if (!memberId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' })); }
      const title = (String(body.title || '').slice(0, 120).trim()) || 'Termin';
      const start = body.start != null ? String(body.start).trim() : '';
      const tried = await attemptOpenApiBook(body);
      if (tried.attempted && tried.ok) {
        const msg = tried.bookingStatus === 'BOOKED_WITH_CONFIRMATION_REQUIRED'
          ? 'Termin eingetragen – das Studio bestätigt ihn noch.'
          : 'Termin verbindlich in Magicline gebucht. ✓';
        res.statusCode = 200; return res.end(JSON.stringify({ ok: true, via: 'openapi', bookingStatus: tried.bookingStatus || null, message: msg }));
      }
      const fb = await bookFallback(memberId, title, start);
      res.statusCode = 200; return res.end(JSON.stringify(fb));
    }

    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
