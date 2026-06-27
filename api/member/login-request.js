'use strict';

/**
 * POST /api/member/login-request   { email, dob }
 * Schritt 1 des Logins: Mitglied über E-Mail + Geburtsdatum suchen und – bei
 * Treffer – einen 6-stelligen Einmal-Code an die hinterlegte E-Mail senden.
 * Gibt IMMER { ok:true, challenge } zurück (kein Enumeration-Leak); ob ein
 * Code verschickt wurde, ist von außen nicht unterscheidbar.
 */

const crypto = require('node:crypto');
const M = require('../../lib/members');
const { sendLoginCode } = require('../../lib/loginCode');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('otpreq:ip:' + ip, 8, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const d = await M.readBody(req);
  const email = String(d.email || '').trim().toLowerCase();
  let challenge = crypto.randomBytes(24).toString('hex');

  try {
    // Pro E-Mail begrenzen (Mail-Bombing verhindern) – ohne nach außen zu verraten
    const emailOk = email ? await M.rateLimit('otpreq:e:' + email, 5, 1800) : false;
    if (emailOk) {
      const m = await M.findByEmailDob(email, d.dob);
      if (m && m.email) {
        const r = await sendLoginCode(m, req.headers['host']);
        if (r && r.challenge) challenge = r.challenge;
      }
    }
  } catch (e) { /* still return ok to avoid leaking */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, challenge: challenge }));
};
