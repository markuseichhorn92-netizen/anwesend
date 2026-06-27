'use strict';

/**
 * GET /api/member/checkins   (Authorization: Bearer <token>)
 * Check-in-Verlauf des angemeldeten Mitglieds (lesbar über CHECKIN_READ).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const r = await M.ml('GET', '/customers/' + encodeURIComponent(sess.id) + '/activities/checkins');
    const list = (r.json && Array.isArray(r.json.result)) ? r.json.result : [];
    const checkins = list.map((c) => ({
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
