'use strict';

/**
 * Twilio WhatsApp Inbound-Webhook.
 *   POST (application/x-www-form-urlencoded) -> eingehende Nachricht ins Postfach.
 *
 * Twilio ruft diese URL bei jeder eingehenden WhatsApp-Nachricht auf. Die Nummer
 * ordnet das Mitglied zu (M.findByPhone), die Nachricht hängt an einen WhatsApp-
 * Vorgang (channel:'whatsapp'); Studio-Antworten gehen über lib/whatsapp.sendText
 * automatisch per Twilio zurück. Ohne Zuordnung -> Hinweis-Mail ans Studio.
 *
 * Signaturprüfung: X-Twilio-Signature (lib/whatsapp.verifyTwilioSignature).
 * Antwortet mit leerem TwiML (keine automatische Antwort), Status 200.
 */

const M = require('../lib/members');
const Inbox = require('../lib/inbox');
const SR = require('../lib/studioReply');
const WA = require('../lib/whatsapp');
const { sendMail, hasMail } = require('../lib/mail');

function readRaw(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
function parseForm(raw) {
  const o = {};
  try { new URLSearchParams(raw || '').forEach((v, k) => { o[k] = v; }); } catch (e) {}
  return o;
}

async function findOrCreateWaVorgang(member, fromPhone, name) {
  let list = [];
  try { list = await Inbox.list(member.id); } catch (e) {}
  const open = (list || []).find((v) => v.channel === 'whatsapp' && v.status !== 'abgeschlossen');
  if (open) return open;
  return Inbox.addVorgang(member.id, {
    type: 'whatsapp', channel: 'whatsapp', phone: fromPhone,
    subject: 'WhatsApp' + (name ? (' · ' + name) : ''),
    systemText: 'WhatsApp-Konversation' + (name ? (' mit ' + name) : '') + ' gestartet.',
  });
}

module.exports = async function handler(req, res) {
  // Health/GET: nur ok. Twilio nutzt immer POST.
  if (req.method !== 'POST') { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end('ok'); }

  const raw = await readRaw(req);
  const params = parseForm(raw);

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  const fullUrl = process.env.TWILIO_WEBHOOK_URL || (proto + '://' + host + req.url);
  if (!WA.verifyTwilioSignature(fullUrl, params, req.headers['x-twilio-signature'])) {
    res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); return res.end('bad_signature');
  }

  const msgs = WA.parseTwilioInbound(params);
  let handled = 0, unmatched = 0;
  for (const msg of msgs) {
    try {
      const member = await M.findByPhone(msg.from);
      if (member && member.id != null) {
        const v = await findOrCreateWaVorgang(member, msg.from, msg.name);
        if (v) { await SR.applyMemberReply(member.id, v.id, msg.text); handled++; }
      } else {
        unmatched++;
        if (hasMail) {
          try {
            await sendMail('💬 WhatsApp (nicht zugeordnet) – ' + (msg.name || ('+' + msg.from)),
              'Eine WhatsApp-Nachricht (Twilio) konnte keinem Mitglied zugeordnet werden.\n\n'
              + 'Von: ' + (msg.name ? (msg.name + ' · ') : '') + '+' + msg.from
              + '\n\nNachricht:\n' + msg.text
              + '\n\nBitte manuell zuordnen/antworten.');
          } catch (e) {}
        }
      }
    } catch (e) { /* einzelne Nachricht darf den Lauf nicht abbrechen */ }
  }

  res.statusCode = 200; res.setHeader('Content-Type', 'text/xml');
  return res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
};
