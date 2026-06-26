'use strict';

/**
 * TEMPORÄRER Diagnose-Endpunkt – prüft, ob der API-Key die Self-Service-
 * Schreib-Endpunkte erreichen darf. Es werden KEINE echten Daten geändert:
 * Aufruf mit ungültiger Kundennummer 0 + leerem Body.
 *   401/403 = keine Berechtigung am Key
 *   400/404/422 = Endpoint erreichbar (Berechtigung vorhanden, nur Request ungültig)
 *
 * Nach der Prüfung wird diese Datei wieder entfernt.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

async function probe(method, path, body) {
  try {
    const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(BASE + path, opt);
    const text = await r.text().catch(() => '');
    return { method, path, status: r.status, snippet: text.slice(0, 200) };
  } catch (e) {
    return { method, path, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: 'mit ?run=1 aufrufen' })); }

  const ID = 0; // ungültige Kundennummer -> keine echten Daten betroffen
  const checks = [];
  checks.push(await probe('GET', '/studios/information'));                                  // Kontrolle: sollte 200
  checks.push(await probe('GET', `/customers/${ID}`));                                       // Kunden-Lesen
  checks.push(await probe('POST', `/customers/${ID}/self-service/contact-data`, {}));        // Kontaktdaten
  checks.push(await probe('POST', `/customers/${ID}/self-service/address-data`, {}));        // Adresse
  checks.push(await probe('POST', `/customers/${ID}/self-service/master-data`, {}));         // Stammdaten
  checks.push(await probe('POST', `/customers/${ID}/self-service/payment-data`, {}));        // Zahlungsdaten
  checks.push(await probe('PUT', `/communications/${ID}/communication-preferences`, {}));    // Benachrichtigungen

  res.statusCode = 200;
  res.end(JSON.stringify({
    tenant: TENANT,
    hinweis: 'Probe mit Kundennummer 0 + leerem Body -> keine echten Daten geaendert. 401/403=keine Berechtigung, 400/404/422=erreichbar.',
    checks,
  }, null, 2));
};
