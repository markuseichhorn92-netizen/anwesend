'use strict';

/**
 * POST /api/member/checkout   (Authorization: Bearer <token>)
 * In-App-Check-out: beendet den Studio-Besuch des angemeldeten Mitglieds in
 * Magicline (Scope CHECKIN_WRITE → POST /v1/customers/{id}/checkout).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (!(await M.rateLimit('checkout:' + sess.id, 5, 600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Moment warten.' }));
  }

  const at = new Date().toISOString();
  let r;
  try { r = await M.checkoutCustomer(sess.id, at); } catch (e) { r = { status: 0 }; }

  // Auch wenn Magicline z. B. keinen offenen Besuch findet (kein 2xx), gilt das
  // App-seitige Auschecken als erledigt – der Timer wird beendet.
  const ok = !!(r && r.status >= 200 && r.status < 300);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: ok, at: at, message: ok ? 'Ausgecheckt – bis bald! 👋' : 'Ausgecheckt.' }));
};
