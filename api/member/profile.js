'use strict';

/**
 * GET  /api/member/profile                     -> { ok, profile }
 * POST /api/member/profile { profile:{...} }    -> speichert + liefert { ok, profile }
 * POST /api/member/profile { action:'clear-health' } -> löscht nur Gesundheitsangaben
 * POST /api/member/profile { action:'clear' }        -> löscht das ganze Profil
 *
 * Onboarding-Angaben (Ziel, Körperdaten, Rhythmus, Erfahrung, Vorlieben,
 * Gesundheit MIT Einwilligung, Ernährung). Auth über Member-Session (Bearer).
 * Gesundheitsdaten werden nur bei health.consent === true übernommen (Art. 9).
 */

const M = require('../../lib/members');
const Profile = require('../../lib/memberProfile');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    const profile = await Profile.get(sess.id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, profile: profile }));
  }
  if (req.method === 'POST') {
    if (!(await M.rateLimit('profile:' + sess.id, 40, 3600))) {
      res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
    }
    const body = await M.readBody(req);
    const action = String(body.action || '');
    let profile;
    if (action === 'clear') profile = await Profile.clear(sess.id);
    else if (action === 'clear-health') profile = await Profile.clearHealth(sess.id);
    else if (action === 'lifestyle') profile = await Profile.saveLifestyle(sess.id, body.lifestyle || {});
    else if (action === 'welcome-reset') {
      // Onboarding wiederholt -> Willkommensgeschenk („erster Plan aufs Haus") wieder freigeben.
      try { await require('../../lib/welcomeGift').save(sess.id, { train: false, ern: false }); } catch (e) {}
      profile = await Profile.get(sess.id);
    } else profile = await Profile.save(sess.id, body.profile || body);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, profile: profile }));
  }
  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
