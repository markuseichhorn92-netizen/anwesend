'use strict';
/** TEMPORÄR: Vertrag lesen + Kündigung schreiben prüfen. id 0 -> kein echter Vorgang. */
const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY = process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey || process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;
async function call(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { method, path, status: r.status, msg: (j && (j.errorMessage || j.message)) || text.slice(0, 160) };
}
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  if (new URL(req.url, 'http://localhost').searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: '?run=1' })); }
  const out = [];
  out.push(await call('GET', '/customers/0/contracts'));
  out.push(await call('GET', '/memberships/self-service/contract-cancelation-reasons'));
  out.push(await call('POST', '/memberships/0/self-service/ordinary-contract-cancelation', { contractId: 0, cancellationReasonId: 1, cancellationDate: '2026-12-31' }));
  res.statusCode = 200;
  res.end(JSON.stringify({ note: '403=keine Berechtigung; 400/404=erreichbar', out }, null, 2));
};
