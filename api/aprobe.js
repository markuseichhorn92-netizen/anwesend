'use strict';

/** TEMP: prüft Termin-Endpunkte (APPOINTMENTS_READ/WRITE) eindeutig.
 * cid = echte (existierende) Kundennummer via Query (?cid=), NICHT im Code.
 * bookableAppointmentId=0 -> es wird nichts gebucht. Nach Test entfernen. */
const M = require('../lib/members');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const cid = u.query.cid || '0';

  const out = {};
  async function probe(label, method, path, body) {
    try {
      const r = await M.ml(method, path, body);
      out[label] = { status: r.status };
      if (r.status === 200 || r.status === 201) {
        const j = r.json;
        out[label].result = Array.isArray(j) ? { array: j.length, sample: j.slice(0, 3) } : j;
      } else out[label].body = String(r.text || '').slice(0, 200);
    } catch (e) { out[label] = { error: String(e && e.message) }; }
  }

  const slot = { startDateTime: '2026-12-31T10:00:00Z', endDateTime: '2026-12-31T11:00:00Z' };

  // Per-ID bookable-Endpunkte: 403 (Subtree gesperrt) vs 404 (nur Liste gesperrt)?
  await probe('bookable_byId0', 'GET', '/appointments/bookable/0');
  await probe('bookable_slots0', 'GET', '/appointments/bookable/0/slots?daysAhead=6');

  // WRITE eindeutig: echter Kunde existiert, bookableAppointmentId=0 nicht
  //   -> 404 "bookable not found" = Recht OK ; 403 = kein Recht
  await probe('validate_realCustomer', 'POST', '/appointments/bookable/validate', { customerId: Number(cid), bookableAppointmentId: 0, startDateTime: slot.startDateTime, endDateTime: slot.endDateTime });
  await probe('book_realCustomer', 'POST', '/appointments/booking/book', { customerId: Number(cid), bookableAppointmentId: 0, startDateTime: slot.startDateTime, endDateTime: slot.endDateTime });

  // READ Kunden-Termine mit echtem Kunden
  await probe('bookings_realCustomer', 'GET', '/appointments/booking?customerId=' + encodeURIComponent(cid));

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
