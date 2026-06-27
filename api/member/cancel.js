'use strict';

/**
 * POST /api/member/cancel   (Authorization: Bearer <token>)
 *   { action: "offer_accepted", offer: "discount10"|"pause", reason }
 *   { action: "cancel", reason, date }
 * Benachrichtigt das Studio per E-Mail (Retention bzw. Kündigung). Kündigungen
 * werden vorerst nur gemeldet (manuell in Magicline) – Direkteintrag folgt,
 * sobald bestätigt ist, dass der Key das darf.
 */

const M = require('../../lib/members');
const { sendMail, hasMail } = require('../../lib/mail');

const OFFERS = { discount10: '10 % Rabatt für 6 Monate', pause: 'Beitragspause' };

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

  let subject, text, okMsg;
  if (body.action === 'offer_accepted') {
    var off = OFFERS[body.offer] || body.offer || '—';
    subject = '🎉 Retention: Gegenangebot angenommen – ' + who(m);
    text = 'Kündigung abgewendet – Mitglied bleibt!\n\nMitglied: ' + who(m)
      + '\nKundennr.: ' + (m.customerNumber || '—')
      + '\nAngenommenes Angebot: ' + off
      + '\nUrspr. Kündigungsgrund: ' + (body.reason || '—')
      + '\n\nBitte "' + off + '" in Magicline einrichten.';
    okMsg = 'Super – wir richten dein Angebot ein und melden uns bei dir.';
  } else if (body.action === 'cancel') {
    var ct = null;
    try { ct = await M.getContract(sess.id); } catch (e) {}
    var targetDate = body.date || (ct && ct.nextCancellationDate) || 'nächstmöglich';
    subject = '⚠️ KÜNDIGUNG eingegangen – ' + who(m);
    text = 'Über den Mitgliederbereich wurde eine Kündigung eingereicht.\n\n'
      + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
      + '\nGrund: ' + (body.reason || '—')
      + '\nKündigung zum: ' + targetDate + '\nGegenangebote: abgelehnt\n'
      + (ct ? ('\nVertrag:'
              + '\n  Tarif: ' + (ct.rateName || '—')
              + '\n  Vertragsende: ' + (ct.endDate || '—')
              + '\n  Kündigungsfrist: ' + (ct.cancellationPeriod || '—')
              + '\n  Kündigung möglich bis: ' + (ct.deadline || '—') + (ct.deadlinePassed ? ' (überschritten)' : '')
              + '\n  Nächstmöglicher Kündigungstermin: ' + (ct.nextCancellationDate || '—')
              + '\n  ContractId: ' + (ct.contractId || '—'))
            : '\n(Vertragsdaten nicht abrufbar)')
      + '\n\nBitte Kündigung in Magicline verarbeiten.';
    okMsg = 'Deine Kündigung ist eingegangen. Wir bestätigen sie dir zeitnah per E-Mail.';
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown_action' }));
  }

  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand noch nicht eingerichtet (RESEND_API_KEY fehlt).' })); }
  const mail = await sendMail(subject, text);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: mail.ok, message: mail.ok ? okMsg : 'Übermittlung fehlgeschlagen – bitte später erneut.' }));
};
