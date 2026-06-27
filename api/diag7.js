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
  const out = {};

  const variants = [
    ['search_customerNumber', 'POST', '/customers/search', { customerNumber: num }],
    ['search_number', 'POST', '/customers/search', { number: num }],
    ['search_query', 'POST', '/customers/search', { query: num }],
    ['search_numNoPrefix', 'POST', '/customers/search', { customerNumber: num.replace(/^M-/i, '') }],
  ];
  out.results = {};
  for (const [name, method, path, body] of variants) {
    try {
      const r = await M.ml(method, path, body);
      const arr = Array.isArray(r.json) ? r.json : null;
      out.results[name] = {
        status: r.status,
        count: arr ? arr.length : null,
        sample: arr ? arr.slice(0, 3).map(shape) : (r.json && r.json.errorMessage ? r.json.errorMessage.slice(0, 300) : null),
      };
    } catch (e) { out.results[name] = { error: e.message }; }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
