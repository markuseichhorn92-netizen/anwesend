'use strict';

/** TEMP: prüft Termin-Endpunkte der Open API (APPOINTMENTS_READ/WRITE).
 * Writes mit customerId/bookableAppointmentId=0 -> bucht nichts Echtes.
 * Nach Test wieder entfernen. */
const M = require('../lib/members');
const STUDIO = '1210005460';

function shapeOf(j) {
  if (Array.isArray(j)) return { type: 'array', len: j.length, first: j[0] && typeof j[0] === 'object' ? Object.keys(j[0]) : j[0] };
  if (j && typeof j === 'object') return { type: 'object', keys: Object.keys(j) };
  return { type: typeof j, value: j };
}

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }

  const out = {};
  async function probe(label, method, path, body) {
    try {
      const r = await M.ml(method, path, body);
      out[label] = { status: r.status };
      if (r.status === 200 || r.status === 201) out[label].shape = shapeOf(r.json);
      else out[label].body = String(r.text || '').slice(0, 200);
      return r;
    } catch (e) { out[label] = { error: String(e && e.message) }; return null; }
  }

  const slot = { startDateTime: '2026-12-31T10:00:00Z', endDateTime: '2026-12-31T11:00:00Z' };

  // READ: buchbare Termine – verschiedene Parameter-Varianten
  await probe('bookable_plain', 'GET', '/appointments/bookable');
  const rStudio = await probe('bookable_studioId', 'GET', '/appointments/bookable?studioId=' + STUDIO);
  await probe('bookable_customer0', 'GET', '/appointments/bookable?customerId=0');

  // Falls eine Variante 200 liefert -> Liste anzeigen (Studio-Konfig, kein PII)
  let list = (rStudio && Array.isArray(rStudio.json)) ? rStudio.json : [];
  if (list.length) out.bookable_list = list.map((b) => ({ id: b.id, name: b.name, durationMinutes: b.durationMinutes, onlineBookable: b.onlineBookable }));

  // WRITE: Buchung + Validierung mit Dummy-IDs -> 403=kein Recht, 400/404=Recht ok
  await probe('validate_WRITE', 'POST', '/appointments/bookable/validate', { customerId: 0, bookableAppointmentId: 0, startDateTime: slot.startDateTime, endDateTime: slot.endDateTime });
  await probe('book_WRITE', 'POST', '/appointments/booking/book', { customerId: 0, bookableAppointmentId: 0, startDateTime: slot.startDateTime, endDateTime: slot.endDateTime });

  // READ: Kunden-Buchungen (war 404 = Recht ok)
  await probe('bookings_READ', 'GET', '/appointments/booking?customerId=0');

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
