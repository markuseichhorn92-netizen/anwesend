'use strict';

/**
 * ID-Token-Prüfung für „Mit Apple anmelden" / „Mit Google anmelden" in der eigenen
 * App. Der native Login-Dialog liefert ein signiertes ID-Token (JWT); hier wird es
 * serverseitig gegen die öffentlichen Schlüssel des Anbieters (JWKS) geprüft –
 * Signatur, Aussteller (iss), Zielgruppe (aud) und Ablauf (exp).
 *
 * Nur node:crypto + fetch, keine Dependency. Node importiert die JWK-Schlüssel direkt
 * (crypto.createPublicKey({format:'jwk'})), daher keine manuelle Modulus-Rechnerei.
 * JWKS werden in Upstash zwischengespeichert (1 h), wenn ein Store verfügbar ist.
 */

const crypto = require('node:crypto');

let store = null;
try { store = require('./store'); } catch (e) { store = { hasStore: false }; }

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function decodeSegment(seg) {
  try { return JSON.parse(b64urlToBuf(seg).toString('utf8')); } catch (e) { return null; }
}

async function fetchJwks(url) {
  const cacheKey = 'oauth:jwks:' + url;
  if (store.hasStore) {
    try { const [c] = await store.redisPipeline([['GET', cacheKey]]); if (c) return JSON.parse(c); } catch (e) {}
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('jwks_fetch_failed:' + r.status);
  const j = await r.json();
  if (store.hasStore) { try { await store.redisPipeline([['SET', cacheKey, JSON.stringify(j), 'EX', '3600']]); } catch (e) {} }
  return j;
}

const ALG = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512' };

// Prüft ein RS256-ID-Token. Liefert das Payload-Objekt oder null.
//   opts = { jwksUrl, iss (string|string[]), aud (string|string[]) }
async function verifyIdToken(idToken, opts) {
  opts = opts || {};
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || !payload || !ALG[header.alg]) return null;

  let jwks;
  try { jwks = await fetchJwks(opts.jwksUrl); } catch (e) { return null; }
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) return null;

  let pub;
  try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch (e) { return null; }
  const ok = crypto.createVerify(ALG[header.alg]).update(parts[0] + '.' + parts[1]).verify(pub, b64urlToBuf(parts[2]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > Number(payload.exp) + 60) return null;     // abgelaufen (+60 s Toleranz)
  if (payload.nbf && now < Number(payload.nbf) - 60) return null;
  if (opts.iss) {
    const allow = Array.isArray(opts.iss) ? opts.iss : [opts.iss];
    if (allow.indexOf(payload.iss) < 0) return null;
  }
  if (opts.aud) {
    const allow = Array.isArray(opts.aud) ? opts.aud : [opts.aud];
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.some((a) => allow.indexOf(a) >= 0)) return null;
  }
  return payload;
}

module.exports = { verifyIdToken };
