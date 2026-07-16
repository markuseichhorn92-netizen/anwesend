'use strict';

/**
 * POST /api/member/logout   (Authorization: Bearer <token>)
 *   { pushToken? }  – optionales Geräte-Token dieses Geräts.
 *
 * Serverseitiger Logout: widerruft die aktuelle Sitzung in Redis und meldet
 * (falls übergeben) das Push-Token DIESES Geräts ab – andere Geräte desselben
 * Mitglieds bleiben unberührt. Idempotent: ein bereits abgelaufener oder
 * unbekannter Token ist kein Fehler, die Antwort ist immer { ok:true }.
 * Es werden keine Sitzungs- oder Geräte-Tokens geloggt.
 */

const M = require('../../lib/members');
const Push = require('../../lib/push');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const token = M.bearer(req);
  const body = await M.readBody(req);

  try {
    // Push-Abmeldung nur, solange die Sitzung noch auflösbar ist (Mitglieds-ID nötig).
    const sess = await M.getSession(token);
    const pushToken = String((body && body.pushToken) || '').trim();
    if (sess && pushToken) {
      try { await Push.unregisterToken(sess.id, pushToken); } catch (e) {}
    }
    await M.destroySession(token);
  } catch (e) { /* Logout ist best effort – niemals hart fehlschlagen */ }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true }));
};
