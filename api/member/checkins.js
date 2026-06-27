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
    // Wichtig: KEIN fromDate/toDate – ein zu großer Zeitraum liefert 400
    // ("time period too long"). Stattdessen über offset paginieren.
    // sliceSize max. < 100 (50 ist sicher), sonst 400 ("value too large").
    const SLICE = 50;
    const all = [];
    let offset = 0;
    for (let page = 0; page < 200; page++) {        // Sicherheits-Cap (200*50 = 10.000)
      const q = '/customers/' + eid + '/activities/checkins?sliceSize=' + SLICE + '&offset=' + offset;
      const r = await M.ml('GET', q);
      if (r.status !== 200 || !r.json) break;
      const list = Array.isArray(r.json.result) ? r.json.result : [];
      for (const c of list) all.push(c);
      if (!r.json.hasNext || list.length === 0) break;
      const next = parseInt(r.json.offset, 10);
      offset = Number.isFinite(next) && next > offset ? next : offset + SLICE;
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
