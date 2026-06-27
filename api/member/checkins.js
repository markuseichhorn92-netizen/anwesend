'use strict';

/**
 * GET /api/member/checkins   (Authorization: Bearer <token>)
 * Vollständiger Check-in-Verlauf des Mitglieds (CHECKIN_READ), über alle Seiten
 * paginiert – nicht nur die jüngsten/seit-Integration.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  const eid = encodeURIComponent(sess.id);
  try {
    const all = [];
    let offset = null;
    for (let page = 0; page < 80; page++) {        // Sicherheits-Cap (80*200 = 16.000)
      let q = '/customers/' + eid + '/activities/checkins?fromDate=2005-01-01&sliceSize=200';
      if (offset) q += '&offset=' + encodeURIComponent(offset);
      const r = await M.ml('GET', q);
      if (r.status !== 200 || !r.json) break;
      const list = Array.isArray(r.json.result) ? r.json.result : [];
      for (const c of list) all.push(c);
      if (!r.json.hasNext || !r.json.offset || list.length === 0) break;
      offset = r.json.offset;
    }
    const checkins = all.map((c) => ({
      in: c.checkInDateTime || null,
      out: c.checkOutDateTime || null,
      studio: c.studioName || null,
    })).filter((c) => c.in);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, checkins: checkins }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, checkins: [] }));
  }
};
