'use strict';

/** TEMP: testet Open-API "Kündigung zurücknehmen"
 * POST /v1/memberships/{cid}/self-service/withdraw-ordinary-contract-cancelation/{contractId}
 * cid via ?cid= (echte, existierende Kundennr.), contractId=0 -> nichts wird geändert.
 * Nach Test entfernen. */
const M = require('../lib/members');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const cid = u.query.cid || '0';

  const out = {};
  async function probe(label, method, path, body) {
    try {
      const r = await M.ml(method, path, body);
      out[label] = { status: r.status };
      out[label].body = String(r.text || '').slice(0, 200);
    } catch (e) { out[label] = { error: String(e && e.message) }; }
  }

  // withdraw mit Dummy-Kunde (0) und echtem Kunde – contractId 0 -> keine echte Änderung
  await probe('withdraw_cid0', 'POST', '/memberships/0/self-service/withdraw-ordinary-contract-cancelation/0');
  await probe('withdraw_realCid', 'POST', '/memberships/' + encodeURIComponent(cid) + '/self-service/withdraw-ordinary-contract-cancelation/0');

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
