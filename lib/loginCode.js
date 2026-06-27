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
    const text = 'Hallo' + (member.firstName ? ' ' + member.firstName : '') + ',\n\n'
      + 'dein Anmelde-Code für den Mitgliederbereich lautet:\n\n'
      + '   ' + code + '\n\n'
      + (link ? ('Oder melde dich mit einem Klick direkt an (10 Minuten gültig):\n' + link + '\n\n') : '')
      + 'Der Code ist 10 Minuten gültig. Wenn du dich nicht anmelden wolltest, ignoriere diese E-Mail einfach.\n\n'
      + 'Sportliche Grüße\nDein Fit-Inn Trier';
    await sendMailRaw({ to: member.email, subject: 'Dein Anmelde-Code: ' + code + ' – Fit-Inn Trier', text: text });
  }
  return { challenge: challenge };
}

module.exports = { sendLoginCode };
