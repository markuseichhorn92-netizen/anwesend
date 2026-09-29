'use strict';

/**
 * FINN Journeys – Interessenten-Gespräch auf WhatsApp („Antwort in Sekunden").
 * -----------------------------------------------------------------------------
 * leadTurn({ provider, memberId, vorgang, msg, firstContact, unknown })
 *   -> { handled } – handled:false heißt: Lead-KI aus -> der Webhook macht wie bisher weiter.
 *
 *   1. Nachricht still im Vorgang (kein Team-Alarm je Nachricht; nur beim ersten Kontakt)
 *   2. bestehende Lead-Automatik (KI-Hinweis, Name/E-Mail erkennen, Magicline-Lead) –
 *      ohne feste Begrüßung, die übernimmt jetzt der Agent
 *   3. Lead-Datensatz + Lead-Journey (Nachfassen, Erinnerungen)
 *   4. FINN-Lead-Agent antwortet: Ziel, Erfahrung, Tageszeit -> freie Termine -> Buchung
 *      mit ausdrücklicher Bestätigung (Risiko MEDIUM)
 *   5. Nach der Buchung EINMAL die Frage nach Tipps/Angeboten (Einwilligung „marketing",
 *      Ja/Nein wird in lib/journeys/inbound deterministisch ausgewertet – nicht vom Modell)
 * Kann die KI nicht antworten, gilt der alte Weg: feste Begrüßung + Team übernimmt.
 */

const Phone = require('../phone');
const Config = require('./config');
const Store = require('./store');

const ASK_TEXT = 'Noch eine kurze Frage: Darf ich dir nach dem Probetraining hier ab und zu Tipps und Angebote schicken? Höchstens zwei Nachrichten pro Woche, Abmeldung jederzeit mit STOP.';

function log(o) { try { console.log('[journeys]', JSON.stringify(o)); } catch (e) {} }
function firstNameOf(n) { const f = String(n || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÄÖÜäöüß'’-]{2,24}$/.test(f) ? f : null; }

async function active() {
  if (process.env.JOURNEYS_LEAD_AI === '0') return false;
  if (!(await Config.journeyOn('lead'))) return false;
  try { if (!require('../ai').hasAI) return false; } catch (e) { return false; }
  try { if (!require('../whatsapp').hasWhatsApp) return false; } catch (e) { return false; }
  return true;
}

// Läuft zu dieser Nummer ein Interessenten-Gespräch? (auch wenn die Nummer schon einem
// Magicline-Lead-Kunden zugeordnet ist – der Webhook hielte ihn sonst für ein Mitglied)
async function isLeadConversation(phone) {
  if (!Config.on()) return false;
  if (!Config.aiAllowedFor(phone)) return false;        // Pilot: fremde Nummern gehen den bisherigen Weg
  const subj = await Store.forPhone(phone);
  if (!subj || !Store.isLeadId(subj)) return false;
  const st = await Store.load(subj);
  return !!(st && !st.facts.wonAt);
}

function historyOf(v) {
  const msgs = ((v && v.messages) || []).filter((m) => m && (m.from === 'member' || m.from === 'team') && m.text);
  // die gerade eingegangene Nachricht ist die Eingabe, nicht Teil der Historie
  const hist = msgs.slice(0, -1).slice(-8);
  return hist.map((m) => ({ role: m.from === 'team' ? 'assistant' : 'user', text: String(m.text).slice(0, 800) }));
}

function leadInfo(st, lead) {
  const f = (st && st.facts) || {};
  const bits = [];
  const name = (lead && lead.name && !/^\+?\d+$/.test(lead.name)) ? lead.name : null;
  if (name) bits.push('Name ' + name);
  if (f.profile && f.profile.goal) bits.push('Ziel ' + f.profile.goal);
  if (f.profile && f.profile.exp) bits.push('Erfahrung ' + f.profile.exp);
  if (f.profile && f.profile.daypart) bits.push('Tageszeit ' + f.profile.daypart);
  if (f.trialAt && !f.trialCancelledAt) {
    try { bits.push('Probetraining ist bereits gebucht für ' + require('../trialBooking').label(new Date(f.trialAt).toISOString()) + ' Uhr – nicht erneut buchen'); } catch (e) {}
  }
  return bits.join('; ');
}

async function logBot(memberId, vorgangId, text, providerId) {
  try {
    const Inbox = require('../inbox');
    const v = await Inbox.get(memberId, vorgangId); if (!v) return;
    const at = Date.now();
    v.messages = v.messages || [];
    v.messages.push({ from: 'team', text: String(text || '').slice(0, 4000), at: at, author: 'FINN', ch: 'whatsapp', st: 'sent' });
    v.updatedAt = at;
    await Inbox.save(memberId, v);
    if (providerId) { try { await require('../receipts').track(providerId, { m: memberId, v: vorgangId, at: at }); } catch (e) {} }
  } catch (e) {}
}

async function sendOut(phone, text, buttons) {
  const WA = require('../whatsapp');
  let r = null;
  if (buttons && Array.isArray(buttons.options) && buttons.options.length >= 2 && WA.hasWaButtons) {
    try { r = await WA.sendButtons(phone, buttons); } catch (e) { r = null; }
    if (r && r.ok !== false) return r;
  }
  try { r = await WA.sendText(phone, text); } catch (e) { r = null; }
  return r && r.ok !== false ? r : null;
}

async function leadTurn(o) {
  o = o || {};
  if (!(await active())) return { handled: false };
  const msg = o.msg || {};
  const phone = Phone.canon(msg.from);
  if (!phone || !o.vorgang) return { handled: false };
  // Pilot: Die KI antwortet nur, wo auch gesendet werden dürfte (Testnummern bzw.
  // Echtbetrieb). Sonst bleibt alles beim bisherigen Weg – keine KI, keine Buchung.
  if (!Config.aiAllowedFor(phone)) return { handled: false, reason: 'pilot' };
  const Inbox = require('../inbox');
  const LF = require('../leadflow');
  let memberId = String(o.memberId), v = o.vorgang;

  // 1. still protokollieren
  try { await Inbox.reply(memberId, v.id, msg.text || '', null, { notifyTeam: false }); } catch (e) {}

  // 2. bestehende Lead-Automatik (KI-Hinweis, Magicline-Lead bei Name + E-Mail)
  try {
    if (o.unknown) {
      const fresh = await Inbox.get(memberId, v.id);
      const res = await LF.onLeadMessage({ memberId: memberId, vorgang: fresh || v, phone: msg.from, profileName: msg.name, firstContact: o.firstContact, noIntro: true });
      if (res && res.vorgang && res.customerId != null) { memberId = String(res.customerId); v = res.vorgang; }
    } else {
      await require('../waIntro').discloseOnce(msg.from);
    }
  } catch (e) {}

  // 3. Lead + Journey
  let lead = null, st = null;
  try {
    lead = await LF.getLeadByPhone(phone);
    if (!lead) lead = await LF.recordLead({ phone: phone, name: msg.name || null, source: 'whatsapp' });
    if (lead) st = await require('./hooks').onLeadContact({ leadId: lead.id, phone: phone, firstName: firstNameOf(msg.name), inbox: memberId, source: 'whatsapp' });
  } catch (e) {}
  if (o.firstContact) { try { await Inbox.alertTeam(memberId, v.id); } catch (e) {} }

  // 4. FINN-Lead-Agent
  let fresh = null; try { fresh = await Inbox.get(memberId, v.id); } catch (e) {}
  let r = null;
  try {
    r = await require('../finn/channels').whatsappLead({ phone: phone, text: msg.text || '', history: historyOf(fresh || v), vorgangId: v.id, inboxId: memberId, leadInfo: leadInfo(st, lead) });
  } catch (e) { r = { handled: false, error: 'exception' }; }
  if (!r || !r.handled || !r.text) {
    // alter Weg: feste Begrüßung beim ersten Kontakt, Team übernimmt
    if (o.firstContact) { const t = LF.leadIntro(msg.name); const s = await sendOut(phone, t); if (s) await logBot(memberId, v.id, t, s.id); }
    try { await Inbox.alertTeam(memberId, v.id); } catch (e) {}
    log({ ev: 'lead_turn', ai: false, err: r && r.error ? String(r.error).slice(0, 20) : null });
    return { handled: true, ai: false };
  }
  const sent = await sendOut(phone, r.text, r.buttons);
  await logBot(memberId, v.id, r.text, sent && sent.id);

  // 5. nach der Buchung: einmal nach Tipps/Angeboten fragen
  if (r.done && r.tool === 'book_trial' && r.data && r.data.askMarketing) {
    try {
      await require('./inbound').ask(phone, ['marketing'], 'lead_booking', lead && lead.id);
      const s2 = await sendOut(phone, ASK_TEXT + '\n\n1) Ja, gern\n2) Nein, danke', { body: ASK_TEXT, options: [{ id: 'jr:ask:yes', title: 'Ja, gern' }, { id: 'jr:ask:no', title: 'Nein, danke' }] });
      await logBot(memberId, v.id, ASK_TEXT, s2 && s2.id);
    } catch (e) {}
  }
  if (r.handoff) { try { await Inbox.alertTeam(memberId, v.id); } catch (e) {} }
  log({ ev: 'lead_turn', ai: true, agent: r.agent, done: !!r.done, tool: r.tool || null });
  return { handled: true, ai: true, agent: r.agent };
}

module.exports = { leadTurn, isLeadConversation, active, historyOf, leadInfo, ASK_TEXT };
