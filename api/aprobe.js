'use strict';

/** TEMP: prüft Termin-Endpunkte der Open API (APPOINTMENTS_READ/WRITE).
 * Booking-Write wird mit customerId=0 getestet -> bucht nichts Echtes.
 * Nach Test wieder entfernen. */
const M = require('../lib/members');

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
      out[label] = { status: r.status, shape: shapeOf(r.json) };
      if (r.status !== 200 && r.status !== 201) out[label].body = String(r.text || '').slice(0, 220);
      return r;
    } catch (e) { out[label] = { error: String(e && e.message) }; return null; }
  }

  // 1) Buchbare Termine (READ) – Namen/IDs sind Studio-Konfig, kein PII
  const r1 = await probe('bookable_READ', 'GET', '/appointments/bookable');
  let list = (r1 && Array.isArray(r1.json)) ? r1.json : [];
  out.bookable_list = list.map((b) => ({ id: b.id, name: b.name, durationMinutes: b.durationMinutes, onlineBookable: b.onlineBookable, restrictedToRates: b.restrictedToRates }));

  // 2) Für den ersten buchbaren Termin: Slots (READ) + Booking-Write-Test (customerId=0)
  if (list.length) {
    const bid = list[0].id;
    const r2 = await probe('slots_READ', 'GET', '/appointments/bookable/' + encodeURIComponent(bid) + '/slots?daysAhead=6');
    const slots = (r2 && Array.isArray(r2.json)) ? r2.json : [];
    out.firstBookable = { id: bid, name: list[0].name, slotCount: slots.length, sampleSlot: slots[0] || null };

    const slot = slots[0] || { startDateTime: '2026-12-31T10:00:00Z', endDateTime: '2026-12-31T11:00:00Z' };
    // Vollständiger, gültiger Body – nur customerId=0 ist ungültig -> 403 = kein Recht, 404/400 = Recht ok
    await probe('book_WRITE_test', 'POST', '/appointments/booking/book', {
      customerId: 0,
      bookableAppointmentId: bid,
      startDateTime: slot.startDateTime,
      endDateTime: slot.endDateTime,
    });
  }

  // 3) Bookings lesen (READ) für customerId=0
  await probe('bookings_READ', 'GET', '/appointments/booking?customerId=0');

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
