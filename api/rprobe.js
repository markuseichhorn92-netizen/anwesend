'use strict';
/** TEMP: Status von Check-in-Verlauf + Dokumenten prüfen (READ). cid via ?cid=. Danach entfernen. */
const M = require('../lib/members');
module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const cid = encodeURIComponent(u.query.cid || '0');
  const out = {};
  async function p(label, path) {
    try { const r = await M.ml('GET', path); out[label] = { status: r.status, body: r.status === 200 ? (Array.isArray(r.json) ? ('array[' + r.json.length + ']') : 'object') : String(r.text || '').slice(0, 120) }; }
    catch (e) { out[label] = { error: String(e && e.message) }; }
  }
  await p('checkins', '/customers/' + cid + '/activities/checkins');
  await p('documents', '/customers/' + cid + '/documents');
  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
