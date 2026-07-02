'use strict';

/**
 * POST /api/member/cancel-withdraw   (Authorization: Bearer <token>)
 *   {} – kein Body nötig.
 * Zieht eine bestehende ordentliche Kündigung über die Magicline Open API zurück
 * (Scope MEMBERSHIP_SELF_SERVICE_WRITE) – „Kündigung zurückziehen" als
 * Rückgewinnungs-Aktion. Erfolg -> Vorgang „Kündigung zurückgezogen – willkommen
 * zurück!" + Bestätigungsmail. Fehlt der Scope (403), wird die Aktion sauber als
 * „gerade nicht möglich" gemeldet – und der Wunsch trotzdem best effort ans Studio
 * gespiegelt, damit nichts verloren geht.
 */

const M = require('../../lib/members');
const MC = require('../../lib/mlCancel');
const Inbox = require('../../lib/inbox');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function who(m) {
  return ((m.firstName || '') + ' ' + (m.lastName || '')).trim()
    + (m.customerNumber ? ' (' + m.customerNumber + ')' : '')
    + (m.email ? ' · ' + m.email : '');
}

// Designte „Willkommen zurück"-Mail ans Mitglied (best effort).
async function sendWelcomeBackMail(m, ct) {
  if (!hasMail || !m.email) return;
  var panel = [];
  if (ct && ct.rateName) panel.push({ label: 'Tarif', value: ct.rateName });
  if (ct && ct.nextCancellationDate) panel.push({ label: 'Nächster Kündigungstermin', value: ct.nextCancellationDate });
  try {
    var portal = await memberLink(m.id, 'contract');
    var wm = renderEmail({
      preheader: 'Schön, dass du bleibst!',
      name: m.firstName || '',
      eyebrow: 'Willkommen zurück',
      headline: 'Schön, dass du bleibst!',
      intro: 'Deine Kündigung ist zurückgezogen – deine Mitgliedschaft läuft ganz normal weiter, zu deinen gewohnten Konditionen. Wir freuen uns auf dein nächstes Training!',
      panel: panel.length ? panel : null,
      button: { label: 'Zum Mitgliederbereich', href: portal },
      promo: true,
      referral: { code: m.referralCode, firstName: m.firstName },
      footer: 'member',
    });
    await sendMailRaw({ to: m.email, subject: 'Schön, dass du bleibst! – Fit-Inn Trier', text: wm.text, html: wm.html });
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not_found' })); }

  var ct = null;
  try { ct = await M.getContract(sess.id); } catch (e) {}
  if (!ct || !ct.contractId) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: false, message: 'Wir konnten deinen Vertrag gerade nicht laden – bitte kurz im Studio melden.' }));
  }

  const w = await MC.withdrawCancel(sess.id, ct.contractId);

  if (w.ok) {
    try { await Inbox.addVorgang(sess.id, { type: 'kuendigung', subject: 'Kündigung zurückgezogen', status: 'abgeschlossen',
      systemText: 'Du hast deine Kündigung zurückgezogen – deine Mitgliedschaft läuft normal weiter.',
      teamText: 'Schön, dass du bleibst! Deine Kündigung ist zurückgezogen – deine Mitgliedschaft läuft ganz normal weiter, zu deinen gewohnten Konditionen. Willkommen zurück!' }); } catch (e) {}
    if (hasMail) {
      try {
        await sendMail('↩️ Kündigung zurückgezogen – ' + who(m),
          'Ein Mitglied hat seine Kündigung über den Mitgliederbereich ZURÜCKGEZOGEN – direkt in Magicline eingetragen (Open API, Self-Service).\n\n'
          + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
          + (ct.rateName ? ('\nTarif: ' + ct.rateName) : '') + '\nContractId: ' + (ct.contractId || '—')
          + '\n\nKeine manuelle Aktion nötig – nur zur Info. Willkommen zurück!');
      } catch (e) {}
    }
    await sendWelcomeBackMail(m, ct);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, via: 'magicline', message: 'Schön, dass du bleibst! Deine Kündigung ist zurückgezogen – deine Mitgliedschaft läuft ganz normal weiter.' }));
  }

  // 403 / nicht möglich: Kündigung NICHT verschlucken – Wunsch best effort ans Studio
  // spiegeln (Vorgang + E-Mail), dem Mitglied aber einen ehrlichen Hinweis geben.
  if (w.forbidden) {
    try { await Inbox.addVorgang(sess.id, { type: 'kuendigung', subject: 'Kündigung zurückziehen', priority: 'hoch',
      systemText: 'Du möchtest deine Kündigung zurückziehen.',
      teamText: 'Schön, dass du bleibst! Wir kümmern uns darum, deine Kündigung zurückzunehmen, und bestätigen dir das per E-Mail.' }); } catch (e) {}
    if (hasMail) {
      try {
        await sendMail('↩️ Kündigung zurückziehen (bitte manuell) – ' + who(m),
          'Ein Mitglied möchte seine Kündigung über den Mitgliederbereich zurückziehen.\n\n'
          + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m.customerNumber || '—')
          + (ct.rateName ? ('\nTarif: ' + ct.rateName) : '')
          + '\nGekündigt zum: ' + (ct.cancellationDate || ct.nextCancellationDate || '—')
          + '\nContractId: ' + (ct.contractId || '—')
          + '\n\nBitte die Kündigung in Magicline zurücknehmen/stornieren und dem Mitglied bestätigen.');
      } catch (e) {}
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: true, message: 'Das lässt sich hier gerade nicht zurücknehmen – bitte kurz im Studio melden.' }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: false, forbidden: false, message: 'Das hat gerade nicht geklappt – bitte versuch es später erneut oder melde dich kurz im Studio.' }));
};
