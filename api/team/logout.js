'use strict';

/**
 * POST /api/team/logout   (Authorization: Bearer <team-token>)
 *   { pushToken? }  – optionales Geräte-Token dieses Team-Geräts.
 *
 * Serverseitiger Team-Logout: widerruft die Team-Sitzung in Redis und meldet
 * (falls übergeben) das Push-Token dieses Geräts aus dem Team-Pool ab.
 * Idempotent – immer { ok:true }, Tokens werden nicht geloggt.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const Push = require('../../lib/push');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const token = TA.bearer(req);
  const body = await M.readBody(req);

  try {
    const pushToken = String((body && body.pushToken) || '').trim();
    if (pushToken) { try { await Push.unregisterTeamToken(pushToken); } catch (e) {} }
    await TA.destroySession(token);
  } catch (e) { /* best effort */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true }));
};
