'use strict';

/**
 * Geräte-Token des Team-Backends (für Push an angemeldete Team-Mitglieder).
 *   GET  -> { ok, push }                 (push = ist Versand serverseitig konfiguriert?)
 *   POST { token, platform } -> Token dem gemeinsamen Team-Pool hinzufügen
 *   POST { action:'unregister', token } -> Token entfernen (z. B. beim Logout)
 *
 * Erfordert eine gültige Team-Sitzung (Bearer-Token). Die App ruft das nach dem
 * Team-Login auf; im normalen Browser passiert nichts (kein Capacitor → kein Token).
 * Anders als bei Mitgliedern gibt es keine Einzel-Zuordnung – alle Team-Geräte
 * teilen sich einen Pool, damit eine Mitglieder-Nachricht das ganze Team erreicht.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');   // readBody
const Push = require('../../lib/push');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, push: Push.hasPush }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const token = String(body.token || '').trim();
  if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }

  if (body.action === 'unregister') {
    try { await Push.unregisterTeamToken(token); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
  }

  try { await Push.registerTeamToken(token, String(body.platform || '').slice(0, 16), sess.user || TA.roleOf(sess) || 'Team'); } catch (e) {}
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
};
