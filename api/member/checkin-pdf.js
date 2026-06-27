'use strict';

/**
 * POST /api/member/checkin-pdf   (Authorization: Bearer <token>)
 *   { pdf: "<base64 oder data-URI>" }
 * Schickt die im Client erzeugte Anwesenheitsbestätigung (PDF) per Resend an
 * die hinterlegte Mitglieder-E-Mail. Voraussetzung: Absende-Domain in Resend
 * verifiziert (sonst erlaubt Resend nur Versand an die eigene Konto-Adresse).
 */

const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  let pdf = String(body.pdf || '').replace(/^data:[^;]*;base64,/, '');
  if (!pdf || pdf.length < 100) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'PDF fehlt.' })); }
  if (pdf.length > 7000000) { res.statusCode = 413; return res.end(JSON.stringify({ ok: false, message: 'PDF zu groß.' })); }

  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
  if (!m.email) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist noch nicht eingerichtet.' })); }

  const text = 'Hallo ' + (m.firstName || '') + ',\n\n'
    + 'im Anhang findest du deine Anwesenheitsbestätigung des Fit-Inn Trier mit deinen Check-ins.\n\n'
    + 'Sportliche Grüße\nDein Fit-Inn Trier';
  const mail = await sendMailRaw({
    to: m.email,
    subject: 'Deine Anwesenheitsbestätigung – Fit-Inn Trier',
    text: text,
    attachments: [{ filename: 'anwesenheitsbestaetigung.pdf', content: pdf }],
  });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? ('Die Bestätigung wurde an ' + m.email + ' geschickt.')
                     : 'Der Versand hat nicht geklappt – bitte später erneut oder lade das PDF direkt herunter.',
    detail: mail.ok ? undefined : String(mail.body || mail.error || '').slice(0, 200),
  }));
};
