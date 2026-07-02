'use strict';

/**
 * GET /api/member/pause-info   (Authorization: Bearer <token>)
 * Beitragspause-Optionen des Vertrags aus Magicline (Idle Periods):
 * Gründe, Zeiteinheit, Limits, Gebühr, frühester Beginn + bestehende Pausen.
 * Fehlt der Scope (403) oder gibt es keinen aktiven Vertrag ->
 * { ok:true, available:false } – die UI zeigt dann das bisherige
 * E-Mail-Anfrage-Formular, ohne dass ein Fehler sichtbar wird.
 */

const M = require('../../lib/members');
const MM = require('../../lib/mlMembership');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  let ct = null;
  try { ct = await M.getContract(sess.id); } catch (e) {}
  if (!ct || !ct.contractId || ct.active === false) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, available: false }));
  }

  const [config, remaining, list] = await Promise.all([
    MM.idleConfig(ct.contractId),
    MM.idleRemaining(ct.contractId),
    MM.idleList(ct.contractId),
  ]);
  if (!config.available) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, available: false }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    available: true,
    config: {
      temporalUnit: config.temporalUnit,
      maxTerms: config.maxTerms,
      maxTermPerReferencePeriod: config.maxTermPerReferencePeriod,
      referencePeriod: config.referencePeriod,
      firstPossibleStartDate: config.firstPossibleStartDate,
      nextPossibleStartDateOnly: config.nextPossibleStartDateOnly,
      unlimitedAllowed: config.unlimitedAllowed,
      accessRefusal: config.accessRefusal,
      fee: config.fee,
      reasons: config.reasons,
    },
    remaining: remaining.ok ? { maxTerms: remaining.maxTerms, freeTerms: remaining.freeTerms } : null,
    current: list.ok ? list.current : [],
  }));
};
