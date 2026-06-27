'use strict';

/**
 * GET /api/member/appointments   (Authorization: Bearer <token>)
 * Gebuchte Termine des Mitglieds (APPOINTMENTS_READ).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(sess.id));
    const list = Array.isArray(r.json) ? r.json : [];
    const appointments = list.map((a) => ({
      id: a.bookingId,
      title: a.title || 'Termin',
      start: a.startDateTime || null,
      end: a.endDateTime || null,
      status: a.appointmentStatus || a.bookingStatus || null,
    })).filter((a) => a.start);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, appointments: appointments }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, appointments: [] }));
  }
};
