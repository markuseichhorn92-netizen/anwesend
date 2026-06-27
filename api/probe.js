'use strict';
/** TEMPORÄR: Vertrags-Struktur (nur Feldnamen/Typen) – zum Finden des Kündigungsdatum-Felds. */
const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY = process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey || process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

function shape(o, depth) {
  if (o === null) return 'null';
  if (Array.isArray(o)) return o.length ? ['<' + o.length + '>', shape(o[0], depth)] : [];
  if (typeof o === 'object') { if (depth <= 0) return '{…}'; const r = {}; for (const k in o) r[k] = shape(o[k], depth - 1); return r; }
  return typeof o;
}
async function call(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const t = await r.text().catch(() => ''); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t };
}
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  const u = new URL(req.url, 'http://localhost');
  if (u.searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: '?run=1&email=...' })); }
  const email = u.searchParams.get('email');
  if (!email) { res.statusCode = 400; return res.end(JSON.stringify({ hint: 'email fehlt' })); }
  const s = await call('POST', '/customers/search', { email });
  const id = Array.isArray(s.json) && s.json[0] && s.json[0].id;
  if (!id) { res.statusCode = 200; return res.end(JSON.stringify({ searchStatus: s.status, found: false })); }
  const c = await call('GET', '/customers/' + id + '/contracts');
  res.statusCode = 200;
  res.end(JSON.stringify({ contractsStatus: c.status, contractShape: Array.isArray(c.json) ? (c.json.length ? shape(c.json[0], 5) : 'leer []') : shape(c.json, 5) }, null, 2));
};
