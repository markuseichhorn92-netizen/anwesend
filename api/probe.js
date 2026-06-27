'use strict';
/** TEMPORÄR: Re-Test Schreibrechte nach Scope-Änderung. id 0 -> kein echtes Schreiben. */
const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY = process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey || process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

async function call(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { method, path, status: r.status, msg: (j && (j.errorMessage || j.message)) || text.slice(0, 160), ref: j && j.reference };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  if (new URL(req.url, 'http://localhost').searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: '?run=1' })); }
  const ID = 0;
  const out = [];
  out.push(await call('POST', `/customers/${ID}/self-service/address-data`,
    { street: 'Teststr', houseNumber: '1', zipCode: '54290', city: 'Trier', countryCode: 'DE' }));
  out.push(await call('POST', `/customers/${ID}/self-service/master-data`,
    { firstName: 'Max', lastName: 'Muster', dateOfBirth: '1990-01-01', gender: 'MALE', customerTitle: 'MR' }));
  out.push(await call('POST', `/customers/${ID}/self-service/contact-data`,
    { email: 'test@example.de', phonePrivate: '+49 651 1234' }));
  out.push(await call('POST', `/customers/${ID}/self-service/payment-data`,
    { accountHolder: 'Max Muster', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', bankName: 'Testbank' }));
  res.statusCode = 200;
  res.end(JSON.stringify({ note: '403=keine Berechtigung, 400/404=erreichbar (Berechtigung ok)', out }, null, 2));
};
