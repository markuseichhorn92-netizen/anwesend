'use strict';

/**
 * Trainingspartner / Community (Mitglied ↔ Mitglied) – Kern.
 * ---------------------------------------------------------
 * Eigener Store (Upstash KV, REST via lib/store) – bewusst ohne SDK/Dependency.
 * B1: Opt-in/Consent (+ Altersgrenze), Verbinden per persönlichem Code (Handshake
 * mit beidseitiger Bestätigung), Buddy-Liste, Blockieren. Chat/Präsenz/Planen/
 * Challenges kommen in späteren Batches dazu.
 *
 * DATENSCHUTZ-GRUNDSATZ:
 *  - Alles ist Opt-in (enabled + consentAt). Es gibt KEIN durchsuchbares
 *    Verzeichnis – man verbindet sich ausschließlich über einen persönlichen Code.
 *  - Geteilt wird nur der selbstgewählte Anzeigename (+ Initialen) und – je nach
 *    Freigabe – bestimmte Aktivitäts-Signale. NIEMALS E-Mail/Adresse/Telefon/IBAN.
 *  - Altersgrenze ≥ MIN_AGE (aus dem Magicline-Geburtsdatum, server-seitig geprüft).
 *
 * Keys (Präfix soc):
 *   soc:me:<id>          JSON { enabled, consentAt, displayName, share:{streak,checkins,nutrition}, code, updatedAt }
 *   soc:code:<CODE>      -> memberId   (Nachschlag beim Verbinden; Code ist eindeutig)
 *   soc:conn:<id>        SET verbundener Buddy-IDs
 *   soc:req:in:<id>      SET eingehender Verbindungsanfragen
 *   soc:req:out:<id>     SET ausgehender Verbindungsanfragen
 *   soc:block:<id>       SET blockierter Mitglieder
 *
 * Grundsatz (wie im Bestand): wirft NIE. Ohne Store -> "not available".
 */

const crypto = require('crypto');
const { redisPipeline, hasStore } = require('./store');
// Push ist optional – best effort. Ohne Konfiguration (hasPush=false) passiert nichts.
let Push = null; try { Push = require('./push'); } catch (e) {}

const MIN_AGE = 16;
const MAX_BUDDIES = 50;
const MAX_NAME = 40;
// Verwechslungsarmes Alphabet (ohne I, O, 0, 1).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const MAX_MSGS = 200;      // Nachrichten je Chat cappen
const MAX_TEXT = 1000;

const meKey = (id) => 'soc:me:' + id;
const codeKey = (code) => 'soc:code:' + String(code).toUpperCase();
const connKey = (id) => 'soc:conn:' + id;
const reqInKey = (id) => 'soc:req:in:' + id;
const reqOutKey = (id) => 'soc:req:out:' + id;
const blockKey = (id) => 'soc:block:' + id;
// B2: 1:1-Chat + Ungelesen-Zähler + Meldungen.
const dmKey = (a, b) => { const x = sid(a), y = sid(b); return x <= y ? ('soc:dm:' + x + ':' + y) : ('soc:dm:' + y + ':' + x); };
const dmIdxKey = (id) => 'soc:dmidx:' + id;
const unreadKey = (id) => 'soc:unread:' + id;   // Hash { otherId -> count }
const REPORTS = 'soc:reports';                   // LIST (LPUSH), für die Studio-Moderation (B6)

function sid(x) { return String(x == null ? '' : x).trim(); }

function ageFrom(dob) {
  if (!dob) return null;
  const t = Date.parse(dob);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
}
function ageOk(member) { const a = ageFrom(member && member.dateOfBirth); return a == null || a >= MIN_AGE; }

function initialsOf(name) {
  const p = sid(name).split(/\s+/).filter(Boolean);
  if (!p.length) return '??';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}
// Default-Anzeigename: Vorname + Initial des Nachnamens (z. B. "Markus E.") – datensparsam.
function defaultName(member) {
  const fn = sid(member && member.firstName);
  const ln = sid(member && member.lastName);
  const base = (fn || 'Mitglied') + (ln ? (' ' + ln[0].toUpperCase() + '.') : '');
  return base.slice(0, MAX_NAME);
}
function normShare(s) {
  s = s || {};
  // Check-ins & Streak standardmäßig geteilt; Ernährung (sensibler) nur auf Wunsch.
  return { streak: s.streak !== false, checkins: s.checkins !== false, nutrition: !!s.nutrition };
}
function randomCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

async function loadMe(id) {
  id = sid(id); if (!hasStore || !id) return null;
  try { const [s] = await redisPipeline([['GET', meKey(id)]]); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
async function saveMe(id, me) {
  try { await redisPipeline([['SET', meKey(sid(id)), JSON.stringify(me)]]); return true; } catch (e) { return false; }
}
// Eindeutigen Code beanspruchen (SET NX). Best effort mit wenigen Versuchen.
async function claimCode(id) {
  id = sid(id);
  for (let i = 0; i < 8; i++) {
    const c = randomCode();
    try { const [set] = await redisPipeline([['SET', codeKey(c), id, 'NX']]); if (set) return c; } catch (e) { return c; }
  }
  return randomCode();
}

function publicMe(me) {
  me = me || {};
  return { enabled: !!me.enabled, code: me.code || null, displayName: me.displayName || '', share: normShare(me.share), consentAt: me.consentAt || null };
}
function buddyInfo(bid, bme) {
  bme = bme || {};
  const name = bme.displayName || 'Mitglied';
  return { id: sid(bid), name: name, initials: initialsOf(name), active: bme.enabled !== false };
}

// ── Opt-in / Consent ──
// member = Magicline-Objekt (autoritative Altersprüfung + Default-Name).
async function enable(id, member, opts) {
  id = sid(id); if (!hasStore || !id) return { ok: false, error: 'unavailable' };
  if (!ageOk(member)) return { ok: false, error: 'too_young', message: 'Trainingspartner sind erst ab ' + MIN_AGE + ' Jahren möglich.' };
  const me = (await loadMe(id)) || {};
  if (!me.code) me.code = await claimCode(id);
  me.enabled = true;
  if (!me.consentAt) me.consentAt = Date.now();
  me.displayName = (sid(opts && opts.displayName).slice(0, MAX_NAME)) || defaultName(member);
  me.share = normShare(opts && opts.share);
  me.updatedAt = Date.now();
  await saveMe(id, me);
  return { ok: true, profile: publicMe(me) };
}
async function disable(id) {
  id = sid(id); const me = await loadMe(id);
  if (!me) return { ok: true };
  try { if (me.code) await redisPipeline([['DEL', codeKey(me.code)]]); } catch (e) {}
  me.enabled = false; me.code = null; me.disabledAt = Date.now();
  await saveMe(id, me);
  return { ok: true };
}
async function setShare(id, share) {
  id = sid(id); const me = await loadMe(id);
  if (!me || !me.enabled) return { ok: false, error: 'not_enabled' };
  me.share = normShare(share); me.updatedAt = Date.now();
  await saveMe(id, me);
  return { ok: true, profile: publicMe(me) };
}

// ── Verbinden (Handshake) ──
async function doConnect(a, b) {
  a = sid(a); b = sid(b);
  try {
    await redisPipeline([
      ['SADD', connKey(a), b], ['SADD', connKey(b), a],
      ['SREM', reqInKey(a), b], ['SREM', reqOutKey(a), b],
      ['SREM', reqInKey(b), a], ['SREM', reqOutKey(b), a],
    ]);
    return true;
  } catch (e) { return false; }
}
async function connectByCode(id, code) {
  id = sid(id); code = sid(code).toUpperCase();
  if (!hasStore || !id || !code) return { ok: false, error: 'unavailable' };
  const me = await loadMe(id);
  if (!me || !me.enabled) return { ok: false, error: 'not_enabled' };
  let targetId = null;
  try { const [t] = await redisPipeline([['GET', codeKey(code)]]); targetId = t ? sid(t) : null; } catch (e) {}
  if (!targetId) return { ok: false, error: 'not_found', message: 'Kein Mitglied mit diesem Code gefunden.' };
  if (targetId === id) return { ok: false, error: 'self', message: 'Das ist dein eigener Code.' };
  const target = await loadMe(targetId);
  if (!target || !target.enabled) return { ok: false, error: 'not_found', message: 'Kein Mitglied mit diesem Code gefunden.' };
  let iBlockT, tBlockI, already;
  try { [iBlockT, tBlockI, already] = await redisPipeline([
    ['SISMEMBER', blockKey(id), targetId],
    ['SISMEMBER', blockKey(targetId), id],
    ['SISMEMBER', connKey(id), targetId],
  ]); } catch (e) {}
  if (already) return { ok: true, status: 'connected', buddy: buddyInfo(targetId, target) };
  if (iBlockT) return { ok: false, error: 'blocked', message: 'Du hast dieses Mitglied blockiert.' };
  if (tBlockI) return { ok: false, error: 'blocked', message: 'Verbindung nicht möglich.' };
  let cnt; try { [cnt] = await redisPipeline([['SCARD', connKey(id)]]); } catch (e) {}
  if ((Number(cnt) || 0) >= MAX_BUDDIES) return { ok: false, error: 'limit', message: 'Du hast das Maximum an Trainingspartnern erreicht.' };
  // Hat mir das Ziel bereits eine Anfrage geschickt? -> direkt verbinden (beidseitig bestätigt).
  let pending; try { [pending] = await redisPipeline([['SISMEMBER', reqInKey(id), targetId]]); } catch (e) {}
  if (pending) { await doConnect(id, targetId); return { ok: true, status: 'connected', buddy: buddyInfo(targetId, target) }; }
  try { await redisPipeline([['SADD', reqOutKey(id), targetId], ['SADD', reqInKey(targetId), id]]); } catch (e) {}
  return { ok: true, status: 'requested', buddy: buddyInfo(targetId, target) };
}
async function accept(id, otherId) {
  id = sid(id); otherId = sid(otherId);
  let pending; try { [pending] = await redisPipeline([['SISMEMBER', reqInKey(id), otherId]]); } catch (e) {}
  if (!pending) return { ok: false, error: 'no_request' };
  let cnt; try { [cnt] = await redisPipeline([['SCARD', connKey(id)]]); } catch (e) {}
  if ((Number(cnt) || 0) >= MAX_BUDDIES) return { ok: false, error: 'limit', message: 'Du hast das Maximum an Trainingspartnern erreicht.' };
  await doConnect(id, otherId);
  return { ok: true, buddy: buddyInfo(otherId, await loadMe(otherId)) };
}
async function decline(id, otherId) {
  id = sid(id); otherId = sid(otherId);
  try { await redisPipeline([['SREM', reqInKey(id), otherId], ['SREM', reqOutKey(otherId), id]]); } catch (e) {}
  return { ok: true };
}
async function removeBuddy(id, otherId) {
  id = sid(id); otherId = sid(otherId);
  try { await redisPipeline([['SREM', connKey(id), otherId], ['SREM', connKey(otherId), id]]); } catch (e) {}
  return { ok: true };
}
async function block(id, otherId) {
  id = sid(id); otherId = sid(otherId);
  if (!otherId || otherId === id) return { ok: false };
  try {
    await redisPipeline([
      ['SADD', blockKey(id), otherId],
      ['SREM', connKey(id), otherId], ['SREM', connKey(otherId), id],
      ['SREM', reqInKey(id), otherId], ['SREM', reqOutKey(id), otherId],
      ['SREM', reqInKey(otherId), id], ['SREM', reqOutKey(otherId), id],
    ]);
  } catch (e) {}
  return { ok: true };
}
async function unblock(id, otherId) {
  try { await redisPipeline([['SREM', blockKey(sid(id)), sid(otherId)]]); } catch (e) {}
  return { ok: true };
}

// ── Listen ──
async function membersOf(setKey) {
  let ids; try { [ids] = await redisPipeline([['SMEMBERS', setKey]]); } catch (e) { return []; }
  return Array.isArray(ids) ? ids.map(sid).filter(Boolean) : [];
}
async function decorate(ids) {
  if (!ids.length) return [];
  let mes; try { mes = await redisPipeline(ids.map(function (b) { return ['GET', meKey(b)]; })); } catch (e) { mes = []; }
  return ids.map(function (b, i) { let bme = {}; try { bme = JSON.parse(mes[i]) || {}; } catch (e) {} return buddyInfo(b, bme); });
}
async function listBuddies(id) { return decorate(await membersOf(connKey(sid(id)))); }
async function listRequests(id) { return (await decorate(await membersOf(reqInKey(sid(id))))).filter(function (x) { return x.active; }); }

// Sind zwei Mitglieder verbunden? (Für spätere Batches: Chat/Challenge nur unter Buddies.)
async function areBuddies(a, b) {
  a = sid(a); b = sid(b); if (!hasStore || !a || !b) return false;
  try { const [r] = await redisPipeline([['SISMEMBER', connKey(a), b]]); return !!r; } catch (e) { return false; }
}
async function isBlocked(a, b) {
  a = sid(a); b = sid(b); if (!hasStore) return false;
  try { const [x, y] = await redisPipeline([['SISMEMBER', blockKey(a), b], ['SISMEMBER', blockKey(b), a]]); return !!(x || y); } catch (e) { return false; }
}

// ── 1:1-Chat (nur zwischen verbundenen Buddys) ──
function cleanText(t) { return String(t == null ? '' : t).replace(/^\s+|\s+$/g, '').slice(0, MAX_TEXT); }
// Nachrichten für den Client aufbereiten: `mine` statt roher Mitglieds-ID (kein ID-Leak).
function viewMsgs(thread, id) {
  const arr = (thread && Array.isArray(thread.messages)) ? thread.messages : [];
  return arr.map(function (m) { return { mine: sid(m.from) === sid(id), text: m.text, at: m.at }; });
}
async function getDm(id, otherId) {
  id = sid(id); otherId = sid(otherId);
  if (!hasStore || !id || !otherId) return { ok: false, error: 'unavailable' };
  if (!(await areBuddies(id, otherId))) return { ok: false, error: 'not_buddies' };
  let thread = null;
  try { const [s] = await redisPipeline([['GET', dmKey(id, otherId)]]); if (s) thread = JSON.parse(s); } catch (e) {}
  try { await redisPipeline([['HDEL', unreadKey(id), otherId]]); } catch (e) {}   // gelesen
  return { ok: true, buddy: buddyInfo(otherId, await loadMe(otherId)), messages: viewMsgs(thread, id) };
}
async function sendDm(id, otherId, text) {
  id = sid(id); otherId = sid(otherId); const t = cleanText(text);
  if (!hasStore || !id || !otherId || !t) return { ok: false, error: 'bad_request' };
  if (id === otherId) return { ok: false, error: 'self' };
  if (await isBlocked(id, otherId)) return { ok: false, error: 'blocked', message: 'Nachricht nicht möglich.' };
  if (!(await areBuddies(id, otherId))) return { ok: false, error: 'not_buddies', message: 'Ihr seid nicht verbunden.' };
  const key = dmKey(id, otherId);
  let thread = null;
  try { const [s] = await redisPipeline([['GET', key]]); if (s) thread = JSON.parse(s); } catch (e) {}
  if (!thread) { const first = id <= otherId ? id : otherId; thread = { a: first, b: first === id ? otherId : id, messages: [] }; }
  thread.messages.push({ from: id, text: t, at: Date.now() });
  if (thread.messages.length > MAX_MSGS) thread.messages = thread.messages.slice(-MAX_MSGS);
  thread.updatedAt = Date.now();
  try {
    await redisPipeline([
      ['SET', key, JSON.stringify(thread)],
      ['SADD', dmIdxKey(id), key], ['SADD', dmIdxKey(otherId), key],
      ['HINCRBY', unreadKey(otherId), id, 1],
    ]);
  } catch (e) { return { ok: false, error: 'server_error' }; }
  try { pushDm(id, otherId, t); } catch (e) {}
  return { ok: true, messages: viewMsgs(thread, id) };
}
function pushDm(fromId, toId, text) {
  if (!Push || !Push.notifyMember) return;
  loadMe(fromId).then(function (me) {
    const name = (me && me.displayName) || 'Dein Trainingspartner';
    try { Push.notifyMember(toId, 'pushSocial', { title: name, body: String(text).slice(0, 140), url: '/mitglieder?go=social' }); } catch (e) {}
  }).catch(function () {});
}
async function unreadMap(id) {
  id = sid(id); const out = {};
  try {
    const [h] = await redisPipeline([['HGETALL', unreadKey(id)]]);
    if (Array.isArray(h)) { for (let i = 0; i + 1 < h.length; i += 2) { const c = parseInt(h[i + 1], 10) || 0; if (c > 0) out[h[i]] = c; } }
    else if (h && typeof h === 'object') { Object.keys(h).forEach(function (k) { const c = parseInt(h[k], 10) || 0; if (c > 0) out[k] = c; }); }
  } catch (e) {}
  return out;
}
// Meldung an die Studio-Moderation (wird in B6 im Team-Backend ausgewertet).
async function report(id, otherId, reason) {
  id = sid(id); otherId = sid(otherId);
  if (!hasStore || !id || !otherId) return { ok: true };
  const rec = { by: id, against: otherId, reason: String(reason || '').slice(0, 500), at: Date.now() };
  try { await redisPipeline([['LPUSH', REPORTS, JSON.stringify(rec)], ['LTRIM', REPORTS, 0, 499]]); } catch (e) {}
  return { ok: true };
}

async function snapshot(id) {
  id = sid(id);
  if (!hasStore) return { ok: true, available: false };
  const me = await loadMe(id);
  if (!me || !me.enabled) return { ok: true, available: true, enabled: false };
  const [buddies, requests, unread] = await Promise.all([listBuddies(id), listRequests(id), unreadMap(id)]);
  return { ok: true, available: true, enabled: true, profile: publicMe(me), buddies: buddies, requests: requests, unread: unread };
}

module.exports = {
  MIN_AGE, MAX_BUDDIES,
  ageOk, ageFrom, initialsOf,
  enable, disable, setShare,
  connectByCode, accept, decline, removeBuddy, block, unblock,
  listBuddies, listRequests, areBuddies, isBlocked,
  getDm, sendDm, report, unreadMap,
  loadMe, snapshot,
};
