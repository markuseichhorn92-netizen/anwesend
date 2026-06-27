'use strict';

/**
 * TEMPORÄR: Feldnamen-Discovery für den Mitgliederbereich.
 * Gibt NUR die Struktur (Feldnamen + Typen) eines Mitglieds-Datensatzes zurück,
 * KEINE personenbezogenen Werte. Plus restliche Pflichtfelder fürs Schreiben.
 * Wird danach entfernt.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = `https://${TENANT}.open-api.magicline.com/v1`;

// nur Form (Schlüssel + Typ), niemals Werte
function shape(o, depth) {
  if (o === null) return 'null';
  if (Array.isArray(o)) return o.length ? ['<' + o.length + '>', shape(o[0], depth)] : [];
  if (typeof o === 'object') {
    if (depth <= 0) return '{…}';
    const r = {}; for (const k in o) r[k] = shape(o[k], depth - 1); return r;
  }
  return typeof o;
}

async function call(method, path, body) {
  const opt = { method, headers: { 'x-api-key': API_KEY, Accept: 'application/json' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { method, path, status: r.status, json, text };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'missing_api_key' })); }
  const u = new URL(req.url, 'http://localhost');
  if (u.searchParams.get('run') !== '1') { res.statusCode = 400; return res.end(JSON.stringify({ hint: 'mit ?run=1&email=...' })); }
  const email = u.searchParams.get('email');

  const out = {};

  // 1) Struktur eines echten Datensatzes (nur Feldnamen/Typen)
  if (email) {
    const s = await call('POST', '/customers/search', { email });
    out.searchStatus = s.status;
    out.recordShape = Array.isArray(s.json) ? (s.json.length ? shape(s.json[0], 4) : 'leer []') : shape(s.json, 4);
  } else {
    out.note = 'kein ?email= angegeben -> Struktur übersprungen';
  }

  // 2) Restliche Pflichtfelder Schreiben (id 0, keine echten Daten)
  const addr = await call('POST', '/customers/0/self-service/address-data',
    { street: 'Teststr', houseNumber: '1', zipCode: '54290', city: 'Trier', countryCode: 'DE' });
  out.addressWrite = { status: addr.status, msg: (addr.json && addr.json.errorMessage) || addr.text.slice(0, 160), ref: addr.json && addr.json.reference };

  const master = await call('POST', '/customers/0/self-service/master-data',
    { firstName: 'Max', lastName: 'Muster', dateOfBirth: '1990-01-01', gender: 'MALE' });
  out.masterWrite = { status: master.status, msg: (master.json && master.json.errorMessage) || master.text.slice(0, 160), ref: master.json && master.json.reference };

  res.statusCode = 200;
  res.end(JSON.stringify(out, null, 2));
};
