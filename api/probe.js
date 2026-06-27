'use strict';

/**
 * TEMPORÄR: Schema-Discovery für den Mitgliederbereich.
 * - Suche per (Fake-)E-Mail: prüft Mechanik + Berechtigung, keine echten Treffer
 * - Schreib-Schemas: POST mit Kundennummer 0 + geratenem Body -> Validierungs-
 *   meldungen zeigen die erwarteten Felder. id 0 existiert nicht -> kein Write.
 * Wird danach entfernt.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;
const FAKE = 'kein.treffer.test.xyz@example.invalid';

async function call(method, path, body) {
  try {
    const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(BASE + path, opt);
    const text = await r.text().catch(() => '');
    return { method, path, status: r.status, snippet: text.slice(0, 260) };
  } catch (e) { return { method, path, error: e.message }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  if (new URL(req.url, 'http://localhost').searchParams.get('run') !== '1') {
    res.statusCode = 400; return res.end(JSON.stringify({ hint: 'mit ?run=1' }));
  }

  const checks = [];
  // Suche per E-Mail (Mechanik + Berechtigung)
  checks.push(await call('GET', `/customers/by?email=${encodeURIComponent(FAKE)}`));
  checks.push(await call('POST', '/customers/search', { email: FAKE }));
  checks.push(await call('POST', '/customers/search', { searchTerm: FAKE }));

  // Schreib-Schemas (id 0, geratene Bodies)
  checks.push(await call('POST', '/customers/0/self-service/address-data',
    { street: 'Teststr', houseNumber: '1', zip: '54290', city: 'Trier', countryCode: 'DE' }));
  checks.push(await call('POST', '/customers/0/self-service/master-data',
    { firstName: 'Max', lastName: 'Muster', dateOfBirth: '1990-01-01' }));
  checks.push(await call('POST', '/customers/0/self-service/payment-data',
    { accountHolder: 'Max Muster', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', bankName: 'Testbank' }));

  res.statusCode = 200;
  res.end(JSON.stringify({ tenant: TENANT, checks }, null, 2));
};
