'use strict';
/** TEMP: Shape von checkins + appointments. cid via ?cid=. Danach entfernen. */
const M = require('../lib/members');
module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  const u = require('url').parse(req.url, true);
  if (u.query.k !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const cid = encodeURIComponent(u.query.cid || '0');
  const out = {};
  async function p(label, path) {
    try {
      const r = await M.ml('GET', path);
      let shape;
      const j = r.json;
      if (Array.isArray(j)) shape = { array: j.length, first: j[0] || null };
      else if (j && typeof j === 'object') { shape = { keys: Object.keys(j) }; for (const k of Object.keys(j)) { if (Array.isArray(j[k])) shape[k + '[]'] = { len: j[k].length, first: j[k][0] || null }; } }
      else shape = { val: j };
      out[label] = { status: r.status, shape };
    } catch (e) { out[label] = { error: String(e && e.message) }; }
  }
  await p('checkins', '/customers/' + cid + '/activities/checkins');
  await p('appointments', '/appointments/booking?customerId=' + cid);
  res.statusCode = 200; res.end(JSON.stringify(out, null, 2));
};
