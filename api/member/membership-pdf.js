'use strict';

/**
 * POST /api/member/membership-pdf   (Authorization: Bearer <token>)
 *   { pdf: "<base64 oder data-URI>" }
 * Schickt die im Client (jsPDF) erzeugte Mitgliedschaftsbestätigung per Resend an
 * die hinterlegte Mitglieder-E-Mail. Spiegelt bewusst api/member/checkin-pdf.js –
 * das PDF wird im Client gebaut und hier nur verschickt.
 */

const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  const body = await M.readBody(req);
  let pdf = String((body && body.pdf) || '');
  const bi = pdf.indexOf('base64,');
  if (bi >= 0) pdf = pdf.slice(bi + 7);
  pdf = pdf.replace(/\s+/g, '');
  if (!pdf || pdf.length < 100) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'PDF fehlt.' })); }
  if (pdf.length > 7000000) { res.statusCode = 413; return res.end(JSON.stringify({ ok: false, message: 'PDF zu groß.' })); }

  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }
  if (!m.email) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist noch nicht eingerichtet.' })); }

  const portal = await memberLink(sess.id, 'contract');
  const tpl = renderEmail({
    preheader: 'Deine Mitgliedschaftsbestätigung findest du im Anhang.',
    name: m.firstName || '',
    eyebrow: 'Mitgliedschaftsbestätigung',
    headline: 'Deine Mitgliedschaftsbestätigung',
    intro: 'im Anhang findest du deine Mitgliedschaftsbestätigung des Fit-Inn Trier.',
    button: { label: 'Vertrag ansehen', href: portal },
    promo: false,
    footer: 'member',
  });
  const mail = await sendMailRaw({
    to: m.email,
    subject: 'Deine Mitgliedschaftsbestätigung – Fit-Inn Trier',
    text: tpl.text,
    html: tpl.html,
    attachments: [{ filename: 'mitgliedschaftsbestaetigung.pdf', content: pdf }],
  });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? ('Die Bestätigung wurde an ' + m.email + ' geschickt.')
                     : 'Der Versand hat nicht geklappt – bitte später erneut oder lade das PDF direkt herunter.',
    detail: mail.ok ? undefined : String(mail.body || mail.error || '').slice(0, 200),
  }));
};
