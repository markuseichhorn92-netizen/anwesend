'use strict';

/**
 * POST /api/member/contract-copy   (Authorization: Bearer <token>)
 * Schickt dem Mitglied eine Kopie SEINES AKTUELLEN VERTRAGS per E-Mail.
 *
 * Sicherheit / Datenschutz:
 *  - Es wird AUSSCHLIESSLICH das signierte Vertrags-PDF des aktuell gültigen
 *    Vertrags gesendet – über contract.signedDocumentUrl, das direkt am
 *    Vertragsdatensatz hängt. Es wird NICHT der allgemeine Dokumentenspeicher
 *    durchsucht (dort liegen z. B. auch Kündigungen, Atteste, Schriftverkehr,
 *    die das Mitglied nicht automatisch erhalten soll).
 *  - "Aktuell" = nicht stornierter (reversed=false) Vertrag, bevorzugt mit
 *    Status ACTIVE/RUNNING; sonst der jüngste nicht stornierte Vertrag.
 *  - Es wird genau EIN PDF gesendet (der aktuelle Vertrag), nicht mehrere.
 */

const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');

function pickCurrentContract(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = list.slice().sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
  return sorted.find((c) => !c.reversed && /ACTIVE|RUNNING|LAUF/i.test(String(c.contractStatus || '')))
    || sorted.find((c) => !c.reversed)
    || null;
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
  let contracts = [];
  try { const r = await M.ml('GET', '/customers/' + eid + '/contracts'); contracts = Array.isArray(r.json) ? r.json : []; } catch (e) {}

  const current = pickCurrentContract(contracts);
  if (!current) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Wir konnten keinen aktuellen Vertrag finden. Bitte melde dich bei uns – wir schicken dir deinen Vertrag gerne zu.' })); }
  if (!current.signedDocumentUrl) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für deinen Vertrag liegt kein digitales Dokument vor. Bitte melde dich bei uns – wir senden dir deinen Vertrag gerne zu.' })); }

  // Genau das eine, aktuelle Vertrags-PDF laden
  let pdfB64 = null;
  try {
    const fr = await fetch(current.signedDocumentUrl);
    if (fr.ok) {
      const buf = Buffer.from(await fr.arrayBuffer());
      const ct = String(fr.headers.get('content-type') || '');
      if (buf.length > 100 && buf.length < 9000000 && /pdf/i.test(ct)) pdfB64 = buf.toString('base64');
    }
  } catch (e) {}
  if (!pdfB64) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Der Vertrag konnte gerade nicht geladen werden. Bitte versuche es später erneut.' })); }

  const fileName = 'Vertrag-' + (m.customerNumber || 'Fit-Inn-Trier') + '.pdf';
  const text = 'Hallo ' + (m.firstName || '') + ',\n\n'
    + 'im Anhang findest du eine Kopie deines aktuellen Vertrags' + (current.rateName ? (' (' + current.rateName + ')') : '') + ' beim Fit-Inn Trier.\n\n'
    + 'Sportliche Grüße\nDein Fit-Inn Trier';
  const mail = await sendMailRaw({
    to: m.email,
    subject: 'Deine Vertragskopie – Fit-Inn Trier',
    text: text,
    attachments: [{ filename: fileName, content: pdfB64 }],
  });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? ('Deine Vertragskopie wurde an ' + m.email + ' geschickt.') : 'Der Versand hat nicht geklappt – bitte später erneut.',
  }));
};
