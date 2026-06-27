'use strict';

/**
 * TEMPORÄR (nach Gebrauch löschen). GET /api/diag3?k=fitinn-probe-2026&cid=<id>
 * Sucht das Dokumenten-/Vertrags-Endpoint der Magicline Open API
 * (CUSTOMER_DOCUMENT_READ). Gibt nur Metadaten/Status zurück, KEINE Inhalte.
 */

const M = require('../lib/members');

function keys(o) { return o && typeof o === 'object' ? Object.keys(o) : []; }
function meta(d) {
  const out = {};
  ['id', 'documentId', 'name', 'fileName', 'filename', 'title', 'type', 'documentType',
   'category', 'mimeType', 'contentType', 'createdAt', 'creationDate', 'date', 'size']
    .forEach((k) => { if (d && d[k] !== undefined) out[k] = d[k]; });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }
  const cid = url.searchParams.get('cid');
  if (!cid) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing cid' })); }
  const eid = encodeURIComponent(cid);
  const out = {};

  // Vertrag(e) holen → contractId
  let contractId = null;
  try {
    const r = await M.ml('GET', '/customers/' + eid + '/contracts');
    const list = Array.isArray(r.json) ? r.json : [];
    out.contracts = { status: r.status, count: list.length, firstKeys: keys(list[0]) };
    if (list[0]) contractId = list[0].id;
    out.contractId = contractId;
  } catch (e) { out.contracts = { error: e.message }; }

  // Dokumentenliste – mehrere Endpoint-Varianten
  const listVariants = [
    ['cust_documents', '/customers/' + eid + '/documents'],
    ['cust_document', '/customers/' + eid + '/document'],
    ['cust_files', '/customers/' + eid + '/files'],
    ['contract_documents', contractId ? ('/customers/' + eid + '/contracts/' + contractId + '/documents') : null],
  ];
  out.lists = {};
  let firstDocId = null, firstDocPath = null;
  for (const [name, path] of listVariants) {
    if (!path) continue;
    try {
      const r = await M.ml('GET', path);
      const arr = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.result) ? r.json.result : (r.json && Array.isArray(r.json.documents) ? r.json.documents : null));
      out.lists[name] = {
        status: r.status,
        topKeys: keys(r.json),
        count: arr ? arr.length : null,
        sample: arr ? arr.slice(0, 8).map(meta) : (r.json ? meta(r.json) : String(r.text || '').slice(0, 120)),
      };
      if (arr && arr.length && firstDocId === null) {
        firstDocId = arr[0].id || arr[0].documentId || null;
        firstDocPath = path;
      }
    } catch (e) { out.lists[name] = { error: e.message }; }
  }

  out.firstDocId = firstDocId;

  // Versuch, den Inhalt eines Dokuments zu laden (nur Status + Content-Type + Größe)
  if (firstDocId && firstDocPath) {
    const dl = [
      firstDocPath + '/' + encodeURIComponent(firstDocId),
      firstDocPath + '/' + encodeURIComponent(firstDocId) + '/content',
      firstDocPath + '/' + encodeURIComponent(firstDocId) + '/download',
    ];
    out.download = {};
    for (const p of dl) {
      try {
        // Roh-Fetch, weil der Inhalt evtl. kein JSON ist
        const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
        const KEY = process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
        const rr = await fetch('https://' + TENANT + '.open-api.magicline.com/v1' + p, { headers: { 'x-api-key': KEY, Accept: '*/*' } });
        const buf = await rr.arrayBuffer().catch(() => null);
        const ct = rr.headers.get('content-type');
        let jsonKeys = null, followUrl = null;
        if (ct && ct.indexOf('json') >= 0 && buf) {
          try { const j = JSON.parse(Buffer.from(buf).toString('utf8')); jsonKeys = keys(j); if (j && j.url) followUrl = j.url; } catch (e) {}
        }
        out.download[p] = { status: rr.status, contentType: ct, bytes: buf ? buf.byteLength : 0, jsonKeys: jsonKeys };
        // Wenn detail eine url liefert: diese laden (echtes PDF?)
        if (followUrl) {
          try {
            const fr = await fetch(followUrl);
            const fb = await fr.arrayBuffer().catch(() => null);
            out.download[p].followedUrl = { status: fr.status, contentType: fr.headers.get('content-type'), bytes: fb ? fb.byteLength : 0, urlHost: (function () { try { return new URL(followUrl).host; } catch (e) { return null; } })() };
          } catch (e) { out.download[p].followedUrl = { error: e.message }; }
        }
      } catch (e) { out.download[p] = { error: e.message }; }
    }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
