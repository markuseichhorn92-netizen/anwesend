'use strict';

/**
 * Aktions-Link-Login (öffentlich, KEIN Bearer).   Zweiter Faktor: Geburtsdatum.
 *
 *   GET  ?token=…                    -> { ok, action, label }        (nur zum Anzeigen)
 *   POST { token, birthdate }        -> { ok, token:<session>, go, sub } | { ok:false, error, attemptsLeft }
 *
 * Der Token identifiziert das Mitglied; das Geburtsdatum ist der zweite Faktor.
 * Nach Erfolg wird eine echte Mitglieder-Sitzung geprägt (lib/actionlink → M.createSession)
 * und der Token verbraucht. Hart ratelimitiert gegen Geburtsdatum-Raten.
 */

const M = require('../../lib/members');
const AL = require('../../lib/actionlink');

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    let token = ''; try { token = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch (e) {}
    if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }
    const r = await AL.peek(token);
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: r.error || 'invalid' })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, action: r.action, label: r.label }));
  }

  if (req.method === 'POST') {
    const ip = clientIp(req);
    // Zwei Ratelimits: pro IP (Brute-Force-Schutz) – zusätzlich zählt lib/actionlink pro Token.
    if (!(await M.rateLimit('actlogin:' + ip, 20, 3600))) {
      res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
    }
    const body = await M.readBody(req);
    const token = String(body.token || '').trim();
    const birthdate = String(body.birthdate || '').trim();
    if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }
    if (!birthdate) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_birthdate' })); }

    const r = await AL.verify(token, birthdate);
    if (!r.ok) {
      res.statusCode = 200;
      const out = { ok: false, error: r.error || 'failed' };
      if (r.attemptsLeft != null) out.attemptsLeft = r.attemptsLeft;
      return res.end(JSON.stringify(out));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token: r.token, go: r.screen, sub: r.sub }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
