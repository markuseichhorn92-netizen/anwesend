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
const { sendMailRaw, hasMail } = require('../../lib/mail');

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
  const challenge = crypto.randomBytes(24).toString('hex');

  try {
    // Pro E-Mail begrenzen (Mail-Bombing verhindern) – ohne nach außen zu verraten
    const emailOk = email ? await M.rateLimit('otpreq:e:' + email, 5, 1800) : false;
    if (emailOk) {
      const m = await M.findByEmailDob(email, d.dob);
      if (m && m.email && hasMail) {
        const code = String(crypto.randomInt(100000, 1000000));
        await M.otpSave(challenge, { id: m.id, codeHash: M.hashCode(code), exp: Date.now() + 600000, tries: 0 }, 600);
        await sendMailRaw({
          to: m.email,
          subject: 'Dein Anmelde-Code: ' + code + ' – Fit-Inn Trier',
          text: 'Hallo' + (m.firstName ? ' ' + m.firstName : '') + ',\n\n'
            + 'dein Anmelde-Code für den Mitgliederbereich lautet:\n\n'
            + '   ' + code + '\n\n'
            + 'Der Code ist 10 Minuten gültig. Wenn du dich nicht anmelden wolltest, ignoriere diese E-Mail einfach.\n\n'
            + 'Sportliche Grüße\nDein Fit-Inn Trier',
        });
      }
    }
  } catch (e) { /* still return ok to avoid leaking */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, challenge: challenge }));
};
