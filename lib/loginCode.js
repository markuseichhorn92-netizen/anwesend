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
const { redisPipeline, hasStore } = require('./store');

const TTL = 600; // 10 Minuten

// ── Wie lange dauert ein Login-Code wirklich? ──────────────────────────────
// "Der Code kommt spaet" hat zwei ganz verschiedene Ursachen, und ohne Messung
// raet man: entweder braucht UNSER Aufruf lange, bis der Anbieter die Nachricht
// annimmt - oder der Anbieter nimmt sie sofort an und stellt sie spaet zu.
// Das eine koennen wir aendern, das andere nicht. Also beides getrennt messen.
//
// Gemessen werden nur Zeiten und die Nachrichten-ID des Anbieters. Keine
// Rufnummer, keine Adresse, kein Code - das gehoert nicht in Logs.
const MESS_TTL = 3600;
const messKey = (id) => 'otpwa:' + id;

// Dieselben Angaben zusaetzlich als kurze Liste ablegen. Logs sind nur fuer
// jemanden lesbar, der an die Vercel-Konsole kommt - der Grund fuer "es kommt
// kein Code an" muss aber im Team-Backend stehen, sonst raet man weiter.
// Es landen ausschliesslich Zeiten, Kanal und der (schon bereinigte) Grund
// darin: keine Rufnummer, keine Adresse, kein Code.
const LETZTE_KEY = 'otplast';
const LETZTE_N = 20;
const LETZTE_TTL = 14 * 24 * 3600;

function messLog(art, feld) {
  try { console.log('otp_' + art, JSON.stringify(feld)); } catch (e) {}
}

async function messMerken(feld) {
  if (!hasStore) return;
  try {
    await redisPipeline([
      ['LPUSH', LETZTE_KEY, JSON.stringify(Object.assign({ t: Date.now() }, feld))],
      ['LTRIM', LETZTE_KEY, '0', String(LETZTE_N - 1)],
      ['EXPIRE', LETZTE_KEY, String(LETZTE_TTL)],
    ]);
  } catch (e) {}
}

// Die letzten Versuche, juengster zuerst. Wirft nie.
async function letzteMessungen(n) {
  if (!hasStore) return [];
  const bis = Math.max(1, Math.min(LETZTE_N, Number(n) || LETZTE_N)) - 1;
  let roh;
  try { [roh] = await redisPipeline([['LRANGE', LETZTE_KEY, '0', String(bis)]]); } catch (e) { return []; }
  if (!Array.isArray(roh)) return [];
  return roh.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

// Die Uebergabe an den Anbieter: das ist unsere Zeit.
// Bei einem Fehlschlag gehoert der GRUND dazu. Ohne ihn stand hier nur
// `ok:false`, und der Login wich still auf E-Mail aus - man sah nie, dass und
// warum WhatsApp abgelehnt hatte. Der Grund ist vom Anbieter bereits von
// Rufnummer, Adresse und Code befreit (WA.fehlerInfo).
async function messUebergabe(kanal, ms, ok, id, grund) {
  const feld = { via: kanal, ms: ms, ok: !!ok };
  if (!ok && grund) {
    if (grund.code) feld.code = grund.code;
    if (grund.status) feld.status = grund.status;
    if (grund.text) feld.grund = grund.text;
  }
  messLog('handover', feld);
  await messMerken(feld);
  if (!ok || !id || !hasStore) return;
  try {
    await redisPipeline([['SET', messKey(id), JSON.stringify({ t: Date.now(), via: kanal, api: ms }), 'EX', String(MESS_TTL)]]);
  } catch (e) {}
}

// Vom Webhook aufgerufen, sobald der Anbieter einen Zustellstatus meldet.
// Liefert die Sekunden seit der Uebergabe - oder null, wenn die Nachricht
// keiner von uns verschickte Login-Code war.
async function noteDelivery(messageId, status) {
  if (!messageId || !hasStore) return null;
  let raw;
  try { [raw] = await redisPipeline([['GET', messKey(messageId)]]); } catch (e) { return null; }
  if (!raw) return null;
  let rec = null; try { rec = JSON.parse(raw); } catch (e) { return null; }
  if (!rec || !rec.t) return null;
  const sek = Math.round((Date.now() - rec.t) / 100) / 10;
  const feld = { via: rec.via, status: String(status || ''), sekunden: sek, api_ms: rec.api };
  messLog('delivery', feld);
  await messMerken(Object.assign({ art: 'zustellung' }, feld));
  return sek;
}

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
  // Auch die stillen Abbrueche gehoeren ins Log: sonst sieht man bei "kein Code
  // per WhatsApp" ueberhaupt keine Zeile und sucht beim Anbieter statt bei uns.
  if (!WA.hasWaLogin) { await messUebergabe('whatsapp', 0, false, null, { text: 'keine Vorlage konfiguriert' }); return false; }
  const phone = await resolvePhone(member, opts);
  if (!phone) { await messUebergabe('whatsapp', 0, false, null, { text: 'keine Rufnummer am Konto' }); return false; }
  const t0 = Date.now();
  try {
    const r = await WA.sendLoginTemplate(phone, code);
    const ok = !!(r && r.ok);
    await messUebergabe('whatsapp', Date.now() - t0, ok, r && r.id, ok ? null : WA.fehlerInfo(r));
    return ok;
  } catch (e) {
    await messUebergabe('whatsapp', Date.now() - t0, false, null, { text: String((e && e.message) || 'Aufruf fehlgeschlagen').slice(0, 160) });
    return false;
  }
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
  const t0 = Date.now();
  try {
    const r = await sendMailRaw({ to: member.email, subject: 'Dein Anmelde-Code: ' + code + ' – Fit-Inn Trier', text: mail.text, html: mail.html });
    const ok = !!(r && r.ok);
    await messUebergabe('email', Date.now() - t0, ok, null);
    return ok;
  } catch (e) {
    await messUebergabe('email', Date.now() - t0, false, null);
    return false;
  }
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

module.exports = { sendLoginCode, noteDelivery, letzteMessungen };
