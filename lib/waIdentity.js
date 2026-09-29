'use strict';

/**
 * WhatsApp: Wer schreibt da? – Mitglied an der Nummer erkennen, ohne Bestätigungs-Link.
 * -----------------------------------------------------------------------------
 * Die Absendernummer einer WhatsApp-Nachricht ist geprüft (WhatsApp bestätigt sie bei der
 * Anmeldung, Twilio/Meta signieren den Webhook). Deshalb reicht sie hier als Nachweis –
 * aber nur, wenn sie EINDEUTIG ist:
 *
 *   1. Gemerkte Zuordnung (lib/leadflow resolveKnownLead: START-Code aus der App, Team)
 *   2. Magicline: genau EIN Kunde mit dieser Nummer UND laufender Vertrag  → erkannt
 *   3. Mehrere Kunden (geteilte Nummer, z. B. Familie) oder kein laufender Vertrag
 *      → einmal nach dem Geburtsdatum fragen (pickTurn). Die Wahl gilt 60 Tage und nur,
 *        solange die Nummer in Magicline noch an diesem Kunden hängt.
 *   4. Kein Treffer → Interessent (Lead-Weg wie bisher)
 *
 * Grenzen – bewusst:
 *   - Nur WhatsApp. Die Telefon-Hotline (lib/phoneAuth) zählt Anruferkennungen NICHT als
 *     Nachweis (fälschbar) – deshalb schreibt dieses Modul NIE wa:verify:, das die Hotline
 *     als zweiten Faktor liest.
 *   - Das Geburtsdatum prüft der Server, nie das Modell; es geht nicht in Logs und steht
 *     im Posteingang nur als „Geburtsdatum angegeben".
 *   - Gesundheitsdaten brauchen zusätzlich das „Ja" im Chat (lib/waHealth).
 */

const KV = require('./finn/kv');

const PICK_TTL = 60 * 86400;
const ASK_TTL = 30 * 60;
const ACT_TTL = 6 * 3600;
const MAX_FAILS = 3;

const TXT = {
  askShared: 'Unter deiner Nummer sind bei uns mehrere Mitgliedskonten hinterlegt. Damit ich dir zu DEINEM Konto antworte: Wie lautet dein Geburtsdatum? (z. B. 24.05.1990)',
  askFormer: 'Damit ich sicher bin, dass ich dir zu deinem Konto antworte: Wie lautet dein Geburtsdatum? (z. B. 24.05.1990)',
  again: 'Ich brauche dafür zuerst dein Geburtsdatum – schick es mir bitte so: 24.05.1990',
  nomatch: 'Das Geburtsdatum passt zu keinem Konto unter dieser Nummer. Magst du es nochmal prüfen? (z. B. 24.05.1990)',
  handoff: 'Das klappt so leider nicht – ich gebe dein Anliegen an einen Kollegen aus dem Team weiter, der meldet sich hier bei dir. 🙌',
  thanks: 'Danke{name}! 😊',
};

function digitsOf(p) { return String(p == null ? '' : p).replace(/[^\d]/g, ''); }
function initialsOf(n) { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length ? ((p[0][0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '')).toUpperCase() : ''; }
function idOf(c) { return c && (c.id != null ? String(c.id) : (c.customerId != null ? String(c.customerId) : null)); }
function snapshotOf(c, msg) {
  const nm = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  return { name: nm || ('+' + msg.from), nr: c.customerNumber || null, initials: initialsOf(nm) || initialsOf(msg.name) || 'WA', email: c.email || null, phone: msg.from };
}

// Laufender Vertrag? (6 h gemerkt – je Nachricht nicht erneut bei Magicline fragen.)
async function isActive(id) {
  const k = 'wa:act:' + id;
  const cached = await KV.get(k).catch(() => null);
  if (cached === '1' || cached === '0') return cached === '1';
  let active = false;
  try { const c = await require('./members').getContract(id); active = !!(c && c.active); } catch (e) { return false; }
  await KV.set(k, active ? '1' : '0', ACT_TTL).catch(() => {});
  return active;
}

/**
 * -> { memberId, snapshot, via: 'linked'|'phone'|'pick'|'choose'|'lead', isLead, linked?, pick? }
 *    pick = { candidates:[ids], reason:'shared'|'former' } → der Webhook ruft pickTurn.
 */
async function resolve(msg) {
  msg = msg || {};
  const LF = require('./leadflow');
  const M = require('./members');
  const linked = await LF.resolveKnownLead(msg.from);
  if (linked && linked.id) {
    return { memberId: String(linked.id), via: 'linked', isLead: false, linked: linked,
      snapshot: { name: linked.name || ('+' + msg.from), nr: linked.nr || null, initials: initialsOf(linked.name) || 'WA', phone: msg.from } };
  }
  let all = [];
  try { all = await M.findAllByPhone(msg.from); } catch (e) { all = []; }
  all = all.filter((c) => idOf(c));
  if (!all.length) {
    return { memberId: 'wa' + msg.from, via: 'lead', isLead: true,
      snapshot: { name: msg.name || ('+' + msg.from), nr: null, initials: initialsOf(msg.name) || 'WA', phone: msg.from, lead: true } };
  }
  const ids = all.map(idOf);
  const picked = await KV.getJSON('wa:pick:' + digitsOf(msg.from)).catch(() => null);
  if (picked && ids.indexOf(String(picked.memberId)) >= 0) {
    await KV.expire('wa:pick:' + digitsOf(msg.from), PICK_TTL).catch(() => {});
    const c = all[ids.indexOf(String(picked.memberId))];
    return { memberId: String(picked.memberId), via: 'pick', isLead: false, snapshot: snapshotOf(c, msg) };
  }
  if (all.length === 1 && (await isActive(ids[0]))) {
    return { memberId: ids[0], via: 'phone', isLead: false, snapshot: snapshotOf(all[0], msg) };
  }
  return { memberId: 'wa' + msg.from, via: 'choose', isLead: false,
    pick: { candidates: ids.slice(0, 6), reason: all.length > 1 ? 'shared' : 'former' },
    snapshot: { name: '+' + msg.from, nr: null, initials: 'WA', phone: msg.from } };
}

// „24.05.1990", „24.5.90", „1990-05-24", „24/05/1990", „24 05 1990" → „1990-05-24".
function parseDob(text) {
  const t = String(text || '').trim();
  let d, m, y;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else {
    x = /^(\d{1,2})[.\/\s-]+(\d{1,2})[.\/\s-]+(\d{2}|\d{4})\.?$/.exec(t);
    if (!x) return null;
    d = +x[1]; m = +x[2]; y = +x[3];
    if (y < 100) { const cur = new Date().getFullYear() % 100; y += y > cur ? 1900 : 2000; }
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > new Date().getFullYear()) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Nachricht einer Nummer, die mehreren Kunden (bzw. keinem laufenden Vertrag) gehört.
 * o: { msg, memberId (Pseudo-Id des Vorgangs), vorgang, pick }
 * -> { picked, snapshot, replay } wenn das Geburtsdatum genau einen Kunden trifft
 *    (replay = die ursprüngliche Frage, die jetzt beantwortet werden soll), sonst { done }.
 */
async function pickTurn(o) {
  o = o || {};
  const msg = o.msg || {}, v = o.vorgang || {}, pick = o.pick || { candidates: [], reason: 'shared' };
  const WAA = require('./waAssistant');
  const Inbox = require('./inbox');
  const digits = digitsOf(msg.from);
  const askKey = 'wa:pickask:' + digits, failKey = 'wa:pickfail:' + digits;
  const log = (text) => Inbox.reply(o.memberId, v.id, text, null, { notifyTeam: false }).catch(() => {});
  const text = String(msg.text || '').trim();

  const ask = await KV.getJSON(askKey).catch(() => null);
  if (!ask) {
    await log(text || '📷');
    await KV.set(askKey, { q: text.slice(0, 1000), at: Date.now() }, ASK_TTL);
    await WAA.ownerReply(o.memberId, v.id, pick.reason === 'shared' ? TXT.askShared : TXT.askFormer, 'System');
    WAA.waLog('identity', { step: 'ask', reason: pick.reason, n: pick.candidates.length });
    return { done: true };
  }
  const dob = parseDob(text);
  if (!dob) {
    await log(text);
    await WAA.ownerReply(o.memberId, v.id, TXT.again, 'System');
    return { done: true };
  }
  await log('(Geburtsdatum angegeben)');
  const fails = parseInt((await KV.get(failKey).catch(() => null)) || '0', 10) || 0;
  if (fails >= MAX_FAILS) return handoff(o, askKey);
  const M = require('./members');
  const hits = [];
  for (const id of pick.candidates) {
    let c = null; try { c = await M.getMember(id); } catch (e) {}
    if (c && String(c.dateOfBirth || '').slice(0, 10) === dob) hits.push(c);
  }
  if (hits.length !== 1) {
    const n = await KV.incr(failKey, 86400).catch(() => fails + 1);
    WAA.waLog('identity', { step: 'nomatch', fails: n });
    if (n >= MAX_FAILS) return handoff(o, askKey);
    await WAA.ownerReply(o.memberId, v.id, TXT.nomatch, 'System');
    return { done: true };
  }
  const c = hits[0];
  await KV.set('wa:pick:' + digits, { memberId: idOf(c), at: Date.now() }, PICK_TTL);
  await KV.del(askKey).catch(() => {}); await KV.del(failKey).catch(() => {});
  const first = String(c.firstName || '').trim().split(/\s+/)[0];
  await WAA.ownerReply(o.memberId, v.id, TXT.thanks.replace('{name}', first ? (', ' + first) : ''), 'System');
  try { await Inbox.resolve(o.memberId, v.id); } catch (e) {}   // Zuordnungs-Vorgang erledigt
  WAA.waLog('identity', { step: 'picked' });
  return { picked: idOf(c), snapshot: snapshotOf(c, msg), replay: ask.q || null };
}

async function handoff(o, askKey) {
  const WAA = require('./waAssistant');
  await KV.del(askKey).catch(() => {});
  await WAA.ownerReply(o.memberId, o.vorgang.id, TXT.handoff, 'System');
  try { await WAA.teamAlert(o.memberId, o.vorgang, '(Zuordnung per Geburtsdatum gescheitert)', 'Nummer mehreren Konten zugeordnet'); } catch (e) {}
  WAA.waLog('identity', { step: 'handoff' });
  return { done: true, handoff: true };
}

// Datenschutz: gemerkte Wahl einer Nummer entfernen (Löschung, Widerruf, Team).
async function forget(phone) { const d = digitsOf(phone); if (!d) return; await KV.del('wa:pick:' + d).catch(() => {}); await KV.del('wa:pickask:' + d).catch(() => {}); await KV.del('wa:pickfail:' + d).catch(() => {}); }

module.exports = { resolve, pickTurn, parseDob, isActive, forget, TXT, PICK_TTL, MAX_FAILS };
