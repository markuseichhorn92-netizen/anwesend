'use strict';

/** TEMP: prüft, ob der Freunde-werben-/Referral-Code auslesbar ist.
 * cid via ?cid= (eigenes Konto). Referral-Code ist teilbar, kein sensibles PII.
 * Nach Test entfernen. */
const M = require('../lib/members');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const cid = u.query.cid || '0';
  const eid = encodeURIComponent(cid);

  const out = {};
  async function probe(label, path) {
    try {
      const r = await M.ml('GET', path);
      out[label] = { status: r.status };
      if (r.status === 200) { const j = r.json; out[label].sample = Array.isArray(j) ? j.slice(0, 3) : j; }
      else out[label].body = String(r.text || '').slice(0, 160);
    } catch (e) { out[label] = { error: String(e && e.message) }; }
  }

  // 1) referralCode direkt aus dem Kundenobjekt
  try {
    const r = await M.ml('GET', '/customers/' + eid);
    out.customer = {
      status: r.status,
      referralCode: r.json && r.json.referralCode,
      referralCodePresent: r.json ? ('referralCode' in r.json) : null,
      thirdPartyId: r.json && r.json.thirdPartyId,
    };
  } catch (e) { out.customer = { error: String(e && e.message) }; }

  // 2) mögliche dedizierte Referral-Endpunkte
  await probe('referral_sub', '/customers/' + eid + '/referral');
  await probe('referrals_sub', '/customers/' + eid + '/referrals');
  await probe('referralcode_sub', '/customers/' + eid + '/referral-code');
  await probe('referrals_query', '/referrals?customerId=' + eid);

  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
