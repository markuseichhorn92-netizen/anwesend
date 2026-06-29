'use strict';

/**
 * POST /api/member/login-phone   { phone, dob }
 * Login-Alternative ohne E-Mail: Mitglied über Handynummer (+ Geburtsdatum zur
 * Bestätigung) finden und den 6-stelligen Code per WhatsApp an genau diese Nummer
 * senden. Setzt eine konfigurierte WhatsApp-Login-Vorlage voraus (WA.hasWaLogin).
 *
 * Gibt – wie der E-Mail-Weg – IMMER { ok:true, challenge, via:'whatsapp' } zurück
 * (kein Enumeration-Leak: ob ein Code verschickt wurde, ist von außen unsichtbar).
 */

const crypto = require('node:crypto');
const M = require('../../lib/members');
const WA = require('../../lib/whatsapp');
const { sendLoginCode } = require('../../lib/loginCode');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }
  if (!WA.hasWaLogin) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'wa_login_off' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('otpreq:ip:' + ip, 8, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const d = await M.readBody(req);
  const phone = String(d.phone || '').replace(/[^\d+]/g, '');
  const phoneKey = phone.replace(/\D/g, '');
  let challenge = crypto.randomBytes(24).toString('hex');

  try {
    // Pro Nummer begrenzen (SMS/WhatsApp-Bombing verhindern) – ohne nach außen zu verraten.
    const phoneOk = phoneKey ? await M.rateLimit('otpreq:p:' + phoneKey, 5, 1800) : false;
    if (phoneOk) {
      const m = await M.findByPhone(phone);
      // Zweiter Faktor: Geburtsdatum muss passen (Nummer allein genügt nicht).
      if (m && m.id != null && M.isoDate(m.dateOfBirth) === M.isoDate(d.dob)) {
        const r = await sendLoginCode(m, req.headers['host'], { channel: 'whatsapp' });
        if (r && r.challenge) challenge = r.challenge;
      }
    }
  } catch (e) { /* still return ok to avoid leaking */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, challenge: challenge, via: 'whatsapp' }));
};
