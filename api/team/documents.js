'use strict';

/**
 * /api/team/documents   (Authorization: Bearer <Team-Token>)
 * Team-Backend: Dokumente EINES Mitglieds (Scopes CUSTOMER_DOCUMENT_READ /
 * CUSTOMER_DOCUMENT_WRITE) - über die 403-festen Wrapper in lib/mlDocuments.
 * Das Team handelt hier FÜR ein Mitglied, daher kommt die Mitglieds-ID aus
 * dem Query bzw. Body (nicht aus einer Mitglieder-Session wie im Self-Service).
 *
 *   GET ?memberId=…              -> Liste:   { ok:true, available, items:[...] }
 *   GET ?memberId=…&docId=…      -> Download: Rohbytes (Content-Disposition) ODER
 *                                   { ok:true, url } (Redirect-Link) ODER 404 JSON
 *   POST { memberId, name, contentType, base64 } -> Upload
 *
 * Graceful Degradation ist zentral: liefert die API nicht sauber, gilt
 * available:false und die UI blendet den Bereich aus. Nie werfen.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');       // readBody, rateLimit
const D = require('../../lib/mlDocuments');    // 403-feste Wrapper (unverändert wiederverwendet)

// Upload-Größe begrenzen: base64 ist ~4/3 der Bytegröße -> ~8 MB Datei.
const MAX_B64 = 11000000;

// Dateinamen für Content-Disposition entschärfen (keine Pfade/Quotes/Steuerzeichen).
function safeName(s) {
  var n = String(s == null ? 'dokument' : s);
  var out = '';
  for (var i = 0; i < n.length; i++) {
    var code = n.charCodeAt(i);
    if (code < 32) continue;                       // Steuerzeichen (inkl. CR/LF) raus
    var c = n.charAt(i);
    if (c === '"' || c === '\\' || c === '/') continue;
    out += c;
  }
  out = out.replace(/\s+/g, ' ').trim().slice(0, 120);
  return out || 'dokument';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // -- GET: Liste oder Download --
  if (req.method === 'GET') {
    let memberId = null, docId = null, wantName = null;
    try { const u = new URL(req.url, 'http://x'); memberId = u.searchParams.get('memberId'); docId = u.searchParams.get('docId'); wantName = u.searchParams.get('name'); } catch (e) {}

    if (memberId == null || String(memberId).trim() === '') {
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' }));
    }

    if (docId) {
      let doc;
      try { doc = await D.getDocument(memberId, docId); } catch (e) { doc = { available: false }; }
      if (doc && doc.available && doc.url) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, url: doc.url }));
      }
      if (doc && doc.available && doc.base64) {
        let buf; try { buf = Buffer.from(doc.base64, 'base64'); } catch (e) { buf = null; }
        if (buf && buf.length) {
          res.setHeader('Content-Type', doc.contentType || 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(wantName || docId) + '"');
          res.setHeader('Cache-Control', 'no-store');
          res.statusCode = 200;
          return res.end(buf);
        }
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, available: false, message: 'Dokument nicht verfügbar.' }));
    }

    let list;
    try { list = await D.listDocuments(memberId); } catch (e) { list = { available: false }; }
    const available = !!(list && list.available);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, available: available, items: available ? (list.items || []) : [] }));
  }

  // -- POST: Upload --
  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const memberId = body.memberId;
    if (memberId == null || String(memberId).trim() === '') {
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' }));
    }
    const name = String(body.name || 'Dokument').slice(0, 180);
    const contentType = String(body.contentType || 'application/octet-stream').slice(0, 120);
    let base64 = String(body.base64 || '');
    const bi = base64.indexOf('base64,'); if (bi >= 0) base64 = base64.slice(bi + 7);
    base64 = base64.replace(/\s+/g, '');
    if (!base64 || base64.length < 20) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine Datei auswählen.' }));
    }
    if (base64.length > MAX_B64) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Datei zu groß (max. 8 MB).' }));
    }

    // Leichter Spam-Schutz: max. 30 Uploads pro Stunde je Mitglied.
    if (!(await M.rateLimit('team-doc:' + memberId, 30, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Uploads. Bitte später erneut.' }));
    }

    let r;
    try { r = await D.uploadDocument(memberId, { name: name, contentType: contentType, base64: base64 }); }
    catch (e) { r = { ok: false, forbidden: false }; }

    if (r && r.ok) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: 'Dokument hochgeladen.' }));
    }
    if (r && r.forbidden) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, forbidden: true, message: 'Das Hochladen von Dokumenten ist über Magicline aktuell nicht freigeschaltet (Scope CUSTOMER_DOCUMENT_WRITE).' }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Der Upload hat nicht geklappt. Bitte später erneut.' }));
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
