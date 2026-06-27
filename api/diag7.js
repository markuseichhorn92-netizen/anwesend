'use strict';

/** TEMPORÄR. GET /api/diag7?k=fitinn-probe-2026&num=M-962
 * Prüft, ob /customers/search per Mitgliedsnummer funktioniert. Nur Metadaten. */

const M = require('../lib/members');

function shape(c) {
  return c ? { id: c.id, customerNumber: c.customerNumber, hasDob: !!c.dateOfBirth, hasEmail: !!c.email } : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }
  const num = url.searchParams.get('num') || '';
  const dob = url.searchParams.get('dob') || '';
  const out = {};

  try {
    const r = await M.ml('POST', '/customers/search', { dateOfBirth: dob });
    const arr = Array.isArray(r.json) ? r.json : [];
    const match = arr.find((c) => String(c.customerNumber || '') === num);
    out.dobSearch = {
      status: r.status,
      count: arr.length,
      matchFound: !!match,
      match: shape(match),
    };
  } catch (e) { out.dobSearch = { error: e.message }; }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
