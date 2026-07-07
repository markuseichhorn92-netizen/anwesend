'use strict';

/**
 * Zugangs-/Willkommens-Mail ans Mitglied – gemeinsamer Baustein.
 * ------------------------------------------------------------
 * Wird sowohl vom Team-Button (api/team/access-info.js, manuell) als auch vom
 * Magicline-Webhook (api/webhooks/magicline.js, automatisch bei CONTRACT_CREATED)
 * genutzt. Enthält Mitgliedsnummer, Anmelde-Hinweis und den Direkt-Link.
 *
 * Wirft nie. sendAccessInfoMail() sendet immer; sendAccessInfoOnce() sendet mit
 * Dedup (verhindert Doppelversand bei mehreren Events/Retries).
 */

const M = require('./members');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');
const { memberLink } = require('./magic');
const { redisPipeline, hasStore } = require('./store');

function maskEmail(e) { return String(e || '').replace(/(.).*(@.*)/, '$1***$2'); }

// Baut + sendet die Zugangs-Mail an ein Mitglied (per Magicline-Kunden-ID).
// -> { ok, sent, email, reason }. Wirft nie.
async function sendAccessInfoMail(id) {
  if (!hasMail) return { ok: false, sent: false, reason: 'no_mail' };
  let m; try { m = await M.getMember(id); } catch (e) { m = null; }
  if (!m) return { ok: false, sent: false, reason: 'not_found' };
  const p = M.publicProfile(m) || {};
  const email = p.email && String(p.email).trim();
  if (!email) return { ok: false, sent: false, reason: 'no_email' };

  const portal = await memberLink(String(id), 'home');
  const first = String(p.firstName || '').trim();
  const panel = [];
  if (p.customerNumber) panel.push({ label: 'Mitgliedsnummer', value: String(p.customerNumber) });
  panel.push({ label: 'Anmeldung', value: 'Mitgliedsnummer + Geburtsdatum' });
  panel.push({ label: 'Studio', value: 'Fit-Inn Trier · Auf Hirtenberg 8' });

  const em = renderEmail({
    preheader: 'So kommst du in deinen Mitgliederbereich.',
    name: first,
    eyebrow: 'Dein Zugang',
    headline: 'Willkommen – dein Mitgliederbereich',
    intro: [
      'Schön, dass du dabei bist! In deinem Mitgliederbereich kannst du Termine buchen, deine Daten verwalten, dein Training verfolgen und uns direkt schreiben.',
      'Melde dich einfach mit deiner Mitgliedsnummer und deinem Geburtsdatum an – fertig. Deine vollständigen Vertragsunterlagen erhältst du gesondert.',
    ],
    panel: panel,
    button: { label: 'Zum Mitgliederbereich', href: portal },
    promo: true,
    footer: 'member',
  });

  let sent = false;
  try { const r = await sendMailRaw({ to: email, subject: 'Dein Zugang zum Fit-Inn Mitgliederbereich', text: em.text, html: em.html }); sent = !!(r && r.ok); } catch (e) {}
  return { ok: sent, sent: sent, email: maskEmail(email), reason: sent ? null : 'send_failed' };
}

// Wie oben, aber nur EINMAL je Mitglied (Dedup-Flag im Store). Verhindert, dass
// z. B. wiederholte Webhook-Zustellungen mehrere Willkommens-Mails auslösen.
// Schlägt der Versand fehl, wird das Flag wieder freigegeben (Retry bleibt möglich).
async function sendAccessInfoOnce(id, ttlSec) {
  const key = 'welcomed:' + String(id);
  const ttl = ttlSec || (90 * 86400);
  if (hasStore) {
    try {
      const [setRes] = await redisPipeline([['SET', key, String(Date.now()), 'NX', 'EX', String(ttl)]]);
      if (setRes == null) return { ok: false, sent: false, reason: 'already_sent' };
    } catch (e) { /* ohne Dedup weitermachen */ }
  }
  const r = await sendAccessInfoMail(id);
  if (!r.sent && hasStore) { try { await redisPipeline([['DEL', key]]); } catch (e) {} }
  return r;
}

module.exports = { sendAccessInfoMail, sendAccessInfoOnce, maskEmail };
