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
const LF = require('../lib/leadflow');
const AI = require('../lib/ai');
const WAAssistant = require('../lib/waAssistant');

// WhatsApp-KI (siehe api/whatsapp-webhook.js): per Flag, standardmäßig AUS,
// fail-closed. Gleiche zentrale Behandlung wie beim Meta-Webhook.
const WA_ASSISTANT = process.env.WA_ASSISTANT === '1';

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

// Offenen WhatsApp-Vorgang des (Pseudo-)Mitglieds finden – memberId ist die echte
// Magicline-ID ODER eine Pseudo-ID "wa<phone>" für Nicht-Mitglieder (Interessenten).
async function findOpenWaVorgang(memberId) {
  let list = [];
  try { list = await Inbox.list(memberId); } catch (e) {}
  return (list || []).find((v) => v.channel === 'whatsapp' && v.status !== 'abgeschlossen') || null;
}
function createWaVorgang(memberId, fromPhone, name, snapshot) {
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

  // Status-Callback (kein Body, aber MessageStatus/SmsStatus) -> Zustell-/Lesestatus setzen.
  const twStatus = params.MessageStatus || params.SmsStatus;
  if (twStatus && !params.Body) {
    try { const Receipts = require('../lib/receipts'); await Receipts.applyStatus(params.MessageSid || params.SmsSid, twStatus); } catch (e) {}
    res.statusCode = 200; res.setHeader('Content-Type', 'text/xml');
    return res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  const msgs = WA.parseTwilioInbound(params);
  let handled = 0, leads = 0;
  for (const msg of msgs) {
    try {
      let memberId, snapshot, isLead = false;
      // 1) Gemerkte Zuordnung (Nummer -> Kunde) hat Vorrang -> kein neues Ticket bei bekannter Nummer.
      const linked = await LF.resolveKnownLead(msg.from);
      if (linked && linked.id) {
        memberId = String(linked.id);
        snapshot = { name: linked.name || ('+' + msg.from), nr: linked.nr || null, initials: initialsOf(linked.name) || 'WA', phone: msg.from };
      } else {
        const member = await M.findByPhone(msg.from);
        if (member && member.id != null) {
          memberId = String(member.id);
          const nm = ((member.firstName || '') + ' ' + (member.lastName || '')).trim();
          snapshot = { name: nm || ('+' + msg.from), nr: member.customerNumber || null,
            initials: initialsOf(nm) || initialsOf(msg.name) || 'WA', email: member.email || null, phone: msg.from };
        } else {
          // Neuer Interessent (Probetraining usw.): Pseudo-ID -> landet im Posteingang.
          isLead = true; memberId = 'wa' + msg.from;
          snapshot = { name: msg.name || ('+' + msg.from), nr: null, initials: initialsOf(msg.name) || 'WA', phone: msg.from, lead: true };
          leads++;
        }
      }
      const open = await findOpenWaVorgang(memberId);
      const firstContact = !open;
      const v = open || await createWaVorgang(memberId, msg.from, msg.name, snapshot);
      if (!v) continue;
      await SR.applyMemberReply(memberId, v.id, msg.text); handled++;
      // Diagnose (ohne Personenbezug): Mitglied erkannt? WhatsApp-KI scharf? (Provider: twilio)
      WAAssistant.waLog('inbound', {
        provider: 'twilio', known: !isLead, via: isLead ? 'lead' : (linked && linked.id ? 'linked' : 'phone'),
        gate: !!(WA_ASSISTANT && AI.hasAI && WA.hasWhatsApp), flag: WA_ASSISTANT, ai: !!AI.hasAI, wa: !!WA.hasWhatsApp,
      });
      if (isLead) {
        const fresh = await Inbox.get(memberId, v.id);
        await LF.onLeadMessage({ memberId: memberId, vorgang: fresh || v, phone: msg.from, profileName: msg.name, firstContact: firstContact });
      } else if (WA_ASSISTANT && AI.hasAI && WA.hasWhatsApp) {
        // Bekanntes Mitglied: WhatsApp-KI (verifiziert antworten / sonst Bestätigungs-Link).
        try { await WAAssistant.handleInbound({ req: req, memberId: memberId, msg: msg, vorgang: v }); } catch (e) { WAAssistant.waLog('error', { name: String(e && e.name) }); }
      }
    } catch (e) { WAAssistant.waLog('loop_error', { name: String(e && e.name) }); }
  }

  res.statusCode = 200; res.setHeader('Content-Type', 'text/xml');
  return res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
};
