'use strict';

/**
 * TEMPORÄRER, NUR-LESENDER Diagnose-Endpunkt.
 * Prüft mit ungültiger Kundennummer 0, ob der Key die Zahlungs-/Konto-Daten
 * LESEN darf (für die "letzte 4 der alten IBAN"-Validierung).
 *   401/403 = keine Leseberechtigung
 *   400/404 = erreichbar (Berechtigung vorhanden)
 * Es werden KEINE echten Mitgliedsdaten gelesen (id 0 existiert nicht).
 * Wird nach der Prüfung wieder entfernt.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

async function probe(path) {
  try {
    const r = await fetch(BASE + path, { headers: { 'x-api-key': API_KEY, Accept: 'application/json' } });
    const text = await r.text().catch(() => '');
    return { method: 'GET', path, status: r.status, snippet: text.slice(0, 200) };
  } catch (e) { return { method: 'GET', path, error: e.message }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: 'mit ?run=1 aufrufen' })); }

  const ID = 0;
  const checks = [];
  checks.push(await probe(`/customers/${ID}/self-service/payment-data`));     // Lesen der Zahlungsdaten (Self-Service)
  checks.push(await probe(`/customers/${ID}/account/payment-details`));        // Lesen der Konto-/Zahlungsdetails

  res.statusCode = 200;
  res.end(JSON.stringify({
    tenant: TENANT,
    hinweis: 'Nur GET mit Kundennummer 0. 401/403=keine Leseberechtigung, 400/404=erreichbar.',
    checks,
  }, null, 2));
};
