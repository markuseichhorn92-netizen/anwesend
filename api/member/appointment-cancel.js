'use strict';

/**
 * POST /api/member/appointment-cancel   (Authorization: Bearer <token>)
 *   { bookingId }
 * Storniert einen Termin direkt in Magicline (DELETE /v1/appointments/booking/{id},
 * APPOINTMENTS_WRITE). Vorher wird geprüft, dass der Termin dem Mitglied gehört.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  const body = await M.readBody(req);
  const id = body.bookingId;
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_bookingId' })); }

  try {
    // Sicherstellen, dass der Termin dem angemeldeten Mitglied gehört
    const lr = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(sess.id));
    const listOk = lr.status === 200 && Array.isArray(lr.json);
    if (!listOk) {
      // Konnten die Terminliste nicht laden (Magicline gerade nicht erreichbar/Timeout).
      // Dann NICHT fälschlich „Termin nicht gefunden" melden (der Termin existiert ja) –
      // sondern ehrlich um einen erneuten Versuch bitten. Kein Blind-DELETE (Eigentumsschutz).
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, error: 'verify_failed', message: 'Wir konnten deinen Termin gerade nicht prüfen – bitte in einem Moment erneut versuchen.' }));
    }
    const mine = lr.json.some((a) => String(a.bookingId) === String(id));
    if (!mine) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'not_your_booking', message: 'Termin nicht gefunden.' })); }

    const r = await M.ml('DELETE', '/appointments/booking/' + encodeURIComponent(id));
    const ok = r.status >= 200 && r.status < 300;
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: ok, message: ok ? 'Dein Termin wurde storniert.' : 'Stornierung fehlgeschlagen – bitte später erneut.' }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten.' }));
  }
};
