'use strict';

/**
 * POST /api/member/contract-copy   (Authorization: Bearer <token>)
 * Schickt dem Mitglied eine Kopie seines Vertrags per E-Mail (Resend).
 * Die Vertrags-PDFs werden aus Magicline geholt (CUSTOMER_DOCUMENT_READ):
 *   1) GET /customers/{id}/documents            → Liste {result:[{id,fileName}]}
 *   2) GET /customers/{id}/documents/{docId}     → { url, fileName, ... }
 *   3) url laden (assets.magicline.com)          → das eigentliche PDF
 */

const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');

async function listDocuments(eid) {
  const all = [];
  let offset = 0;
  for (let p = 0; p < 20; p++) {
    const r = await M.ml('GET', '/customers/' + eid + '/documents?sliceSize=50&offset=' + offset);
    if (r.status !== 200 || !r.json) break;
    const list = Array.isArray(r.json.result) ? r.json.result : [];
    for (const d of list) all.push(d);
    if (!r.json.hasNext || list.length === 0) break;
    const next = parseInt(r.json.offset, 10);
    offset = Number.isFinite(next) && next > offset ? next : offset + 50;
  }
  return all;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
  if (!m.email) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist noch nicht eingerichtet.' })); }

  const eid = encodeURIComponent(sess.id);
  let docs = [];
  try { docs = await listDocuments(eid); } catch (e) {}

  // Nur Vertragsdokumente (Vertrag / Modulvertrag), Duplikate je Dateiname raus
  const contractDocs = docs.filter((d) => /vertrag/i.test(String(d.fileName || d.name || '')));
  const seen = new Set();
  const pick = [];
  for (const d of contractDocs) {
    const fn = String(d.fileName || d.name || '').toLowerCase();
    if (seen.has(fn)) continue;
    seen.add(fn);
    pick.push(d);
    if (pick.length >= 6) break;
  }
  if (!pick.length) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Wir konnten kein Vertragsdokument finden. Bitte melde dich bei uns – wir schicken dir deinen Vertrag gerne zu.' }));
  }

  // PDFs laden
  const attachments = [];
  for (const d of pick) {
    const id = d.id || d.documentId;
    if (!id) continue;
    try {
      const det = await M.ml('GET', '/customers/' + eid + '/documents/' + encodeURIComponent(id));
      const url = det.json && det.json.url;
      let fn = (det.json && det.json.fileName) || d.fileName || ('Vertrag-' + id + '.pdf');
      if (!/\.pdf$/i.test(fn)) fn += '.pdf';
      if (!url) continue;
      const fr = await fetch(url);
      if (!fr.ok) continue;
      const buf = Buffer.from(await fr.arrayBuffer());
      if (buf.length > 0 && buf.length < 8000000) attachments.push({ filename: fn, content: buf.toString('base64') });
    } catch (e) {}
  }
  if (!attachments.length) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Der Vertrag konnte gerade nicht geladen werden. Bitte versuche es später erneut.' }));
  }

  const text = 'Hallo ' + (m.firstName || '') + ',\n\n'
    + 'im Anhang findest du ' + (attachments.length === 1 ? 'eine Kopie deines Vertrags' : ('Kopien deiner Vertragsdokumente (' + attachments.length + ')')) + ' beim Fit-Inn Trier.\n\n'
    + 'Sportliche Grüße\nDein Fit-Inn Trier';
  const mail = await sendMailRaw({ to: m.email, subject: 'Deine Vertragskopie – Fit-Inn Trier', text: text, attachments: attachments });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    count: attachments.length,
    message: mail.ok ? ('Deine Vertragskopie wurde an ' + m.email + ' geschickt.') : 'Der Versand hat nicht geklappt – bitte später erneut.',
  }));
};
