'use strict';

/**
 * Gemeinsame Logik für den Login-Code: erzeugt einen 6-stelligen Code
 * (gehasht gespeichert) + einen Magic-Link-Token (10 Min), speichert beides in
 * Upstash und stellt ihn über den gewünschten Kanal zu (WhatsApp/E-Mail).
 *
 * ZUVERLÄSSIGKEIT:
 *  - Der Versand wird auf ECHTEN Erfolg geprüft (früher wurde „E-Mail" auch bei
 *    Fehlschlag als zugestellt gemeldet). channel bleibt null, wenn nichts rausging.
 *  - Cross-Fallback in BEIDE Richtungen: klappt der Wunschkanal nicht, wird
 *    automatisch der andere versucht (E-Mail ↔ WhatsApp).
 *  - Timeout + Retry stecken in lib/mail.js bzw. lib/whatsapp.js.
 *
 * Liefert { challenge, channel } – channel = tatsächlich genutzter Weg (oder null,
 * wenn die Zustellung auf keinem Weg gelang).
 */

const crypto = require('node:crypto');
const M = require('./members');
const WA = require('./whatsapp');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');

const TTL = 600; // 10 Minuten

// Handynummer zum Mitglied auflösen (die Magicline-Suche liefert oft keine Telefonfelder).
async function resolvePhone(member, opts) {
  let phone = (opts && opts.phone) || member.phonePrivate || member.phoneMobile || member.phoneBusiness || null;
  if (!phone && member.id != null) {
    try { const full = await M.getMember(member.id); if (full) phone = full.phonePrivate || full.phoneMobile || full.phoneBusiness || null; } catch (e) {}
  }
  return phone || null;
}

// WhatsApp-Zustellung – nur wenn Vorlage konfiguriert UND Nummer vorhanden. true = zugestellt.
async function tryWhatsApp(member, opts, code) {
  if (!WA.hasWaLogin) return false;
  const phone = await resolvePhone(member, opts);
  if (!phone) return false;
  try { const r = await WA.sendLoginTemplate(phone, code); return !!(r && r.ok); } catch (e) { return false; }
}

// E-Mail-Zustellung – nur wenn Mailer konfiguriert UND Adresse vorhanden. true = angenommen.
async function tryEmail(member, host, magic, code) {
  if (!hasMail || !member.email) return false;
  const link = host ? ('https://' + host + '/mitglieder?mlt=' + magic) : '';
  const mail = renderEmail({
    preheader: 'Dein Anmelde-Code: ' + code + ' (10 Minuten gültig)',
    name: member.firstName || '',
    eyebrow: 'Anmeldung',
    headline: link ? 'Melde dich mit einem Klick an' : 'Dein Anmelde-Code',
    intro: link
      ? 'Klicke auf den Button, um dich sofort und sicher in deinem Mitgliederbereich anzumelden. Der Link ist 10 Minuten gültig.'
      : 'Gib diesen Code im Mitgliederbereich ein, um dich anzumelden. Er ist 10 Minuten gültig.',
    button: link ? { label: 'Jetzt anmelden', href: link, full: true } : null,
    divider: link ? 'oder mit Code' : '',
    code: { label: 'Dein Anmelde-Code', value: code, spacing: 12, size: 36 },
    note: 'Du hast keine Anmeldung angefordert? Dann ignoriere diese E-Mail einfach – dein Konto bleibt sicher.',
    promo: true,
    referral: { code: member.referralCode, firstName: member.firstName },
    footer: 'security',
  });
  try {
    const r = await sendMailRaw({ to: member.email, subject: 'Dein Anmelde-Code: ' + code + ' – Fit-Inn Trier', text: mail.text, html: mail.html });
    return !!(r && r.ok);
  } catch (e) { return false; }
}

// opts.channel ('whatsapp'|'email'): bevorzugter Zustellweg. Klappt er nicht, wird der
// andere automatisch versucht. Liefert { challenge, channel } (channel=null => nichts zugestellt).
async function sendLoginCode(member, host, opts) {
  opts = opts || {};
  const code = String(crypto.randomInt(100000, 1000000));
  const challenge = crypto.randomBytes(24).toString('hex');
  const magic = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + TTL * 1000;

  await M.otpSave(challenge, { id: member.id, codeHash: M.hashCode(code), exp: exp, tries: 0 }, TTL);
  await M.mlinkSave(magic, { id: member.id, exp: exp }, TTL);

  const preferWa = opts.channel === 'whatsapp';
  let channel = null;

  if (preferWa) {
    if (await tryWhatsApp(member, opts, code)) channel = 'whatsapp';
    else if (await tryEmail(member, host, magic, code)) channel = 'email';   // Fallback E-Mail
  } else {
    if (await tryEmail(member, host, magic, code)) channel = 'email';
    else if (await tryWhatsApp(member, opts, code)) channel = 'whatsapp';     // Fallback WhatsApp
  }

  return { challenge: challenge, channel: channel };
}

module.exports = { sendLoginCode };
