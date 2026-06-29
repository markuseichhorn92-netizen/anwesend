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
const LF = require('../lib/leadflow');

function readRaw(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
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

  let handled = 0, leads = 0;
  for (const msg of msgs) {
    try {
      const member = await M.findByPhone(msg.from);
      let memberId, snapshot, isLead = false;
      if (member && member.id != null) {
        memberId = String(member.id);
        const nm = ((member.firstName || '') + ' ' + (member.lastName || '')).trim();
        snapshot = { name: nm || ('+' + msg.from), nr: member.customerNumber || null,
          initials: initialsOf(nm) || initialsOf(msg.name) || 'WA', email: member.email || null, phone: msg.from };
      } else {
        // Schon einmal angelegter Lead? -> bestehendem Kunden zuordnen (keine Dublette).
        const linked = await LF.resolveKnownLead(msg.from);
        if (linked && linked.id) {
          memberId = String(linked.id);
          snapshot = { name: linked.name || ('+' + msg.from), nr: linked.nr || null, initials: initialsOf(linked.name) || 'WA', phone: msg.from };
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
      if (isLead) {
        const fresh = await Inbox.get(memberId, v.id);
        await LF.onLeadMessage({ memberId: memberId, vorgang: fresh || v, phone: msg.from, profileName: msg.name, firstContact: firstContact });
      }
    } catch (e) { /* einzelne Nachricht darf den Lauf nicht abbrechen */ }
  }
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, handled: handled, leads: leads }));
};
