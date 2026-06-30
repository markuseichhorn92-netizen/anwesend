'use strict';

/**
 * POST /api/member/appointment-book   (Authorization: Bearer <token>)
 *   { bookableAppointmentId, startDateTime, endDateTime, instructorIds?, title? }
 * Bucht den Termin direkt in Magicline (APPOINTMENTS_WRITE).
 */

const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  const bid = body.bookableAppointmentId, start = body.startDateTime, end = body.endDateTime;
  if (!bid || !start || !end) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_fields' })); }

  // Buchungsversuche begrenzen.
  try { const okR = await M.rateLimit('book:' + sess.id, 15, 600); if (okR === false) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – bitte kurz warten.' })); } } catch (e) {}

  const payload = {
    customerId: Number(sess.id),
    bookableAppointmentId: Number(bid),
    startDateTime: String(start),
    endDateTime: String(end),
  };
  if (Array.isArray(body.instructorIds) && body.instructorIds.length) {
    const ids = body.instructorIds.map(Number).filter((n) => !isNaN(n));
    if (ids.length) payload.instructorIds = ids;
  }

  let r;
  try { r = await M.ml('POST', '/appointments/booking/book', payload); }
  catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Buchung fehlgeschlagen – bitte später erneut.' })); }

  const ok = r.status >= 200 && r.status < 300;
  const status = (r.json && r.json.bookingStatus) || null;
  if (ok) {
    try {
      await Inbox.addVorgang(sess.id, { type: 'termin', subject: 'Termin gebucht',
        systemText: 'Dein Termin wurde gebucht' + (body.title ? (' (' + String(body.title).slice(0, 60) + ')') : '') + '.' });
    } catch (e) {}
  }
  const msg = ok
    ? (status === 'BOOKED_WITH_CONFIRMATION_REQUIRED'
        ? 'Dein Termin ist eingetragen – das Studio bestätigt ihn noch.'
        : 'Dein Termin ist gebucht! ✓')
    : 'Dieser Termin konnte nicht gebucht werden. Bitte wähle einen anderen Zeitpunkt.';
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: ok, status: status, message: msg, mlStatus: r.status }));
};
