'use strict';

/**
 * GET /api/member/me   (Authorization: Bearer <token>)
 * Liefert das aktuelle Profil des angemeldeten Mitglieds (IBAN nur maskiert).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    const m = await M.getMember(sess.id);
    if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
    let contract = null;
    try { contract = await M.getContract(sess.id); } catch (e) {}
    let contractDebug = null;
    try { contractDebug = await M.diagContracts(sess.id); } catch (e) { contractDebug = [{ err: String(e && e.message) }]; }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, profile: M.publicProfile(m), contract: contract, contractDebug: contractDebug, memberShape: M.shapeOf(m) }));
  } catch (err) {
    console.error('[member/me]', err.message);
    res.statusCode = 500; return res.end(JSON.stringify({ error: 'server_error' }));
  }
};
