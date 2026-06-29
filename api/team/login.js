'use strict';

/**
 * Team-Login (Studio-Backend).
 *   POST { password } -> { ok, token, ttl }
 * Gemeinsames Team-Passwort (Env TEAM_PASSWORD) -> serverseitige Session.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');   // readBody + rateLimit (wiederverwenden)

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!TA.hasTeamAuth) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Team-Login ist noch nicht eingerichtet (TEAM_PASSWORD fehlt).' }));
  }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (!(await M.rateLimit('team-login:' + ip, 10, 600))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – bitte ein paar Minuten warten.' }));
  }
  const body = await M.readBody(req);
  if (!TA.verifyPassword(body.password)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, message: 'Falsches Passwort.' }));
  }
  const token = await TA.createSession('team');
  if (!token) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'no_session' })); }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, token, ttl: TA.TTL }));
};
