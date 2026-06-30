'use strict';

/**
 * GET  /api/member/prefs              -> { ok, prefs:{reminders} }
 * POST /api/member/prefs { reminders } -> speichert + liefert { ok, prefs }
 * Auth über Member-Session (Bearer-Token).
 */

const M = require('../../lib/members');
const Prefs = require('../../lib/prefs');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    const prefs = await Prefs.getPrefs(sess.id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, prefs: prefs }));
  }
  if (req.method === 'POST') {
    if (!(await M.rateLimit('prefs:' + sess.id, 40, 3600))) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); }
    const body = await M.readBody(req);
    const patch = {};
    (Prefs.BOOL_KEYS || ['reminders']).forEach(function (k) { if (typeof body[k] === 'boolean') patch[k] = body[k]; });
    const r = await Prefs.setPrefs(sess.id, patch);
    res.statusCode = 200; return res.end(JSON.stringify(r));
  }
  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
