'use strict';

/**
 * POST /api/contract/create   (VERBINDLICHER Vertragsabschluss)
 * Body: { rateBundleTermId, startDate, paymentChoice, iban, accountHolder,
 *         firstname,lastname,email,phone,gender,dateOfBirth,
 *         street,houseNumber,zipCode,city, confirmedTextBlockIds[], referralCode, marketing }
 * Legt Kunde + Vertrag in Magicline an (POST /connect/v1/rate-bundle).
 * Bei referralCode wird der Werber verknüpft (member-gets-member).
 */

const C = require('../../lib/connect');
const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Connect-API liefert die Mitgliedsnummer je nach Version unter verschiedenen Keys.
function pickCustomerNumber(j) {
  if (!j) return null;
  return j.customerNumber || j[' customer member number'] || j['customer member number'] || null;
}
function fmtDateDE(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '.' + m[2] + '.' + m[1]) : (s || '');
}

// Eigene, gebrandete Willkommens-/Abschluss-Bestätigung ans Mitglied (best effort).
// Ergänzt die formellen Vertragsunterlagen (die separat aus Magicline kommen).
async function sendWelcomeMail(b, customerNumber) {
  if (!hasMail || !b.email) return;
  try {
    // Direkt-Anmelde-Link, sofern das neue Mitglied schon über die Open-API
    // auffindbar ist (sonst Fallback auf den normalen Link in memberLink()).
    let memberId = null;
    try { const found = await M.findByEmailDob(b.email, b.dateOfBirth); if (found) memberId = found.id; } catch (e) {}
    const portal = await memberLink(memberId, 'home');
    const panel = [];
    if (customerNumber) panel.push({ label: 'Mitgliedsnummer', value: customerNumber });
    if (b.startDate) panel.push({ label: 'Start', value: fmtDateDE(b.startDate) });
    panel.push({ label: 'Studio', value: 'Fit-Inn Trier · Auf Hirtenberg 8' });
    const em = renderEmail({
      preheader: 'Willkommen im Fit-Inn Trier – deine Mitgliedschaft ist abgeschlossen.',
      name: b.firstname || '',
      eyebrow: 'Willkommen',
      headline: 'Willkommen im Fit-Inn Trier!',
      intro: [
        'Schön, dass du dabei bist – deine Mitgliedschaft ist erfolgreich abgeschlossen. Ab sofort gehört der ganze Club dir.',
        'In deinem Mitgliederbereich kannst du dich jederzeit mit deiner Mitgliedsnummer und deinem Geburtsdatum anmelden, Termine buchen und deine Daten verwalten. Deine vollständigen Vertragsunterlagen erhältst du gesondert.',
      ],
      panel: panel,
      button: { label: 'Zum Mitgliederbereich', href: portal },
      promo: true,
      footer: 'member',
    });
    await sendMailRaw({ to: b.email, subject: 'Willkommen im Fit-Inn Trier!', text: em.text, html: em.html });
  } catch (e) { /* Bestätigungs-Mail ist optional */ }
}

const REQUIRED = ['rateBundleTermId', 'startDate', 'firstname', 'lastname', 'email', 'dateOfBirth', 'street', 'houseNumber', 'zipCode', 'city'];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const b = await readBody(req);

  for (const f of REQUIRED) {
    if (!b[f] || !String(b[f]).trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'missing_field', field: f, message: 'Bitte alle Pflichtfelder ausfüllen.' }));
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid_email', message: 'Bitte eine gültige E-Mail angeben.' }));
  }
  const pay = b.paymentChoice || 'DIRECT_DEBIT';
  if (pay === 'DIRECT_DEBIT' && !String(b.iban || '').replace(/\s+/g, '')) {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_iban', message: 'Bitte IBAN angeben.' }));
  }

  try {
    const r = await C.createContract(b);
    if (r.ok) {
      const customerNumber = pickCustomerNumber(r.json);
      await sendWelcomeMail(b, customerNumber);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        customerNumber: customerNumber,
        message: 'Willkommen im Fit-Inn Trier! Dein Vertrag ist abgeschlossen – du erhältst alle Unterlagen per E-Mail.',
      }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false,
      message: 'Der Abschluss hat nicht geklappt. Bitte Eingaben prüfen oder später erneut versuchen.',
      detail: String(r.text || '').slice(0, 400),
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten. Bitte später erneut.' }));
  }
};
