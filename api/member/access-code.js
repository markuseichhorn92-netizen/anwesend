'use strict';

/**
 * GET /api/member/access-code   (Authorization: Bearer <token>)
 * Dynamischer Check-in-QR-Code aus der Magicline Open API
 *   GET /v1/customers/{id}/access-code  ->  { content, format:'QR_CODE', expiresAt }
 * Der Code läuft ab (expiresAt) – die App erneuert ihn automatisch vor Ablauf.
 *
 * Degradiert sauber: ist der Code nicht verfügbar (403/Fehler/kein Inhalt),
 * kommt { available:false } zurück und die App fällt auf die statische
 * Mitgliedsnummer zurück. Wirft nie.
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  try {
    const r = await M.ml('GET', '/customers/' + encodeURIComponent(sess.id) + '/access-code');
    if (r && r.status === 200 && r.json && r.json.content) {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true, available: true,
        content: String(r.json.content),
        format: r.json.format || 'QR_CODE',
        expiresAt: r.json.expiresAt || null,
      }));
    }
  } catch (e) { /* fällt unten auf available:false */ }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, available: false }));
};
