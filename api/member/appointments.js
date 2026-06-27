'use strict';

/**
 * GET /api/member/appointments   (Authorization: Bearer <token>)
 * Gebuchte Termine des Mitglieds (APPOINTMENTS_READ).
 */

const M = require('../../lib/members');

// Stornierte/abgesagte Buchungen erkennen (Magicline liefert sie weiterhin in
// der Liste, nur mit verändertem Status) – über alle gängigen Feld-Varianten.
function isCancelled(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true || a.deleted === true) return true;
  if (a.active === false) return true;
  const s = [a.status, a.appointmentStatus, a.bookingStatus, a.state]
    .filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN|DELET|ABGESAGT|ABGELEHNT|NO_?SHOW|DECLIN/.test(s);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(sess.id));
    const list = Array.isArray(r.json) ? r.json : [];
    const appointments = list
      .filter((a) => !isCancelled(a))
      .map((a) => ({
        id: a.bookingId,
        title: a.title || a.name || 'Termin',
        start: a.startDateTime || null,
        end: a.endDateTime || null,
        status: a.appointmentStatus || a.bookingStatus || a.status || null,
      }))
      .filter((a) => a.start);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, appointments: appointments }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, appointments: [] }));
  }
};
