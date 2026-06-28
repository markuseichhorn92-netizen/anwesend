'use strict';

/**
 * TEMPORÄRER Test-Endpunkt – nur zum Vorschau-Versand der neuen
 * Bestätigungsmails (Probetraining + Willkommen). Wird nach dem Test wieder
 * entfernt. Empfänger wird zur Laufzeit per ?to= übergeben (steht NICHT im Repo),
 * Zugriff per Token ?t= geschützt.
 */

const { sendMailRaw, hasMail } = require('../lib/mail');
const { renderEmail, BASE } = require('../lib/emailTemplate');

const TOKEN = '1e7018fc47ccc37c598c0913aedad044d4a3';

function fmtBerlin(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { date: '', time: '' };
    const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d);
    return { date, time };
  } catch (e) { return { date: '', time: '' }; }
}
function fmtDateDE(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '.' + m[2] + '.' + m[1]) : (s || '');
}

// 1:1 dieselben renderEmail-Optionen wie api/trial/book.js -> sendTrialMail
function trialMail() {
  const f = fmtBerlin('2026-07-03T07:30:00.000Z');
  const panel = [];
  if (f.date) panel.push({ label: 'Termin', value: f.date });
  if (f.time) panel.push({ label: 'Uhrzeit', value: f.time + ' Uhr' });
  panel.push({ label: 'Adresse', value: 'Auf Hirtenberg 8 · 54296 Trier' });
  return {
    subject: 'Dein Probetraining ist gebucht – Fit-Inn Trier',
    ...renderEmail({
      preheader: 'Dein Probetraining ist gebucht.',
      name: 'Markus',
      eyebrow: 'Probetraining',
      headline: 'Dein Probetraining ist gebucht',
      intro: [
        'Wir freuen uns auf dich! Komm am besten ein paar Minuten früher – wir zeigen dir in Ruhe alles und beantworten alle deine Fragen.',
        'Bring einfach bequeme Sportkleidung und saubere Hallenschuhe mit. Solltest du den Termin doch nicht wahrnehmen können, gib uns kurz Bescheid.',
      ],
      panel: panel,
      button: { label: 'Mehr über uns', href: BASE },
      promo: true,
      footer: 'member',
    }),
  };
}

// 1:1 dieselben renderEmail-Optionen wie api/contract/create.js -> sendWelcomeMail
function welcomeMail() {
  const panel = [];
  panel.push({ label: 'Mitgliedsnummer', value: 'M-1177' });
  panel.push({ label: 'Start', value: fmtDateDE('2026-08-01') });
  panel.push({ label: 'Studio', value: 'Fit-Inn Trier · Auf Hirtenberg 8' });
  return {
    subject: 'Willkommen im Fit-Inn Trier!',
    ...renderEmail({
      preheader: 'Willkommen im Fit-Inn Trier – deine Mitgliedschaft ist abgeschlossen.',
      name: 'Markus',
      eyebrow: 'Willkommen',
      headline: 'Willkommen im Fit-Inn Trier!',
      intro: [
        'Schön, dass du dabei bist – deine Mitgliedschaft ist erfolgreich abgeschlossen. Ab sofort gehört der ganze Club dir.',
        'In deinem Mitgliederbereich kannst du dich jederzeit mit deiner Mitgliedsnummer und deinem Geburtsdatum anmelden, Termine buchen und deine Daten verwalten. Deine vollständigen Vertragsunterlagen erhältst du gesondert.',
      ],
      panel: panel,
      button: { label: 'Zum Mitgliederbereich', href: BASE + '/mitglieder' },
      promo: true,
      footer: 'member',
    }),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('t') !== TOKEN) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }
  const to = url.searchParams.get('to');
  if (!to) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_to' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_mail_key' })); }

  const mails = [['probetraining', trialMail()], ['willkommen', welcomeMail()]];
  const results = [];
  for (const [name, m] of mails) {
    const r = await sendMailRaw({ to: to, subject: m.subject, text: m.text, html: m.html });
    results.push({ name: name, ok: !!r.ok, status: r.status || null, body: r.body || r.error || null });
  }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: results.every((x) => x.ok), results: results }));
};
