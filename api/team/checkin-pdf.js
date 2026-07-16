'use strict';

/**
 * POST /api/team/checkin-pdf   (Team-Session erforderlich)
 *   { id: "<memberId>", pdf: "<base64 oder data-URI>" }
 * Schickt die im Team-Backend erzeugte Anwesenheitsbestätigung (PDF) per
 * Resend an die beim Mitglied hinterlegte E-Mail-Adresse. Spiegelt bewusst
 * das Member-Pendant (api/member/checkin-pdf.js): PDF wird im Client (jsPDF)
 * gebaut und hier nur noch verschickt. Voraussetzung: Absende-Domain in
 * Resend verifiziert.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'checkin.manage', res)) return;

  const body = await M.readBody(req);
  const id = String((body && (body.id || body.memberId)) || '').trim();
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Mitglied fehlt.' })); }

  // Robust: alles vor (inkl.) "base64," entfernen (jsPDF liefert einen data-URI mit Dateinamen-Präfix).
  let pdf = String((body && body.pdf) || '');
  const bi = pdf.indexOf('base64,');
  if (bi >= 0) pdf = pdf.slice(bi + 7);
  pdf = pdf.replace(/\s+/g, '');
  if (!pdf || pdf.length < 100) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'PDF fehlt.' })); }
  if (pdf.length > 7000000) { res.statusCode = 413; return res.end(JSON.stringify({ ok: false, message: 'PDF zu groß.' })); }

  const m = await M.getMember(id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  if (!m.email) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für dieses Mitglied ist keine E-Mail-Adresse hinterlegt.' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist noch nicht eingerichtet.' })); }

  const portal = await memberLink(id, 'checkins');
  const tpl = renderEmail({
    preheader: 'Deine Anwesenheitsbestätigung findest du im Anhang.',
    name: m.firstName || '',
    eyebrow: 'Anwesenheitsbestätigung',
    headline: 'Deine Anwesenheitsbestätigung',
    intro: 'im Anhang findest du deine Anwesenheitsbestätigung des Fit-Inn Trier mit deinen Check-ins.',
    button: { label: 'Check-ins ansehen', href: portal },
    promo: false,
    footer: 'member',
  });
  const mail = await sendMailRaw({
    to: m.email,
    subject: 'Deine Anwesenheitsbestätigung – Fit-Inn Trier',
    text: tpl.text,
    html: tpl.html,
    attachments: [{ filename: 'anwesenheitsbestaetigung.pdf', content: pdf }],
  });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? ('Die Bestätigung wurde an ' + m.email + ' geschickt.')
                     : 'Der Versand hat nicht geklappt – bitte das PDF direkt herunterladen.',
    detail: mail.ok ? undefined : String((mail && (mail.body || mail.error)) || '').slice(0, 200),
  }));
};
