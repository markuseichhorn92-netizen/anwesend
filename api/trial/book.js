'use strict';

/**
 * POST /api/trial/book
 *   { firstname,lastname,email,phone,gender,dateOfBirth,
 *     street,houseNumber,zip,city, startDateTime, referralCode, marketing }
 * Bucht ein Probetraining + legt den Lead in Magicline an (Connect API).
 * Bei vorhandenem referralCode wird der Lead dem werbenden Mitglied zugeordnet.
 */

const crypto = require('node:crypto');
const C = require('../../lib/connect');
const M = require('../../lib/members');   // rateLimit (Missbrauchsschutz)
const Phone = require('../../lib/phoneApi');   // Rufnummer -> Kunde merken
const { redisPipeline, hasStore } = require('../../lib/store');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail, BASE } = require('../../lib/emailTemplate');

const TRIAL_TTL = 45 * 86400;   // Info-Seite 45 Tage abrufbar

// Buchung unter einem zufälligen Token ablegen -> Interessent kann seine
// Probetraining-Infos später über /probetraining-info?t=… wieder aufrufen.
// Best effort: ohne Store einfach kein Token (Mail/Bestätigung laufen weiter).
async function storeTrial(b) {
  if (!hasStore) return null;
  try {
    const token = crypto.randomBytes(16).toString('hex');
    const rec = { firstname: String(b.firstname || '').slice(0, 80), startDateTime: b.startDateTime || null, at: Date.now() };
    await redisPipeline([['SET', 'trial:' + token, JSON.stringify(rec), 'EX', String(TRIAL_TTL)]]);
    return token;
  } catch (e) { return null; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Termin (ISO) in deutsche Datums-/Uhrzeit-Darstellung (Zeitzone Berlin).
function fmtBerlin(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { date: '', time: '' };
    const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d);
    return { date, time };
  } catch (e) { return { date: '', time: '' }; }
}

// Eigene, gebrandete Probetraining-Bestätigung ans Interessenten-Postfach (best effort).
// infoUrl (optional): Link zur Info-Seite, auf der der Interessent seine Termindaten
// später wieder aufrufen kann.
async function sendTrialMail(b, infoUrl) {
  if (!hasMail || !b.email) return;
  try {
    const f = fmtBerlin(b.startDateTime);
    const panel = [];
    if (f.date) panel.push({ label: 'Termin', value: f.date });
    if (f.time) panel.push({ label: 'Uhrzeit', value: f.time + ' Uhr' });
    panel.push({ label: 'Adresse', value: 'Auf Hirtenberg 8 · 54296 Trier' });
    const em = renderEmail({
      preheader: 'Dein Probetraining ist gebucht.',
      name: b.firstname || '',
      eyebrow: 'Probetraining',
      headline: 'Dein Probetraining ist gebucht',
      intro: [
        'Wir freuen uns auf dich! Komm am besten ein paar Minuten früher – wir zeigen dir in Ruhe alles und beantworten alle deine Fragen.',
        'Bring einfach bequeme Sportkleidung und saubere Hallenschuhe mit. Solltest du den Termin doch nicht wahrnehmen können, gib uns kurz Bescheid.',
      ],
      panel: panel,
      button: infoUrl ? { label: 'Dein Probetraining ansehen', href: infoUrl } : { label: 'Mehr über uns', href: BASE },
      promo: true,
      footer: 'member',
    });
    await sendMailRaw({ to: b.email, subject: 'Dein Probetraining ist gebucht – Fit-Inn Trier', text: em.text, html: em.html });
  } catch (e) { /* Bestätigungs-Mail ist optional */ }
}

const REQUIRED = ['firstname', 'lastname', 'email', 'phone', 'gender', 'dateOfBirth', 'street', 'houseNumber', 'zip', 'city', 'startDateTime'];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Missbrauchsschutz: öffentlicher Buchungs-Endpunkt (legt Lead in Magicline an
  // + versendet Mail). IP-Drossel; ohne KV-Store no-op.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  if (!(await M.rateLimit('trial-book:' + ip, 10, 900))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anfragen. Bitte in ein paar Minuten erneut versuchen.' }));
  }

  const b = await readBody(req);
  for (const f of REQUIRED) {
    if (!b[f] || !String(b[f]).trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'missing_field', field: f, message: 'Bitte alle Pflichtfelder ausfüllen.' }));
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'invalid_email', message: 'Bitte eine gültige E-Mail-Adresse angeben.' }));
  }

  try {
    const r = await C.bookTrial(b);
    if (r.ok) {
      // Rufnummer -> Kunde merken, damit ein spaeterer Anruf („bitte absagen")
      // den Termin wiederfindet. Ein Probetraining legt einen LEAD an, und
      // Magiclines Kundensuche findet vor allem Mitglieder - hier kennen wir
      // die Zuordnung dagegen sicher. Best effort, nie buchungsrelevant.
      try {
        await Phone.rememberLead(b.phone, {
          customerId: Phone.customerIdFrom(r.json),
          customerNumber: Phone.customerNumberFrom(r.json),
        });
      } catch (e) { /* egal */ }
      const token = await storeTrial(b);
      const infoUrl = token ? (BASE + '/probetraining-info?t=' + token) : null;
      await sendTrialMail(b, infoUrl);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, token: token, infoUrl: infoUrl, message: 'Dein Probetraining ist gebucht! Du bekommst eine Bestätigung per E-Mail.' }));
    }
    // Häufigster Fall: Slot zwischenzeitlich vergeben / ungültig
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false,
      message: 'Buchung hat nicht geklappt – bitte einen anderen Termin wählen oder es später erneut versuchen.',
      detail: String(r.text || '').slice(0, 300),
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, message: 'Es ist ein Fehler aufgetreten. Bitte später erneut.' }));
  }
};
