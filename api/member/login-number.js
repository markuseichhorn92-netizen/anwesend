'use strict';

/**
 * POST /api/member/login-number   { customerNumber, dob, remember }
 * Fallback-Login für Mitglieder OHNE hinterlegte E-Mail: Mitgliedsnummer +
 * Geburtsdatum. Wissensbasiert (kein Code) – daher bewusst nur erlaubt, wenn
 * für das Konto KEINE E-Mail hinterlegt ist. Mitglieder MIT E-Mail müssen den
 * (stärkeren) E-Mail-Code-Login nutzen. Rate-Limit pro IP und pro Nummer.
 */

const M = require('../../lib/members');
const { sendLoginCode } = require('../../lib/loginCode');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('numlogin:ip:' + ip, 8, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte später erneut.' }));
  }

  const d = await M.readBody(req);
  const num = String(d.customerNumber || '').trim();
  const dobISO = M.isoDate(d.dob);
  if (!num || !dobISO) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Bitte Mitgliedsnummer und Geburtsdatum angeben.' })); }

  await M.rateLimit('numlogin:n:' + num.toUpperCase().replace(/\s+/g, ''), 6, 1800);

  try {
    const m = await M.findByNumberDob(num, dobISO);
    if (!m) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, message: 'Daten nicht gefunden. Bitte Mitgliedsnummer und Geburtsdatum prüfen.' })); }
    if (m.email) {
      // Konto hat eine E-Mail: aus Sicherheitsgründen Code/Magic-Link an die
      // hinterlegte Adresse schicken und zur Code-Eingabe weiterleiten.
      const r = await sendLoginCode(m, req.headers['host']);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, needsCode: true, challenge: r.challenge }));
    }
    const token = await M.createSession(m.id, d.remember ? 2592000 : 1800);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token: token }));
  } catch (e) {
    res.statusCode = 500; return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten.' }));
  }
};
