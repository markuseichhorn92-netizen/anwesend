'use strict';

/**
 * Gemeinsame API-Helfer für Serverless-Handler.
 * ---------------------------------------------
 * Bewusst klein gehalten – bestehende Endpunkte folgen bereits einem
 * einheitlichen Muster; neue Endpunkte nutzen diese Helfer, Bestehende werden
 * schrittweise migriert. Ergänzend setzt vercel.json plattformweit
 * X-Content-Type-Options, Referrer-Policy und Cache-Control für /api/*.
 *
 * Request-IDs: Vercel vergibt pro Anfrage automatisch `x-vercel-id`
 * (Antwort-Header) – dieser Wert dient als Korrelations-ID in Logs.
 */

// Einheitliche JSON-Antwort.
function json(res, code, obj) {
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

// Private, nicht cachebare JSON-Antwort-Header (personenbezogene Inhalte).
function privateJson(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
}

// Methoden-Gate: beantwortet 405 selbst.  if (!allowMethods(req,res,['POST'])) return;
function allowMethods(req, res, methods) {
  if (methods.indexOf(req.method) >= 0) return true;
  json(res, 405, { ok: false, error: 'method_not_allowed' });
  return false;
}

// Request-Body mit Größenlimit lesen (Standard 1 MB; Upload-Endpunkte geben
// explizit mehr an). Ungültiges JSON -> {} (nie werfen).
function readBody(req, maxBytes) {
  const cap = maxBytes > 0 ? maxBytes : 1e6;
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > cap) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = { json, privateJson, allowMethods, readBody };
