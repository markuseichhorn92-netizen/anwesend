'use strict';

/**
 * 403-feste Wrapper um die Magicline-Dokument-Endpunkte (Scopes
 * CUSTOMER_DOCUMENT_READ / CUSTOMER_DOCUMENT_WRITE).
 *
 * WICHTIG – ANNAHME (nicht sicher verifiziert):
 *   Liste:    GET  /v1/customers/{id}/documents
 *   Download: GET  /v1/customers/{id}/documents/{docId}
 *   Upload:   POST /v1/customers/{id}/documents   { fileName, mimeType, data }
 *
 * Da die exakten Endpunkte/Feldnamen unsicher sind, ist JEDER Zugriff strikt
 * 403-/404-/fehlersicher: liefert die API nicht sauber, gilt {available:false}
 * bzw. {ok:false} und die UI blendet den Bereich aus / fällt auf den bestehenden
 * Weg zurück (z. B. /api/member/contract-copy für die Vertragskopie per E-Mail).
 * Es wird NIE geworfen und NIE gecrasht. Feldnamen werden robust normalisiert.
 */

const M = require('./members');

// Basis wie in lib/members.js – lokal abgeleitet, damit wir für den Download
// auch echte Rohbytes (arrayBuffer) holen können (M.ml liefert nur Text).
const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY || process.env.MLAPIKEY || process.env.mlapikey ||
  process.env.ML_APIKEY || process.env.MAGICLINE_API_KEY;
const BASE = 'https://' + TENANT + '.open-api.magicline.com/v1';

// Datum robust auf ISO (yyyy-mm-dd) bringen; leere/ungültige -> null.
function normDate(v) {
  if (!v) return null;
  try { return M.isoDate(v) || null; } catch (e) { return null; }
}

// Ein Roh-Dokument aus der API auf ein stabiles, schlankes Objekt normalisieren.
function normItem(d) {
  d = d || {};
  var id = d.id != null ? d.id
    : (d.documentId != null ? d.documentId
    : (d.uuid != null ? d.uuid
    : (d.fileId != null ? d.fileId
    : (d.key != null ? d.key : null))));
  var name = d.name || d.fileName || d.filename || d.title || d.documentName || 'Dokument';
  var date = normDate(d.createdDate || d.uploadedAt || d.uploadDate || d.created || d.createDate || d.date || null);
  var type = d.type || d.documentType || d.mimeType || d.contentType || null;
  var bytes = (typeof d.size === 'number') ? d.size
    : (typeof d.fileSize === 'number') ? d.fileSize
    : (typeof d.sizeInBytes === 'number') ? d.sizeInBytes : null;
  var sizeKb = null;
  if (typeof d.sizeKb === 'number') sizeKb = Math.round(d.sizeKb);
  else if (bytes != null) sizeKb = Math.max(1, Math.round(bytes / 1024));
  var out = { id: id, name: String(name), date: date };
  if (type) out.type = String(type);
  if (sizeKb != null) out.sizeKb = sizeKb;
  return out;
}

// Roh-GET mit x-api-key, um Binärdaten (arrayBuffer) laden zu können.
async function rawGet(path) {
  return fetch(BASE + path, { method: 'GET', headers: { 'x-api-key': API_KEY, Accept: '*/*' } });
}

// ── Liste der Dokumente ──
// -> { available:true, items:[{id,name,date,type?,sizeKb?}] } | { available:false }
async function listDocuments(id) {
  try {
    var r = await M.ml('GET', '/customers/' + encodeURIComponent(id) + '/documents');
    if (!r || r.status !== 200) return { available: false };
    var arr = Array.isArray(r.json) ? r.json
      : (r.json && Array.isArray(r.json.result)) ? r.json.result
      : (r.json && Array.isArray(r.json.documents)) ? r.json.documents
      : (r.json && Array.isArray(r.json.items)) ? r.json.items
      : (r.json && Array.isArray(r.json.content)) ? r.json.content : null;
    if (!arr) return { available: false };
    var items = arr.map(normItem).filter(function (x) { return x.id != null; });
    return { available: true, items: items };
  } catch (e) { return { available: false }; }
}

// ── Einzelnes Dokument (Download-Proxy) ──
// -> { available:true, contentType, base64 }  (Rohbytes)
// -> { available:true, url }                  (API liefert nur eine Download-URL)
// -> { available:false }                      (403/404/Fehler)
async function getDocument(id, docId) {
  try {
    var path = '/customers/' + encodeURIComponent(id) + '/documents/' + encodeURIComponent(docId);
    var r = await rawGet(path);
    if (!r) return { available: false };
    if (r.status === 403 || r.status === 404) return { available: false };
    if (!r.ok) return { available: false };
    var ct = String(r.headers.get('content-type') || '');
    var buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { available: false };
    if (/json/i.test(ct)) {
      var j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) {}
      if (!j || typeof j !== 'object') return { available: false };
      var url = j.url || j.downloadUrl || j.signedDocumentUrl || j.documentUrl || j.link || j.href;
      if (url) return { available: true, url: String(url) };
      var b64 = j.data || j.base64 || j.content || j.fileContent;
      if (b64 && typeof b64 === 'string') {
        return {
          available: true,
          contentType: String(j.mimeType || j.contentType || j.type || 'application/octet-stream'),
          base64: String(b64).replace(/^data:[^,]*,/, ''),
        };
      }
      return { available: false };
    }
    // Größenlimit für den Proxy (safety): ~20 MB Rohbytes.
    if (buf.length > 20000000) return { available: false };
    return { available: true, contentType: ct || 'application/octet-stream', base64: buf.toString('base64') };
  } catch (e) { return { available: false }; }
}

// ── Dokument hochladen ──
// -> { ok, forbidden, status, error }.  Wirft nie.
async function uploadDocument(id, doc) {
  doc = doc || {};
  var name = String(doc.name || 'Dokument');
  var contentType = String(doc.contentType || 'application/octet-stream');
  var base64 = String(doc.base64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!base64) return { ok: false, forbidden: false, status: 0, error: 'no_data' };
  try {
    var body = { fileName: name, mimeType: contentType, data: base64 };
    var r = await M.ml('POST', '/customers/' + encodeURIComponent(id) + '/documents', body);
    if (r && r.status >= 200 && r.status < 300) {
      return { ok: true, forbidden: false, status: r.status, error: null };
    }
    var forbidden = !!(r && (r.status === 401 || r.status === 403));
    return {
      ok: false,
      forbidden: forbidden,
      status: (r && r.status) || 0,
      error: (r && r.text) ? String(r.text).slice(0, 200) : 'upload_failed',
    };
  } catch (e) {
    return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { listDocuments, getDocument, uploadDocument };
