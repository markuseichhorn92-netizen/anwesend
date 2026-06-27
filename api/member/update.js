'use strict';

/**
 * POST /api/member/update   (Authorization: Bearer <token>)
 *   { type: "address"|"payment", data: {...} }
 * Da direktes Schreiben in Magicline (noch) gesperrt ist (403), wird der
 * Änderungswunsch als E-Mail mit "vorher → jetzt" an das Studio geschickt.
 * Sobald der Self-Service-Schreibzugriff frei ist, kann hier direkt geschrieben
 * werden (Code in lib/members.js liegt bereit).
 */

const M = require('../../lib/members');
const { sendMail, hasMail } = require('../../lib/mail');

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
  const data = body.data || {};
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }

  let subject, lines = [];
  if (body.type === 'address') {
    [['Straße', 'street'], ['Nr.', 'houseNumber'], ['PLZ', 'zipCode'], ['Ort', 'city']].forEach(function (f) {
      var alt = String(m[f[1]] || ''), neu = String(data[f[1]] || '');
      if (alt !== neu) lines.push(f[0] + ': ' + (alt || '—') + '  →  ' + (neu || '—'));
    });
    if (!lines.length) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Keine Änderung erkannt.' })); }
    subject = 'Adressänderung gewünscht – ' + who(m);
  } else if (body.type === 'payment') {
    lines.push('Kontoinhaber: ' + (data.accountHolder || '—'));
    lines.push('IBAN ALT:    ' + (M.maskIban(m.bankAccount && m.bankAccount.iban) || '—'));
    lines.push('IBAN NEU:    ' + (String(data.iban || '').replace(/\s+/g, '') || '—'));
    if (data.bankName) lines.push('Bank: ' + data.bankName);
    if (data.bic) lines.push('BIC: ' + data.bic);
    subject = 'IBAN-Änderung gewünscht – ' + who(m);
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown_type' }));
  }

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand noch nicht eingerichtet (RESEND_API_KEY fehlt).' })); }

  const text = 'Änderungswunsch über den Mitgliederbereich\n\n'
    + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—') + '\n\n'
    + lines.join('\n') + '\n\nBitte in Magicline eintragen.';
  const mail = await sendMail(subject, text);
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: mail.ok,
    message: mail.ok ? 'Dein Änderungswunsch wurde übermittelt – wir tragen ihn zeitnah ein.'
                     : 'Konnte gerade nicht übermittelt werden. Bitte später erneut.',
  }));
};
