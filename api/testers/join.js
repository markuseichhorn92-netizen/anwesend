'use strict';

/**
 * POST /api/testers/join   { email, name?, consent }
 * Anmeldung für den GESCHLOSSENEN App-Test (Google Play).
 *
 * ABLAUF (zweistufig – der Beitritts-Link funktioniert erst NACH der Freischaltung):
 *  1) Hier: Adresse mit Status "pending" speichern, Studio informieren, dem Tester
 *     eine Bestätigung OHNE Link schicken („wir schalten dich frei und melden uns").
 *  2) Später im Team-Backend („App-Tester"): das Studio trägt die Adresse in der
 *     Play Console ein und tippt auf „Freischalten" -> Status "approved" + zweite
 *     Mail MIT Beitritts-Link (siehe lib/testers.js / api/team/testers.js).
 *
 * Datenschutz/Robustheit: Antwort immer gleich (ok:true). Rate-Limit pro IP + E-Mail.
 * Speicher-/Mail-Fehler werden geschluckt.
 */

const M = require('../../lib/members');
const Testers = require('../../lib/testers');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');

// Bewusst simpel: ein @, ein Punkt danach, keine Leerzeichen. Reicht als Vorfilter.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(s, max) { return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 120); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await M.rateLimit('tester:ip:' + ip, 12, 3600))) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); }

  const d = await M.readBody(req);
  const email = String(d.email || '').trim().toLowerCase();
  const name = clean(d.name, 80);
  const consent = d.consent === true || d.consent === 'true' || d.consent === 1 || d.consent === '1';

  if (!EMAIL_RE.test(email) || email.length > 160) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid_email' })); }
  if (!consent) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'consent_required' })); }

  // Pro E-Mail begrenzen (verhindert Wiederholungs-Spam an dieselbe Adresse).
  await M.rateLimit('tester:e:' + email, 5, 86400);

  let firstTime = true;
  try { const r = await Testers.recordSignup(email, name); firstTime = !r || r.firstTime !== false; }
  catch (e) { /* Speicher-Fehler nicht nach außen zeigen */ }

  // Studio benachrichtigen – nur bei NEUER Anmeldung (keine Doppel-Mails).
  try {
    if (hasMail && firstTime) {
      const host = req.headers['host'] || 'mitglieder.fit-inn-trier.de';
      await sendMail(
        'Neuer App-Tester (freischalten): ' + email,
        'Neue Anmeldung für den geschlossenen App-Test.\n\n' +
          'Name: ' + (name || '—') + '\n' +
          'E-Mail (Google/Gmail): ' + email + '\n\n' +
          'So schaltest du frei:\n' +
          '1) Adresse in der Play Console eintragen: Testen → Geschlossener Test → Tester → E-Mail-Liste.\n' +
          '2) Dann im Team-Backend unter „App-Tester" auf „Freischalten" tippen – der Tester bekommt\n' +
          '   automatisch die zweite E-Mail mit dem Beitritts-Link.\n\n' +
          'App-Tester öffnen: https://' + host + '/team/tester',
        null,
      );
    }
  } catch (e) {}

  // Bestätigung an den Tester – OHNE Link (kommt erst nach der Freischaltung).
  try {
    if (hasMail && firstTime) {
      const mail = renderEmail({
        preheader: 'Danke für deine Anmeldung zum Test der Fit-Inn-App.',
        name: name || '',
        eyebrow: 'App-Test',
        headline: 'Danke – du stehst auf der Liste!',
        intro: [
          'Danke, dass du die neue Fit-Inn-App vorab testen möchtest!',
          'Wir schalten dich in Kürze frei. Sobald der Test für dich bereit ist, bekommst du von uns eine zweite E-Mail mit dem Beitritts-Link und der Anleitung. Das dauert meist 1–2 Tage – du musst jetzt nichts weiter tun.',
        ],
        note: 'Wichtig: Nutze später auf dem Handy dieselbe Google-Adresse (' + email + '), mit der du dich hier angemeldet hast – sonst blendet Google den Test nicht ein.',
        footer: 'security',
      });
      await sendMailRaw({ to: email, subject: 'Deine Anmeldung zum Fit-Inn-App-Test', text: mail.text, html: mail.html });
    }
  } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, status: 'pending' }));
};
