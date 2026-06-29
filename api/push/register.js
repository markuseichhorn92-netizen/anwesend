'use strict';

/**
 * Geräte-Token der eigenen App registrieren (für Push).
 *   GET  -> { ok, push }                 (push = ist Versand serverseitig konfiguriert?)
 *   POST { token, platform } -> Token dem eingeloggten Mitglied zuordnen
 *   POST { action:'unregister', token } -> Token entfernen (z. B. beim Logout)
 *
 * Erfordert eine gültige Mitglieder-Sitzung (Bearer-Token). Die App ruft das nach
 * dem Login auf; im normalen Browser passiert nichts (kein Capacitor → kein Token).
 */

const M = require('../../lib/members');
const Push = require('../../lib/push');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, push: Push.hasPush }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const token = String(body.token || '').trim();
  if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }

  if (body.action === 'unregister') {
    try { await Push.unregisterToken(sess.id, token); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
  }

  try { await Push.registerToken(sess.id, token, String(body.platform || '').slice(0, 16)); } catch (e) {}
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
};
