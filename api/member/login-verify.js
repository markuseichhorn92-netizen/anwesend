'use strict';

/**
 * POST /api/member/login-verify   { challenge, code, remember }
 * Schritt 2 des Logins: Einmal-Code prüfen und bei Erfolg ein Sitzungs-Token
 * ausgeben. Max. 5 Fehlversuche je Code, 10 Minuten Gültigkeit.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('otpver:ip:' + ip, 30, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte später erneut.' }));
  }

  const d = await M.readBody(req);
  const challenge = String(d.challenge || '');
  const code = String(d.code || '').trim();
  if (!challenge || !/^\d{4,8}$/.test(code)) {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Bitte gib den Code aus der E-Mail ein.' }));
  }

  const otp = await M.otpGet(challenge);
  if (!otp) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: 'Code ungültig oder abgelaufen. Bitte fordere einen neuen an.' })); }
  if (Date.now() > otp.exp) { await M.otpDel(challenge); res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: 'Der Code ist abgelaufen. Bitte fordere einen neuen an.' })); }

  otp.tries = (otp.tries || 0) + 1;
  if (otp.tries > 5) { await M.otpDel(challenge); res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Fehlversuche. Bitte fordere einen neuen Code an.' })); }

  if (M.hashCode(code) !== otp.codeHash) {
    const rem = Math.max(1, Math.ceil((otp.exp - Date.now()) / 1000));
    await M.otpSave(challenge, otp, rem);
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, message: 'Code falsch. Bitte erneut versuchen.', triesLeft: Math.max(0, 5 - otp.tries) }));
  }

  const token = await M.createSession(otp.id, d.remember ? 2592000 : 1800);
  await M.otpDel(challenge);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, token: token }));
};
