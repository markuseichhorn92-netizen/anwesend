'use strict';

/**
 * POST /api/member/payment-session   (Authorization: Bearer <token>)
 *   { choices?: ["SEPA","CREDIT_CARD"] }
 * Erstellt eine Finion-Pay-Zahlungssitzung für das eingeloggte Mitglied und
 * liefert Token + Region zurück, mit denen das Frontend die gehostete
 * Zahlungskomponente lädt. Solange Finion Pay nicht aktiviert ist, kommt eine
 * verständliche Fehlermeldung statt eines harten Fehlers.
 */

const M = require('../../lib/members');
const Pay = require('../../lib/payments');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  // Missbrauch begrenzen: wenige Sitzungen pro Mitglied/Zeitfenster.
  try { const ok = await M.rateLimit('paysess:' + sess.id, 8, 600); if (ok === false) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); } } catch (e) {}

  let body = {}; try { body = await M.readBody(req); } catch (e) {}
  const choices = Array.isArray(body.choices) ? body.choices : Pay.ALL_CHOICES;

  let r;
  try { r = await Pay.createUserSession(sess.id, choices); }
  catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'session_failed' })); }

  if (r && r.status >= 200 && r.status < 300 && r.json && r.json.token) {
    const j = r.json;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      token: j.token,
      tokenValidUntil: j.tokenValidUntil || null,
      finionPayCustomerId: j.finionPayCustomerId || null,
      finionPayRegion: j.finionPayRegion || null,
    }));
  }

  // Finion Pay nicht aktiv / kein Recht / Validierung.
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: false, error: 'unavailable', mlStatus: (r && r.status) || 0,
    message: 'Kartenzahlung ist derzeit nicht verfügbar. Bitte aktiviere Finion Pay in Magicline.',
  }));
};
