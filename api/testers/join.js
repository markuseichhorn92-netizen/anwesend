'use strict';

/**
 * POST /api/testers/join   { email, name?, consent }
 * Anmeldung für den GESCHLOSSENEN App-Test (Google Play / optional iOS-TestFlight).
 *
 * Zweck: die (Google-/Gmail-)Adresse des Testers einsammeln, damit das Studio sie
 * in der Play Console als Tester freischalten kann. Beim geschlossenen Test zeigt
 * Google die App NUR Konten, die vorher als Tester hinterlegt wurden – deshalb
 * braucht es genau diese E-Mail.
 *
 * Ablauf:
 *  - E-Mail validieren, Einwilligung verlangen, pro IP + pro E-Mail rate-limiten.
 *  - Adresse in einem Redis-Set (Dedup) + Info-Hash (Name/Zeit) ablegen.
 *  - Studio per Mail informieren (nur bei NEUER Anmeldung).
 *  - Tester eine Bestätigung mit dem Beitritts-Link schicken (falls konfiguriert).
 *
 * Datenschutz/Robustheit: Antwort ist immer gleich (ok:true) – nach außen ist nicht
 * erkennbar, ob die Adresse neu war. Speicher-/Mail-Fehler werden geschluckt.
 *
 * Konfiguration (Vercel-Env, alle optional):
 *   PLAY_TEST_OPTIN_URL  – Beitritts-Link aus der Play Console (Tester werden)
 *   PLAY_TEST_STORE_URL  – Play-Store-Link der App (nach dem Beitritt installieren)
 *   IOS_TEST_URL         – TestFlight-Einladungslink (optional, iOS)
 */

const M = require('../../lib/members');
const { redisPipeline, hasStore } = require('../../lib/store');
const { sendMail, sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');

const OPTIN_URL = String(process.env.PLAY_TEST_OPTIN_URL || '').trim();
const STORE_URL = String(process.env.PLAY_TEST_STORE_URL || '').trim();
const IOS_URL = String(process.env.IOS_TEST_URL || '').trim();

// Bewusst simpel: ein @, ein Punkt danach, keine Leerzeichen. Reicht als Vorfilter;
// die endgültige Gültigkeit klärt sich ohnehin erst beim Freischalten in Play.
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

  const links = { optInUrl: OPTIN_URL || null, storeUrl: STORE_URL || null, iosUrl: IOS_URL || null };

  if (!EMAIL_RE.test(email) || email.length > 160) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid_email' })); }
  if (!consent) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'consent_required' })); }

  // Pro E-Mail begrenzen (verhindert Wiederholungs-Spam an dieselbe Adresse).
  await M.rateLimit('tester:e:' + email, 5, 86400);

  let firstTime = true;
  try {
    if (hasStore) {
      const rec = JSON.stringify({ name: name || null, joinedAt: new Date().toISOString() });
      const [added] = await redisPipeline([['SADD', 'tester:emails', email]]);
      firstTime = Number(added) === 1;                 // 1 = war neu, 0 = schon dabei
      await redisPipeline([['HSET', 'tester:info', email, rec]]);
    }
  } catch (e) { /* Speicher-Fehler nicht nach außen zeigen */ }

  // Studio benachrichtigen – nur bei NEUER Anmeldung (keine Doppel-Mails).
  try {
    if (hasMail && firstTime) {
      await sendMail(
        'Neuer App-Tester: ' + email,
        'Neue Anmeldung für den geschlossenen App-Test.\n\n' +
          'Name: ' + (name || '—') + '\n' +
          'E-Mail (Google/Gmail): ' + email + '\n\n' +
          'Bitte diese Adresse in der Play Console freischalten:\n' +
          'Testen → Geschlossener Test → Tester → E-Mail-Liste.\n' +
          'Die komplette Liste gibt es als CSV unter /api/testers/list (Bearer-Token).',
        null,
      );
    }
  } catch (e) {}

  // Bestätigung an den Tester – mit Beitritts-Link, falls konfiguriert.
  try {
    if (hasMail) {
      const steps = [];
      if (links.optInUrl) steps.push('1. Öffne auf deinem Android-Handy den Button „Tester werden" und bestätige die Teilnahme.');
      if (links.storeUrl) steps.push((steps.length ? '2.' : '1.') + ' Installiere die App anschließend über Google Play – fertig!');
      const intro = links.optInUrl
        ? ['Danke, dass du die neue Fit-Inn-App vorab testest! In wenigen Schritten bist du dabei:'].concat(steps)
        : ['Danke für deine Anmeldung zum App-Test! Wir schalten dich in Kürze frei und schicken dir dann den Beitritts-Link. Du kannst diese E-Mail einfach aufbewahren.'];
      const mail = renderEmail({
        preheader: 'Danke – so kommst du in den Test der Fit-Inn-App.',
        name: name || '',
        eyebrow: 'App-Test',
        headline: 'Willkommen im Tester-Kreis',
        intro: intro,
        button: links.optInUrl ? { label: 'Tester werden', href: links.optInUrl, full: true } : null,
        secondary: links.storeUrl ? { label: 'App bei Google Play öffnen', href: links.storeUrl } : null,
        note: 'Wichtig: Nutze auf dem Handy dieselbe Google-Adresse (' + email + '), mit der du dich hier angemeldet hast – sonst blendet Google den Test nicht ein.',
        footer: 'security',
      });
      await sendMailRaw({ to: email, subject: 'Du bist dabei: Test der Fit-Inn-App', text: mail.text, html: mail.html });
    }
  } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, links: links }));
};
