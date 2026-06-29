'use strict';

/**
 * WhatsApp Cloud API Webhook
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  -> Verifizierung
 *   POST  (Meta-Benachrichtigung)  -> eingehende Nachrichten ins Postfach
 *
 * Eingehende Textnachrichten werden über die Telefonnummer dem Mitglied
 * zugeordnet (M.findByPhone -> Magicline phoneNumber-Suche) und als
 * Mitglieder-Nachricht an einen WhatsApp-Vorgang gehängt (channel:'whatsapp').
 * Studio-Antworten auf so einen Vorgang gehen automatisch per WhatsApp zurück
 * (siehe lib/studioReply.applyOwnerReply). Ohne Zuordnung -> E-Mail ans Studio.
 *
 * Signaturprüfung über X-Hub-Signature-256 (lib/whatsapp.verifySignature),
 * sofern WA_APP_SECRET gesetzt ist. Antwortet immer 200 (kein Retry-Sturm).
 */

const M = require('../lib/members');
const Inbox = require('../lib/inbox');
const SR = require('../lib/studioReply');
const WA = require('../lib/whatsapp');
const { sendMail, hasMail } = require('../lib/mail');

function readRaw(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

// Laufenden WhatsApp-Vorgang des Mitglieds wiederverwenden, sonst neu anlegen.
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
  // ── GET: Webhook-Verifizierung ──
  if (req.method === 'GET') {
    let q = {}; try { const u = new URL(req.url, 'http://x'); u.searchParams.forEach((v, k) => { q[k] = v; }); } catch (e) {}
    const ch = WA.verifyChallenge(q);
    if (ch !== null) { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(ch); }
    res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); return res.end('forbidden');
  }

  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const raw = await readRaw(req);
  if (!WA.verifySignature(raw, req.headers['x-hub-signature-256'])) {
    res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'bad_signature' }));
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) {}
  const msgs = WA.parseInbound(body);

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
              'Eine WhatsApp-Nachricht konnte keinem Mitglied zugeordnet werden.\n\n'
              + 'Von: ' + (msg.name ? (msg.name + ' · ') : '') + '+' + msg.from
              + '\n\nNachricht:\n' + msg.text
              + '\n\nBitte manuell zuordnen/antworten.');
          } catch (e) {}
        }
      }
    } catch (e) { /* einzelne Nachricht darf den Lauf nicht abbrechen */ }
  }
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, handled: handled, unmatched: unmatched }));
};
