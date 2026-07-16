'use strict';

/**
 * Login mit „Mit Apple anmelden" / „Mit Google anmelden" aus der eigenen App.
 * Der native Dialog liefert ein ID-Token; wir prüfen es serverseitig (Signatur,
 * iss, aud, exp) und ordnen es per VERIFIZIERTER E-Mail dem Magicline-Konto zu.
 *
 *   GET  -> { ok, google, apple }   (welche Anbieter konfiguriert sind)
 *   POST { provider:'google'|'apple', idToken, remember } ->
 *           { ok:true, token }                      bei eindeutigem Mitgliedskonto
 *           { ok:false, needsCode:true, reason }    sonst (App fällt auf Code-Login zurück)
 *
 * „Schläft", bis die Client-IDs gesetzt sind (GOOGLE_CLIENT_ID / APPLE_CLIENT_ID,
 * kommasepariert für mehrere Bundles). Solange bleibt nur der Code-Login aktiv.
 */

const M = require('../../lib/members');
const { verifyIdToken } = require('../../lib/oauthVerify');

function envList(name, alt) {
  return String(process.env[name] || process.env[alt] || '').split(',').map((s) => s.trim()).filter(Boolean);
}
const GOOGLE_AUD = envList('GOOGLE_CLIENT_ID', 'GOOGLE_IOS_CLIENT_ID');
const APPLE_AUD = envList('APPLE_CLIENT_ID', 'APPLE_BUNDLE_ID');

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'ip';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, google: GOOGLE_AUD.length > 0, apple: APPLE_AUD.length > 0 }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  if (!(await M.rateLimit('natlogin:' + clientIp(req), 20, 600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche. Bitte kurz warten.' }));
  }

  const body = await M.readBody(req);
  const provider = String(body.provider || '');
  const idToken = String(body.idToken || '');

  let payload = null;
  if (provider === 'google' && GOOGLE_AUD.length) {
    payload = await verifyIdToken(idToken, {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      iss: ['https://accounts.google.com', 'accounts.google.com'],
      aud: GOOGLE_AUD,
    });
  } else if (provider === 'apple' && APPLE_AUD.length) {
    payload = await verifyIdToken(idToken, {
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      iss: 'https://appleid.apple.com',
      aud: APPLE_AUD,
    });
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_provider' }));
  }

  if (!payload) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'invalid_token' })); }

  const email = String(payload.email || '').trim().toLowerCase();
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  // Ohne (verifizierte) E-Mail können wir das Magicline-Konto nicht sicher zuordnen
  // (Apple kann die Adresse verbergen) -> App nutzt dann den normalen Code-Login.
  if (!email || !verified) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, needsCode: true, reason: 'no_email' }));
  }

  let matches = [];
  try { matches = await M.searchByEmail(email); } catch (e) {}
  if (!matches.length) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, needsCode: true, reason: 'unknown' }));
  }

  // Eindeutig genau ein Konto? Sonst das Mitgliedschaftskonto wählen; bleibt es
  // mehrdeutig (Dubletten ohne klaren Vertrag) -> Code-Login mit Mitgliedsnummer.
  const acct = matches.length === 1 ? matches[0] : await M.pickMembershipAccount(matches);
  if (!acct) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, needsCode: true, reason: 'ambiguous', email: email }));
  }

  const id = acct.id != null ? acct.id : acct.customerId;
  const ttl = body.remember === false ? 1800 : 60 * 60 * 24 * 180;   // „angemeldet bleiben" = 180 Tage
  const token = await M.createSession(id, ttl);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, token: token }));
};
