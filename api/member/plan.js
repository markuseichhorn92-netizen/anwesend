'use strict';

/**
 * Vercel Serverless Function · /api/member/plan
 * ---------------------------------------------
 * GET  -> eigene heutige Vormerkung   { ok, plan:{hour,remind}|null }
 * POST -> setzen/absagen              body { action:'set'|'cancel', hour, remind }
 * Auth über Member-Session (Bearer-Token).
 */

const M = require('../../lib/members');
const P = require('../../lib/plans');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  if (req.method === 'GET') {
    try {
      const plan = await P.getMyPlan(sess.id);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, plan: plan }));
    } catch (e) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, plan: null }));
    }
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  // Missbrauchsschutz: begrenzte Schreibvorgänge pro Mitglied/Stunde
  if (!(await M.rateLimit('plan:' + sess.id, 40, 3600))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const body = await M.readBody(req);
  const action = body.action === 'cancel' ? 'cancel' : 'set';

  try {
    if (action === 'cancel') {
      const r = await P.cancelPlan(sess.id);
      res.statusCode = 200;
      return res.end(JSON.stringify(r));
    }

    // E-Mail/Vorname aus Magicline ziehen und im Plan ablegen (für die Erinnerung)
    let email = '', firstName = '';
    try { const m = await M.getMember(sess.id); if (m) { email = m.email || ''; firstName = m.firstName || ''; } } catch (e) {}

    const r = await P.setPlan(sess.id, body.hour, { email: email, firstName: firstName, remind: body.remind !== false });
    res.statusCode = r.ok ? 200 : 400;
    return res.end(JSON.stringify(r));
  } catch (e) {
    console.error('[plan]', e.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'plan_failed' }));
  }
};
