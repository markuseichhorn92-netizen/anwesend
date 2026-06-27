'use strict';

/**
 * POST /api/member/login  { email, dob, plz }
 * Prüft E-Mail + Geburtsdatum + PLZ gegen Magicline und gibt bei Treffer ein
 * Sitzungs-Token zurück. Neutrale Fehlermeldung (kein Enumeration-Leak).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  if (!M.hasStore) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'no_store' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('login:' + ip, 8, 600))) {       // 8 Versuche / 10 min / IP
    res.statusCode = 429; return res.end(JSON.stringify({ error: 'rate_limited' }));
  }

  const d = await M.readBody(req);
  if (d.email) { await M.rateLimit('login:e:' + String(d.email).toLowerCase(), 6, 600); }

  try {
    const v = await M.findAndValidate(d.email, d.dob, d.plz);
    if (!v.ok) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'invalid_credentials' })); }
    const ttl = d.remember ? 2592000 : 1800;   // "Angemeldet bleiben" = 30 Tage, sonst 30 min
    const token = await M.createSession(v.member.id, ttl);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token }));
  } catch (err) {
    console.error('[member/login]', err.message);
    res.statusCode = 500; return res.end(JSON.stringify({ error: 'server_error' }));
  }
};
