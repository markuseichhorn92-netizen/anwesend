'use strict';

/** TEMPORÄR. GET /api/diag5?k=fitinn-probe-2026&cid=<id>
 * Zeigt contractOrigin, createdDate, startDate je Vertrag (für Widerruf-Logik). */

const M = require('../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }
  const cid = url.searchParams.get('cid');
  if (!cid) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing cid' })); }
  const r = await M.ml('GET', '/customers/' + encodeURIComponent(cid) + '/contracts');
  const list = Array.isArray(r.json) ? r.json : [];
  const out = list.map((c) => ({
    id: c.id,
    contractOrigin: c.contractOrigin,
    createdDate: c.createdDate,
    startDate: c.startDate,
    startDateOfUse: c.startDateOfUse,
    status: c.contractStatus,
    reversed: c.reversed,
    cancelled: c.cancelled,
    rateName: c.rateName,
  }));
  res.statusCode = 200;
  return res.end(JSON.stringify({ status: r.status, contracts: out }, null, 2));
};
