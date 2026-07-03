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
const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');
const Studio = require('../../lib/studioReply');

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

// Studio-weite Terminübersicht (best effort). Wir versuchen den customerId-losen
// Abruf mit from/to; nur ein 2xx mit Array gilt als verfügbar – sonst available:false,
// die UI blendet die Karte dann aus. Ergebnis konservativ gekappt.
async function studioAppointments(from, to) {
  try {
    const qs = [];
    if (from) qs.push('from=' + encodeURIComponent(from));
    if (to) qs.push('to=' + encodeURIComponent(to));
    const r = await M.ml('GET', '/appointments/booking' + (qs.length ? ('?' + qs.join('&')) : ''));
    if (!(r.status >= 200 && r.status < 300) || !Array.isArray(r.json)) return { available: false, appointments: [] };
    const appointments = r.json.filter((a) => !isCancelledAppt(a)).map(mapAppt).filter((a) => a.start)
      .sort((x, y) => new Date(x.start) - new Date(y.start)).slice(0, 200);
    return { available: true, appointments };
  } catch (e) { return { available: false, appointments: [] }; }
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

// Best-effort echte Open-API-Buchung – nur wenn eine buchbare Slot-ID (+ Start/Ende)
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
  try {
    const r = await M.ml('POST', '/appointments/booking/book', payload);
    return { attempted: true, ok: r.status >= 200 && r.status < 300, status: r.status };
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
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const memberId = url.searchParams.get('memberId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (memberId) {
      const appointments = await memberAppointments(memberId);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, appointments }));
    }
    if (from || to) {
      const r = await studioAppointments(from, to);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: r.available, appointments: r.appointments }));
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
        res.statusCode = 200; return res.end(JSON.stringify({ ok: true, via: 'openapi', message: 'Termin in Magicline eingetragen.' }));
      }
      const fb = await bookFallback(memberId, title, start);
      res.statusCode = 200; return res.end(JSON.stringify(fb));
    }

    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
