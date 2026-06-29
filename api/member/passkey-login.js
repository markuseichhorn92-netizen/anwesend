'use strict';

/**
 * Passkey-Anmeldung (öffentlich, ohne Vorab-Login).
 *   POST { action:'options' }                  -> { ok, options, flowId }
 *   POST { action:'verify', flowId, response, remember? } -> { ok, token }
 * Bei Erfolg wird eine Mitglieder-Sitzung erstellt (wie beim Code-Login).
 */

const M = require('../../lib/members');
const PK = require('../../lib/passkey');

function host(req) { return req.headers['x-forwarded-host'] || req.headers['host'] || ''; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!PK.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, disabled: true })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('pklogin:ip:' + ip, 30, 600))) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); }

  const body = await M.readBody(req);

  if (body.action === 'options') {
    try { const r = await PK.authOptions(host(req)); res.statusCode = 200; return res.end(JSON.stringify({ ok: true, options: r.options, flowId: r.flowId })); }
    catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false })); }
  }
  if (body.action === 'verify') {
    const r = await PK.authVerify(host(req), body.flowId, body.response);
    if (!r.ok || r.memberId == null) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Passkey-Anmeldung fehlgeschlagen.' })); }
    const ttl = body.remember ? (60 * 60 * 24 * 30) : 1800;   // 30 Tage / 30 Min
    const token = await M.createSession(r.memberId, ttl);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, token: token }));
  }
  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
