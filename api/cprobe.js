'use strict';

/** TEMP: prüft, ob der Open-API-Key Kündigungen schreiben darf.
 * Nutzt id=0 -> es kann nichts Echtes gekündigt werden (kein Kunde 0).
 * Nur Status + kurzer Fehlertext (PII-frei). Nach Test wieder entfernen. */
const M = require('../lib/members');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }

  const out = {};
  async function probe(label, method, path, body) {
    try { const r = await M.ml(method, path, body); out[label] = { status: r.status, body: String(r.text || '').slice(0, 200) }; }
    catch (e) { out[label] = { error: String(e && e.message) }; }
  }

  var P = '/memberships/0/self-service/ordinary-contract-cancelation';
  // Magicline-Feldnamen: "cancelation" mit EINEM L
  await probe('full_v1', 'POST', P, { contractId: 0, cancelationReasonId: 1, cancelationDate: '2026-12-31' });
  await probe('full_v2', 'POST', P, { contractId: 0, cancelationReasonId: 1, cancelationDate: '2026-12-31', cancelationType: 'ORDINARY', cancelationDateType: 'NEXT_POSSIBLE_CANCELATION_DATE' });
  await probe('full_v3', 'POST', P, { contractId: 0, cancelationReasonId: 1, cancelationDate: '2026-12-31', additionalInformation: 'test', confirmationEmail: false });

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
