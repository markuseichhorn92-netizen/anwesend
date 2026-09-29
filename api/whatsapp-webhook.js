'use strict';

/**
 * WhatsApp Cloud API Webhook
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  -> Verifizierung
 *   POST  (Meta-Benachrichtigung)  -> eingehende Nachrichten ins Postfach
 *
 * Eingehende Textnachrichten werden über die Telefonnummer dem Mitglied
 * zugeordnet (lib/waIdentity: Magicline-Nummernsuche, eindeutig) und als
 * Mitglieder-Nachricht an einen WhatsApp-Vorgang gehängt (channel:'whatsapp').
 * Studio-Antworten auf so einen Vorgang gehen automatisch per WhatsApp zurück
 * (siehe lib/studioReply.applyOwnerReply). Ohne Zuordnung -> E-Mail ans Studio.
 *
 * Signaturprüfung über X-Hub-Signature-256 (lib/whatsapp.verifySignature),
 * sofern WA_APP_SECRET gesetzt ist. Antwortet immer 200 (kein Retry-Sturm).
 */

const WAIdentity = require('../lib/waIdentity');
const Inbox = require('../lib/inbox');
const SR = require('../lib/studioReply');
const WA = require('../lib/whatsapp');
const LF = require('../lib/leadflow');
const AI = require('../lib/ai');
const WAAssistant = require('../lib/waAssistant');
// FINN Journeys: 24-h-Fenster, STOP/START, Opt-in-Codes – vor jedem anderen Routing.
const Journeys = require('../lib/journeys');

// WhatsApp-KI (Auskunft zu Mitgliedsdaten) ist bewusst per Feature-Flag geschützt
// und standardmäßig AUS – ohne Flag bleibt es beim bisherigen Team-Weg (fail-closed).
// Die eigentliche KI-Behandlung liegt zentral in lib/waAssistant (von Meta- UND
// Twilio-Webhook geteilt, damit beide identisch reagieren).
const WA_ASSISTANT = process.env.WA_ASSISTANT === '1';

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
    // Nur das Gerüst – die eigentliche Nachricht kommt direkt danach über Inbox.reply
    // und löst dort den Team-Push aus. Doppel-Benachrichtigung vermeiden.
    notifyTeam: false,
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
      // Doppelte Zustellung desselben Webhooks (Retry des Anbieters) nur einmal verarbeiten.
      // Eigener Schlüssel – die WhatsApp-KI führt ihre eigene Sperre (wa:seen:).
      if (!(await Journeys.firstDelivery(msg.id))) continue;
      // Wer schreibt? (lib/waIdentity) – gemerkte Verknüpfung, sonst Magicline-Nummernsuche:
      // genau ein Kunde mit laufendem Vertrag → Mitglied; geteilte Nummer / kein laufender
      // Vertrag → Geburtsdatum im Chat; kein Treffer → Interessent (Pseudo-Id im Posteingang).
      const who = await WAIdentity.resolve(msg);
      let memberId = who.memberId, snapshot = who.snapshot;
      const isLead = !!who.isLead;
      if (isLead) leads++;
      const open = await findOpenWaVorgang(memberId);
      const firstContact = !open;
      let v = open || await createWaVorgang(memberId, msg.from, msg.name, snapshot);
      if (!v) continue;
      // STOP/START/Opt-in-Code/Ja-Nein auf eine offene Frage: erledigt, ohne KI oder Team-Alarm.
      const jr = await Journeys.onInbound({ provider: 'meta', phone: msg.from, text: msg.text, msgId: msg.id, name: msg.name, memberId: memberId, vorgangId: v.id });
      if (jr && jr.consumed) { handled++; WAAssistant.waLog('journeys', { provider: 'meta', kind: jr.kind }); continue; }
      // Nummer mehreren Konten (bzw. keinem laufenden Vertrag) zugeordnet: erst per Geburtsdatum
      // die richtige Person finden – ohne KI, ohne Lead-Weg. Danach die ursprüngliche Frage
      // im Vorgang des gewählten Mitglieds beantworten.
      let inMsg = msg;
      const choosing = !!who.pick && !!(WA_ASSISTANT && AI.hasAI && WA.hasWhatsApp);   // KI aus → Team-Weg wie bisher
      if (choosing) {
        const pr = await WAIdentity.pickTurn({ msg: msg, memberId: memberId, vorgang: v, pick: who.pick });
        if (!pr || !pr.picked) { handled++; continue; }
        memberId = pr.picked; snapshot = pr.snapshot;
        v = (await findOpenWaVorgang(memberId)) || await createWaVorgang(memberId, msg.from, msg.name, snapshot);
        if (!v) continue;
        if (!pr.replay) { handled++; continue; }
        inMsg = Object.assign({}, msg, { text: pr.replay, id: msg.id ? (msg.id + ':replay') : '', image: null });
      }
      // Diagnose (ohne Personenbezug): Mitglied erkannt? WhatsApp-KI scharf? (Provider: meta)
      WAAssistant.waLog('inbound', {
        provider: 'meta', known: !isLead, via: who.via,
        gate: !!(WA_ASSISTANT && AI.hasAI && WA.hasWhatsApp), flag: WA_ASSISTANT, ai: !!AI.hasAI, wa: !!WA.hasWhatsApp,
      });
      // Interessent: FINN-Lead-Agent antwortet in Sekunden (FINN Journeys, nur mit JOURNEYS=1).
      // Auch wenn die Nummer schon einem Magicline-Lead zugeordnet ist. Ohne Schalter wie bisher.
      if (isLead || (!choosing && (await Journeys.isLeadConversation(msg.from)))) {
        const lr = await Journeys.leadTurn({ provider: 'meta', memberId: memberId, vorgang: v, msg: msg, firstContact: firstContact, unknown: isLead });
        if (lr && lr.handled) { handled++; continue; }
      }
      if (isLead) {
        await SR.applyMemberReply(memberId, v.id, msg.text); handled++;
        const fresh = await Inbox.get(memberId, v.id);
        await LF.onLeadMessage({ memberId: memberId, vorgang: fresh || v, phone: msg.from, profileName: msg.name, firstContact: firstContact });
      } else if (WA_ASSISTANT && AI.hasAI && WA.hasWhatsApp) {
        // Bekanntes Mitglied: WhatsApp-KI protokolliert die Nachricht selbst (still) und
        // benachrichtigt das Team NUR bei Eskalation.
        handled++;
        try { await WAAssistant.handleInbound({ req: req, memberId: memberId, msg: inMsg, vorgang: v }); } catch (e) { WAAssistant.waLog('error', { name: String(e && e.name) }); }
      } else {
        await SR.applyMemberReply(memberId, v.id, msg.text); handled++;
      }
    } catch (e) { WAAssistant.waLog('loop_error', { name: String(e && e.name) }); }
  }

  // Zustell-/Lesestatus (gesendet/zugestellt/gelesen/fehlgeschlagen) auf die passende
  // Team-Nachricht anwenden. Best effort, blockiert die Antwort nicht.
  try {
    const Receipts = require('../lib/receipts');
    const { noteDelivery } = require('../lib/loginCode');
    const sts = WA.parseStatuses(body);
    for (const s of sts) {
      try { await Receipts.applyStatus(s.id, s.status, { code: s.code || null }); } catch (e) {}
      // Journeys: Fenster zu (131047), Marketingdeckel (131049), unzustellbar (131026).
      try { await Journeys.onStatus(s.id, s.status, s.code || null); } catch (e) {}
      // War es ein Login-Code? Dann festhalten, wie lange die Zustellung
      // gedauert hat - das ist der Teil, den WhatsApp verantwortet.
      try { await noteDelivery(s.id, s.status); } catch (e) {}
    }
  } catch (e) {}

  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, handled: handled, leads: leads }));
};
