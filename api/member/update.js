'use strict';

/**
 * POST /api/member/update   (Authorization: Bearer <token>)
 *   { type: "address", data: {...} }  oder  { type: "payment", data: {...} }
 * Schreibt über die Magicline Self-Service-Endpunkte. Greift erst, wenn die
 * Self-Service-Schreibrechte am Key freigeschaltet sind – bis dahin meldet
 * Magicline 403, was wir verständlich weiterreichen.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  const data = body.data || {};
  let r;
  try {
    if (body.type === 'address') r = await M.writeAddress(sess.id, data);
    else if (body.type === 'payment') r = await M.writePayment(sess.id, data);
    else { res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown_type' })); }
  } catch (err) {
    console.error('[member/update]', err.message);
    res.statusCode = 502; return res.end(JSON.stringify({ error: 'upstream_error' }));
  }

  if (r.status >= 200 && r.status < 300) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
  }
  if (r.status === 403) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: 'not_enabled', message: 'Änderungen sind noch nicht freigeschaltet (Self-Service-Schreibrecht im Magicline-Portal aktivieren).' }));
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: false, error: 'rejected', status: r.status, message: (r.json && r.json.errorMessage) || 'Eingaben prüfen.' }));
};
