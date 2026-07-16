'use strict';

/**
 * GET /api/member/me   (Authorization: Bearer <token>)
 * Liefert das aktuelle Profil des angemeldeten Mitglieds (IBAN nur maskiert).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const m = await M.getMember(sess.id);
    if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    let contract = null, contractError = false;
    try { contract = await M.getContract(sess.id); } catch (e) { contractError = true; }
    // Aktive Mitgliedschaft? Fail-safe: bei Fehler NICHT aussperren (true);
    // kein Vertrag -> ehemalig/nie (false); sonst contract.active.
    const membershipActive = contractError ? true : (contract ? contract.active !== false : false);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, profile: M.publicProfile(m), contract: contract, membershipActive: membershipActive }));
  } catch (err) {
    console.error('[member/me]', err.message);
    res.statusCode = 500; return res.end(JSON.stringify({ error: 'server_error' }));
  }
};
