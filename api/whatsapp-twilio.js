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

function initialsOf(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  return ((p[0][0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '')).toUpperCase();
}

// Laufenden WhatsApp-Vorgang wiederverwenden, sonst neu anlegen. memberId ist die
// echte Magicline-ID ODER eine Pseudo-ID "wa<phone>" für Nicht-Mitglieder (Interessenten).
async function findOrCreateWaVorgang(memberId, fromPhone, name, snapshot) {
  let list = [];
  try { list = await Inbox.list(memberId); } catch (e) {}
  const open = (list || []).find((v) => v.channel === 'whatsapp' && v.status !== 'abgeschlossen');
  if (open) return open;
  return Inbox.addVorgang(memberId, {
    type: 'whatsapp', channel: 'whatsapp', phone: fromPhone, member: snapshot || undefined,
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
  let handled = 0, leads = 0;
  for (const msg of msgs) {
    try {
      const member = await M.findByPhone(msg.from);
      let memberId, snapshot;
      if (member && member.id != null) {
        memberId = String(member.id);
        const nm = ((member.firstName || '') + ' ' + (member.lastName || '')).trim();
        snapshot = { name: nm || ('+' + msg.from), nr: member.customerNumber || null,
          initials: initialsOf(nm) || initialsOf(msg.name) || 'WA', email: member.email || null, phone: msg.from };
      } else {
        // Nicht-Mitglied (Interessent/Probetraining): Pseudo-ID -> landet trotzdem im Posteingang.
        memberId = 'wa' + msg.from;
        snapshot = { name: msg.name || ('+' + msg.from), nr: null, initials: initialsOf(msg.name) || 'WA', phone: msg.from, lead: true };
        leads++;
      }
      const v = await findOrCreateWaVorgang(memberId, msg.from, msg.name, snapshot);
      if (v) { await SR.applyMemberReply(memberId, v.id, msg.text); handled++; }
    } catch (e) { /* einzelne Nachricht darf den Lauf nicht abbrechen */ }
  }

  res.statusCode = 200; res.setHeader('Content-Type', 'text/xml');
  return res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
};
