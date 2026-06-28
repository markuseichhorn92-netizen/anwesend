'use strict';

/**
 * Gemeinsame Logik für den E-Mail-Login-Code: erzeugt einen 6-stelligen Code
 * (gehasht gespeichert) + einen Magic-Link-Token (10 Min), speichert beides in
 * Upstash und verschickt die E-Mail mit Code UND direktem Anmelde-Link.
 * Liefert das challenge-Token für die anschließende Code-Eingabe zurück.
 */

const crypto = require('node:crypto');
const M = require('./members');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');

const TTL = 600; // 10 Minuten

async function sendLoginCode(member, host) {
  const code = String(crypto.randomInt(100000, 1000000));
  const challenge = crypto.randomBytes(24).toString('hex');
  const magic = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + TTL * 1000;

  await M.otpSave(challenge, { id: member.id, codeHash: M.hashCode(code), exp: exp, tries: 0 }, TTL);
  await M.mlinkSave(magic, { id: member.id, exp: exp }, TTL);

  const link = host ? ('https://' + host + '/mitglieder?mlt=' + magic) : '';
  if (hasMail && member.email) {
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
      footer: 'security',
    });
    await sendMailRaw({ to: member.email, subject: 'Dein Anmelde-Code: ' + code + ' – Fit-Inn Trier', text: mail.text, html: mail.html });
  }
  return { challenge: challenge };
}

module.exports = { sendLoginCode };
