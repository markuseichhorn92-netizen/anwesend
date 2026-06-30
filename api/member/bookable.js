'use strict';

/**
 * GET /api/member/bookable   (Authorization: Bearer <token>)
 * Liste der buchbaren Termin-Arten des Studios (BOOKABLE_APPOINTMENTS_READ).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const r = await M.ml('GET', '/appointments/bookable?sliceSize=100');
    const arr = (r.json && Array.isArray(r.json.result)) ? r.json.result
      : (Array.isArray(r.json) ? r.json : []);
    const types = arr.map((a) => ({
      id: a.id,
      title: a.title || 'Termin',
      duration: a.duration || null,
      category: a.category || '',
      description: a.description || '',
    })).filter((t) => t.id != null);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, types: types }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, types: [] }));
  }
};
