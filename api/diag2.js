'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt (nach Gebrauch entfernen!).
 * GET /api/diag2?k=fitinn-probe-2026&cid=<customerId>
 * Liefert die Roh-Struktur von Terminen + Check-ins, um zu sehen, welches Feld
 * stornierte Termine markiert und welche Parameter Check-ins zurückgeben.
 * Gibt KEINE Namen/E-Mails zurück – nur Status-/Datumsfelder + Schlüsselnamen.
 */

const M = require('../lib/members');

function keysOf(o) { return o && typeof o === 'object' ? Object.keys(o) : []; }
function pick(o, fields) {
  const out = {};
  fields.forEach((f) => { if (o && o[f] !== undefined) out[f] = o[f]; });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }
  let cid = url.searchParams.get('cid');
  const email = url.searchParams.get('email');

  // Optional: per E-Mail die passende Kundennummer/ID finden
  if (!cid && email) {
    try {
      const r = await M.ml('POST', '/customers/search', { email: String(email).trim().toLowerCase() });
      const list = Array.isArray(r.json) ? r.json : [];
      res.statusCode = 200;
      return res.end(JSON.stringify({
        search: { status: r.status, count: list.length,
          matches: list.map((c) => pick(c, ['id', 'customerId', 'customerNumber', 'studioId', 'dateOfBirth', 'zipCode'])) },
      }, null, 2));
    } catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ search: { error: e.message } })); }
  }

  if (!cid) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing cid or email' })); }
  const eid = encodeURIComponent(cid);
  const out = {};

  // ── Termine ──
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + eid);
    const list = Array.isArray(r.json) ? r.json : [];
    out.appointments = {
      status: r.status,
      count: list.length,
      firstKeys: keysOf(list[0]),
      // Status-/Storno-relevante Felder je Termin (keine Namen)
      items: list.map((a) => pick(a, [
        'bookingId', 'appointmentId', 'startDateTime', 'endDateTime',
        'appointmentStatus', 'bookingStatus', 'status', 'state',
        'cancelled', 'canceled', 'deleted', 'active',
      ])),
    };
  } catch (e) { out.appointments = { error: e.message }; }

  // ── Check-ins: mehrere Parameter-Varianten ──
  const today = new Date().toISOString().slice(0, 10);
  const variants = [
    ['none', '/customers/' + eid + '/activities/checkins'],
    ['size200', '/customers/' + eid + '/activities/checkins?sliceSize=200'],
    ['from2005', '/customers/' + eid + '/activities/checkins?fromDate=2005-01-01&sliceSize=200'],
    ['from2005_to', '/customers/' + eid + '/activities/checkins?fromDate=2005-01-01&toDate=' + today + '&sliceSize=200'],
    ['lastyear', '/customers/' + eid + '/activities/checkins?fromDate=2024-01-01&toDate=' + today + '&sliceSize=200'],
  ];
  out.checkins = {};
  for (const [name, q] of variants) {
    try {
      const r = await M.ml('GET', q);
      const list = r.json && Array.isArray(r.json.result) ? r.json.result
        : (Array.isArray(r.json) ? r.json : []);
      out.checkins[name] = {
        status: r.status,
        topKeys: keysOf(r.json),
        count: list.length,
        hasNext: r.json ? r.json.hasNext : undefined,
        firstKeys: keysOf(list[0]),
        firstDate: list[0] ? (list[0].checkInDateTime || list[0].checkinDateTime || list[0].date || null) : null,
        bodyHead: !r.json ? String(r.text || '').slice(0, 160) : undefined,
      };
    } catch (e) { out.checkins[name] = { error: e.message }; }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
