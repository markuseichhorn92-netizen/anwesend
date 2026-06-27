'use strict';

/** TEMP: testet /appointments/bookable/{id} + /slots mit echter ID (?bid=).
 * Reiner READ. Nach Test wieder entfernen. */
const M = require('../lib/members');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const bid = u.query.bid;
  if (!bid) { res.statusCode = 200; return res.end(JSON.stringify({ hint: 'bid (bookableAppointmentId) als Query-Param angeben' })); }

  const out = {};
  async function probe(label, path) {
    try {
      const r = await M.ml('GET', path);
      out[label] = { status: r.status };
      if (r.status === 200 || r.status === 201) {
        const j = r.json;
        out[label].result = Array.isArray(j) ? { array: j.length, sample: j.slice(0, 6) } : j;
      } else out[label].body = String(r.text || '').slice(0, 220);
    } catch (e) { out[label] = { error: String(e && e.message) }; }
  }

  const eid = encodeURIComponent(bid);
  await probe('bookable_detail', '/appointments/bookable/' + eid);
  await probe('slots_daysAhead6', '/appointments/bookable/' + eid + '/slots?daysAhead=6');
  await probe('slots_withStart', '/appointments/bookable/' + eid + '/slots?slotWindowStartDate=2026-06-27&daysAhead=6');

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
