'use strict';

/**
 * POST /api/member/appointment   (Authorization: Bearer <token>)
 *   { type, preferred }
 * Solange die buchbaren Termine/Slots der Open API gesperrt sind (403),
 * wird der Terminwunsch per E-Mail ans Studio gemeldet (manuelle Buchung).
 */

const M = require('../../lib/members');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  const body = await M.readBody(req);
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand noch nicht eingerichtet.' })); }
  const text = 'Terminwunsch über den Mitgliederbereich\n\n'
    + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
    + '\nTerminart: ' + (body.type || '—')
    + '\nWunsch: ' + (body.preferred || '—')
    + '\n\nBitte Termin in Magicline anlegen und dem Mitglied bestätigen.';
  const mail = await sendMail('📅 Terminwunsch – ' + who(m), text);

  // Bestätigung ans Mitglied (best effort – darf den Vorgang nie scheitern lassen)
  if (mail.ok && m.email) {
    try {
      const cm = renderEmail({
        preheader: 'Dein Terminwunsch ist bei uns eingegangen.',
        name: m.firstName || '',
        eyebrow: 'Terminwunsch',
        headline: 'Dein Terminwunsch ist eingegangen',
        intro: 'Wir haben deinen Terminwunsch erhalten und melden uns mit einem konkreten Termin per E-Mail bei dir.',
        panel: [
          { label: 'Terminart', value: body.type || '—' },
          { label: 'Wunsch', value: body.preferred || 'nach Absprache' },
        ],
        button: { label: 'Termine ansehen', href: BASE + '/mitglieder' },
        promo: true,
        footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Dein Terminwunsch ist eingegangen – Fit-Inn Trier', text: cm.text, html: cm.html });
    } catch (e) { /* Mitglied-Mail ist optional */ }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? 'Dein Terminwunsch ist eingegangen – wir bestätigen dir den Termin per E-Mail.'
                     : 'Konnte gerade nicht übermittelt werden. Bitte später erneut.',
  }));
};
