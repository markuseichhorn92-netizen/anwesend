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

// ── Demo-/Test-Buddy (zum Ausprobieren ohne zweites Konto) ──────────────
// Ein eingebauter, virtueller Trainingspartner: Wer sich mit DEMO_CODE verbindet,
// wird sofort verbunden (der Demo-Buddy bestätigt automatisch), er antwortet im
// Chat, hat Präsenz/Statistik und macht bei Trainingsverabredungen mit. Nur zum
// Testen gedacht, solange das Feature noch nicht öffentlich ist. Vollständig
// abschaltbar über die Umgebungsvariable SOCIAL_DEMO=0 (vor dem echten Launch).
const DEMO_ON = process.env.SOCIAL_DEMO !== '0';
const DEMO_ID = 'soc-demo';
const DEMO_CODE = 'TEST99';
const DEMO_NAME = 'Demo Buddy';
function isDemo(id) { return DEMO_ON && sid(id) === DEMO_ID; }
function demoMe() { return { enabled: true, code: DEMO_CODE, displayName: DEMO_NAME, share: { streak: true, checkins: true, nutrition: true }, consentAt: 0, demo: true }; }
const DEMO_REPLIES = [
  'Stark! 💪 Ich bin gleich auch im Studio.',
  'Cool – lass uns zusammen trainieren! Wann passt es dir?',
  'Top! Heute ist bei mir Beintag. Und bei dir? 😄',
  'Weiter so, ich feuer dich an! 🔥',
  'Klingt gut! Sollen wir eine feste Zeit ausmachen?',
  'Nice! Zusammen macht’s einfach mehr Spaß. 🙌',
];

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
  id = sid(id); if (isDemo(id)) return demoMe();
  if (!hasStore || !id) return null;
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
    if (c === DEMO_CODE) continue;   // reservierter Demo-Code
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
// Deaktivieren = DSGVO-konformes Aufräumen: Code freigeben, Verbindungen/Anfragen/
// DM-Threads/Gruppen-Mitgliedschaften des Mitglieds entfernen (bei Buddys reziprok).
async function disable(id) {
  id = sid(id); const me = await loadMe(id);
  if (!me) return { ok: true };
  try {
    const conns = await membersOf(connKey(id));
    const reqIn = await membersOf(reqInKey(id));
    const reqOut = await membersOf(reqOutKey(id));
    const rooms = await membersOf(roomIdxKey(id));
    const cmds = [];
    conns.forEach(function (b) { cmds.push(['SREM', connKey(b), id], ['DEL', dmKey(id, b)], ['SREM', dmIdxKey(b), dmKey(id, b)], ['HDEL', unreadKey(b), id]); });
    reqIn.forEach(function (b) { cmds.push(['SREM', reqOutKey(b), id]); });
    reqOut.forEach(function (b) { cmds.push(['SREM', reqInKey(b), id]); });
    if (me.code) cmds.push(['DEL', codeKey(me.code)]);
    cmds.push(['DEL', connKey(id)], ['DEL', reqInKey(id)], ['DEL', reqOutKey(id)], ['DEL', blockKey(id)], ['DEL', dmIdxKey(id)], ['DEL', unreadKey(id)], ['DEL', planIdxKey(id)], ['DEL', roomUnreadKey(id)]);
    if (cmds.length) await redisPipeline(cmds);
    for (const rid of rooms) { try { await roomLeave(id, rid); } catch (e) {} }
  } catch (e) {}
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
  // Demo-Buddy: sofort verbinden (bestätigt automatisch) – zum Testen ohne zweites Konto.
  if (DEMO_ON && code === DEMO_CODE) {
    if (sid(id) === DEMO_ID) return { ok: false, error: 'self', message: 'Das ist dein eigener Code.' };
    let iBlock; try { [iBlock] = await redisPipeline([['SISMEMBER', blockKey(id), DEMO_ID]]); } catch (e) {}
    if (iBlock) return { ok: false, error: 'blocked', message: 'Du hast den Demo-Buddy blockiert. Hebe die Blockierung auf, um ihn wieder hinzuzufügen.' };
    let already; try { [already] = await redisPipeline([['SISMEMBER', connKey(id), DEMO_ID]]); } catch (e) {}
    if (!already) {
      let cnt; try { [cnt] = await redisPipeline([['SCARD', connKey(id)]]); } catch (e) {}
      if ((Number(cnt) || 0) >= MAX_BUDDIES) return { ok: false, error: 'limit', message: 'Du hast das Maximum an Trainingspartnern erreicht.' };
      await doConnect(id, DEMO_ID);
    }
    return { ok: true, status: 'connected', buddy: buddyInfo(DEMO_ID, demoMe()) };
  }
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
  return ids.map(function (b, i) { if (isDemo(b)) return buddyInfo(b, demoMe()); let bme = {}; try { bme = JSON.parse(mes[i]) || {}; } catch (e) {} return buddyInfo(b, bme); });
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
  // Demo-Buddy antwortet sofort (kein Push nötig – hat kein Gerät).
  if (isDemo(otherId)) {
    const reply = DEMO_REPLIES[thread.messages.length % DEMO_REPLIES.length];
    thread.messages.push({ from: DEMO_ID, text: reply, at: Date.now() });
    if (thread.messages.length > MAX_MSGS) thread.messages = thread.messages.slice(-MAX_MSGS);
    thread.updatedAt = Date.now();
    try { await redisPipeline([['SET', key, JSON.stringify(thread)]]); } catch (e) {}
    return { ok: true, messages: viewMsgs(thread, id) };
  }
  try { pushDm(id, otherId, t); } catch (e) {}
  return { ok: true, messages: viewMsgs(thread, id) };
}
function pushDm(fromId, toId, text) {
  if (!Push || !Push.notifyMember) return;
  loadMe(fromId).then(function (me) {
    const name = (me && me.displayName) || 'Dein Trainingspartner';
    try { Push.notifyMember(toId, 'pushSocial', { title: name, body: String(text).slice(0, 140), url: '/mitglieder?go=social&chat=' + encodeURIComponent(sid(fromId)) }); } catch (e) {}
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

// ── B3: Präsenz + geteilte Trainings-Statistik (aus Check-ins) ──
function ymd(d) { const p = x => (x < 10 ? '0' : '') + x; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
// „Jetzt im Studio" (offener Check-in < 3 h) + „heute trainiert".
function presenceOf(checkins) {
  const ci = (Array.isArray(checkins) ? checkins : []).filter(x => x && x.in && !isNaN(Date.parse(x.in)));
  const now = Date.now(), todayStr = ymd(new Date());
  let here = false, today = false;
  ci.forEach(function (x) { const inT = Date.parse(x.in); if (ymd(new Date(inT)) === todayStr) today = true; if (x.in && !x.out && (now - inT) < 3 * 3600 * 1000) here = true; });
  return { here: here, today: today };
}
// Vitalpunkte/Streak aus Check-ins (server-seitiger Nachbau der Client-Logik).
function checkinVitals(checkins, goal) {
  goal = goal || 3;
  const ci = (Array.isArray(checkins) ? checkins : []).filter(x => x && x.in && !isNaN(Date.parse(x.in)));
  const visits = ci.length;
  let points = visits * 50;
  const byWeek = {};
  ci.forEach(function (x) { const k = ymd(mondayOf(new Date(Date.parse(x.in)))); byWeek[k] = (byWeek[k] || 0) + 1; });
  const keys = Object.keys(byWeek).sort();
  if (keys.length) {
    const curM = mondayOf(new Date());
    let streak = 0, inactive = 0;
    for (let wm = new Date(keys[0] + 'T00:00:00'); wm.getTime() <= curM.getTime(); wm.setDate(wm.getDate() + 7)) {
      const cnt = byWeek[ymd(wm)] || 0;
      if (cnt > 0) { if (inactive >= 2) points -= 40 * (inactive - 1); inactive = 0; streak++; if (cnt >= goal) points += 150; if (streak % 5 === 0) points += 75; }
      else { inactive++; streak = 0; }
    }
  }
  if (points < 0) points = 0;
  const curMon = mondayOf(new Date());
  const weekVisits = ci.filter(x => new Date(Date.parse(x.in)) >= curMon).length;
  let cursor = new Date(curMon); if (!byWeek[ymd(cursor)]) cursor.setDate(cursor.getDate() - 7);
  let weekStreak = 0; while (byWeek[ymd(cursor)]) { weekStreak++; cursor.setDate(cursor.getDate() - 7); }
  return { visits: visits, points: points, weekVisits: weekVisits, weekStreak: weekStreak };
}
// Präsenz + freigegebene Statistik eines Buddys (nur was er teilt).
async function buddyDetail(myId, buddyId) {
  myId = sid(myId); buddyId = sid(buddyId);
  if (!hasStore || !myId || !buddyId) return { ok: false, error: 'unavailable' };
  if (!(await areBuddies(myId, buddyId))) return { ok: false, error: 'not_buddies' };
  // Demo-Buddy: erfundene, aber plausible Präsenz/Statistik (kein echter Check-in-Verlauf).
  if (isDemo(buddyId)) {
    return { ok: true, buddy: buddyInfo(DEMO_ID, demoMe()), share: { checkins: true, streak: true, nutrition: true },
      here: true, today: true, weekVisits: 3, weekStreak: 4, points: 1850, nutriStreak: 5 };
  }
  const bme = await loadMe(buddyId); const share = normShare(bme && bme.share);
  const out = { ok: true, buddy: buddyInfo(buddyId, bme), share: { checkins: share.checkins, streak: share.streak, nutrition: share.nutrition } };
  if (share.checkins) {
    let checkins = [];
    try { const M = require('./members'); const r = await M.recentCheckins(buddyId, { windows: 2 }); checkins = Array.isArray(r) ? r : ((r && r.checkins) || []); } catch (e) {}
    const p = presenceOf(checkins); out.here = p.here; out.today = p.today;
    const v = checkinVitals(checkins); out.weekVisits = v.weekVisits;
    if (share.streak) { out.weekStreak = v.weekStreak; out.points = v.points; }
  }
  if (share.nutrition) { out.nutriStreak = await nutriStreakOf(buddyId); }
  return out;
}
// Ernährungs-Streak eines Buddys (nur wenn freigegeben) – liest nutri:d read-only.
function dayMinus(todayStr, n) { const d = new Date(todayStr + 'T00:00:00'); d.setDate(d.getDate() - n); return ymd(d); }
async function nutriStreakOf(id) {
  id = sid(id); if (isDemo(id)) return 5; if (!hasStore) return 0;
  const today = ymd(new Date()); const keys = [];
  for (let i = 0; i < 30; i++) keys.push('nutri:d:' + id + ':' + dayMinus(today, i));
  let vals; try { vals = await redisPipeline(keys.map(k => ['GET', k])); } catch (e) { return 0; }
  const tracked = (vals || []).map(v => { try { const o = JSON.parse(v); return !!(o && Array.isArray(o.entries) && o.entries.length); } catch (e) { return false; } });
  let i = tracked[0] ? 0 : 1; if (i === 1 && !tracked[1]) return 0;
  let s = 0; while (tracked[i]) { s++; i++; } return s;
}
// „Anfeuern": kurzer Push an den Buddy (Cooldown 1/Stunde je Empfänger).
async function cheer(id, buddyId) {
  id = sid(id); buddyId = sid(buddyId); if (!hasStore || !id || !buddyId) return { ok: true };
  if (!(await areBuddies(id, buddyId)) || await isBlocked(id, buddyId)) return { ok: false, error: 'not_buddy' };
  try { const [set] = await redisPipeline([['SET', 'soc:cheer:' + id + ':' + buddyId, '1', 'NX', 'EX', '3600']]); if (!set) return { ok: true, already: true }; } catch (e) {}
  if (Push && Push.notifyMember) { loadMe(id).then(function (me) { const nm = (me && me.displayName) || 'Dein Trainingspartner'; try { Push.notifyMember(buddyId, 'pushSocial', { title: nm, body: 'feuert dich an! 💪 Auf geht\'s!', url: '/mitglieder?go=social&chat=' + encodeURIComponent(sid(id)) }); } catch (e) {} }).catch(function () {}); }
  return { ok: true };
}

// ── B3: gemeinsam trainieren (Trainingsverabredung) ──
const planKey = (a, b, date) => { const x = sid(a), y = sid(b); const p = x <= y ? (x + ':' + y) : (y + ':' + x); return 'soc:plan:' + p + ':' + date; };
const planIdxKey = (id) => 'soc:planidx:' + id;
const PLAN_TTL = String(22 * 86400);
function pushPlan(fromId, toId, date, slot) {
  if (!Push || !Push.notifyMember) return;
  loadMe(fromId).then(function (me) {
    const name = (me && me.displayName) || 'Dein Trainingspartner';
    const hh = Math.floor(slot / 60), mm = slot % 60; const t = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    try { Push.notifyMember(toId, 'pushSocial', { title: name, body: 'schlägt vor: zusammen trainieren am ' + date + ' um ' + t, url: '/mitglieder?go=social' }); } catch (e) {}
  }).catch(function () {});
}
async function proposePlan(id, buddyId, date, slot) {
  id = sid(id); buddyId = sid(buddyId); date = String(date || ''); slot = parseInt(slot, 10);
  if (!hasStore || !id || !buddyId) return { ok: false, error: 'unavailable' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  if (!(slot >= 0 && slot < 1440)) return { ok: false, error: 'bad_time' };
  if (!(await areBuddies(id, buddyId))) return { ok: false, error: 'not_buddies' };
  if (await isBlocked(id, buddyId)) return { ok: false, error: 'blocked' };
  const key = planKey(id, buddyId, date);
  // Demo-Buddy sagt sofort zu (joint automatisch).
  const rec = { by: id, buddy: buddyId, date: date, slot: slot, joined: isDemo(buddyId) ? [id, DEMO_ID] : [id], at: Date.now() };
  try { await redisPipeline([['SET', key, JSON.stringify(rec), 'EX', PLAN_TTL], ['SADD', planIdxKey(id), key], ['SADD', planIdxKey(buddyId), key]]); } catch (e) { return { ok: false, error: 'server_error' }; }
  try { pushPlan(id, buddyId, date, slot); } catch (e) {}
  return { ok: true };
}
async function joinPlan(id, buddyId, date) {
  id = sid(id); buddyId = sid(buddyId); const key = planKey(id, buddyId, String(date || ''));
  let rec = null; try { const [s] = await redisPipeline([['GET', key]]); if (s) rec = JSON.parse(s); } catch (e) {}
  if (!rec) return { ok: false, error: 'not_found' };
  if ((rec.joined || []).indexOf(id) < 0) { rec.joined = (rec.joined || []).concat([id]); try { await redisPipeline([['SET', key, JSON.stringify(rec), 'EX', PLAN_TTL]]); } catch (e) {} }
  return { ok: true };
}
async function cancelPlan(id, buddyId, date) {
  id = sid(id); buddyId = sid(buddyId); const key = planKey(id, buddyId, String(date || ''));
  try { await redisPipeline([['DEL', key], ['SREM', planIdxKey(id), key], ['SREM', planIdxKey(buddyId), key]]); } catch (e) {}
  return { ok: true };
}
async function listPlans(id) {
  id = sid(id); if (!hasStore) return [];
  const keys = await membersOf(planIdxKey(id));
  if (!keys.length) return [];
  let recs; try { recs = await redisPipeline(keys.map(k => ['GET', k])); } catch (e) { return []; }
  const today = ymd(new Date()); const out = [];
  for (let i = 0; i < keys.length; i++) {
    let r = null; try { r = JSON.parse(recs[i]); } catch (e) {}
    if (!r) { try { await redisPipeline([['SREM', planIdxKey(id), keys[i]]]); } catch (e) {} continue; }
    if (r.date < today) continue;
    const other = (sid(r.by) === id) ? sid(r.buddy) : sid(r.by);
    out.push({ date: r.date, slot: r.slot, buddy: buddyInfo(other, await loadMe(other)), joined: (r.joined || []).indexOf(id) >= 0, both: (r.joined || []).length >= 2, mine: sid(r.by) === id });
  }
  out.sort((a, b) => (a.date + String(1000 + a.slot)).localeCompare(b.date + String(1000 + b.slot)));
  return out;
}

// ── B4: Gruppen-Chat (Rooms) ──
const MAX_ROOM_MEMBERS = 12;
const roomKey = (rid) => 'soc:room:' + rid;
const roomIdxKey = (id) => 'soc:roomidx:' + id;
const roomUnreadKey = (id) => 'soc:roomunread:' + id;   // Hash { roomId -> count }
function cleanName(t) { return String(t == null ? '' : t).replace(/^\s+|\s+$/g, '').slice(0, MAX_NAME); }
function newRoomId() { return 'r' + crypto.randomBytes(9).toString('hex'); }
async function loadRoom(rid) { if (!hasStore || !rid) return null; try { const [s] = await redisPipeline([['GET', roomKey(sid(rid))]]); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function inRoom(room, id) { return !!(room && Array.isArray(room.members) && room.members.indexOf(sid(id)) >= 0); }
async function nameMapFor(memberIds) {
  const out = {}; if (!memberIds || !memberIds.length) return out;
  let mes; try { mes = await redisPipeline(memberIds.map(m => ['GET', meKey(sid(m))])); } catch (e) { mes = []; }
  memberIds.forEach(function (m, i) { if (isDemo(m)) { out[sid(m)] = DEMO_NAME; return; } let bme = {}; try { bme = JSON.parse(mes[i]) || {}; } catch (e) {} out[sid(m)] = bme.displayName || 'Mitglied'; });
  return out;
}
function roomView(room, id, nameMap) {
  const arr = (room && Array.isArray(room.messages)) ? room.messages : [];
  return arr.map(function (m) { const nm = nameMap[sid(m.from)] || 'Mitglied'; return { mine: sid(m.from) === sid(id), name: nm, initials: initialsOf(nm), text: m.text, at: m.at }; });
}
function pushRoom(fromId, memberIds, name, text, roomId) {
  if (!Push || !Push.notifyMember) return;
  const url = '/mitglieder?go=social' + (roomId ? ('&room=' + encodeURIComponent(sid(roomId))) : '');
  loadMe(fromId).then(function (me) {
    const nm = (me && me.displayName) || 'Trainingspartner';
    (memberIds || []).forEach(function (mid) { if (sid(mid) === sid(fromId)) return; try { Push.notifyMember(mid, 'pushSocial', { title: name || 'Gruppe', body: text || (nm + ': neue Nachricht'), url: url }); } catch (e) {} });
  }).catch(function () {});
}
async function createRoom(id, name, memberIds) {
  id = sid(id); if (!hasStore || !id) return { ok: false, error: 'unavailable' };
  name = cleanName(name) || 'Trainingsgruppe';
  const ids = Array.isArray(memberIds) ? memberIds.map(sid).filter(Boolean) : [];
  const valid = [];
  for (const bId of ids) { if (bId === id || valid.indexOf(bId) >= 0) continue; if ((await areBuddies(id, bId)) && !(await isBlocked(id, bId))) valid.push(bId); }
  if (!valid.length) return { ok: false, error: 'no_members', message: 'Wähle mindestens einen Trainingspartner.' };
  const members = [id].concat(valid).slice(0, MAX_ROOM_MEMBERS);
  const rid = newRoomId();
  const room = { id: rid, name: name, owner: id, members: members, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  const cmds = [['SET', roomKey(rid), JSON.stringify(room)]];
  members.forEach(m => cmds.push(['SADD', roomIdxKey(m), rid]));
  try { await redisPipeline(cmds); } catch (e) { return { ok: false, error: 'server_error' }; }
  try { pushRoom(id, members, name, 'Du wurdest zur Gruppe „' + name + '" hinzugefügt.', rid); } catch (e) {}
  return { ok: true, roomId: rid };
}
async function roomInvite(id, rid, buddyId) {
  id = sid(id); rid = sid(rid); buddyId = sid(buddyId);
  const room = await loadRoom(rid);
  if (!room || !inRoom(room, id)) return { ok: false, error: 'not_member' };
  if (!(await areBuddies(id, buddyId)) || await isBlocked(id, buddyId)) return { ok: false, error: 'not_buddy' };
  if (inRoom(room, buddyId)) return { ok: true };
  if (room.members.length >= MAX_ROOM_MEMBERS) return { ok: false, error: 'full', message: 'Die Gruppe ist voll.' };
  room.members.push(buddyId); room.updatedAt = Date.now();
  try { await redisPipeline([['SET', roomKey(rid), JSON.stringify(room)], ['SADD', roomIdxKey(buddyId), rid]]); } catch (e) { return { ok: false, error: 'server_error' }; }
  try { pushRoom(id, [buddyId], room.name, 'Du wurdest zur Gruppe „' + room.name + '" hinzugefügt.', rid); } catch (e) {}
  return { ok: true };
}
async function roomLeave(id, rid) {
  id = sid(id); rid = sid(rid); const room = await loadRoom(rid);
  if (!room) return { ok: true };
  room.members = (room.members || []).filter(m => sid(m) !== id); room.updatedAt = Date.now();
  const cmds = [['SREM', roomIdxKey(id), rid], ['HDEL', roomUnreadKey(id), rid]];
  if (!room.members.length) cmds.unshift(['DEL', roomKey(rid)]);
  else cmds.unshift(['SET', roomKey(rid), JSON.stringify(room)]);
  try { await redisPipeline(cmds); } catch (e) {}
  return { ok: true };
}
async function roomSend(id, rid, text) {
  id = sid(id); rid = sid(rid); const t = cleanText(text);
  if (!hasStore || !id || !rid || !t) return { ok: false, error: 'bad_request' };
  const room = await loadRoom(rid);
  if (!room || !inRoom(room, id)) return { ok: false, error: 'not_member' };
  room.messages.push({ from: id, text: t, at: Date.now() });
  if (room.messages.length > MAX_MSGS) room.messages = room.messages.slice(-MAX_MSGS);
  room.updatedAt = Date.now();
  const cmds = [['SET', roomKey(rid), JSON.stringify(room)]];
  room.members.forEach(function (m) { if (sid(m) !== id) cmds.push(['HINCRBY', roomUnreadKey(sid(m)), rid, 1]); });
  try { await redisPipeline(cmds); } catch (e) { return { ok: false, error: 'server_error' }; }
  try { const nameMap = await nameMapFor([id]); pushRoom(id, room.members, room.name, (nameMap[id] || 'Jemand') + ': ' + t.slice(0, 120), rid); } catch (e) {}
  // Ist der Demo-Buddy in der Gruppe, antwortet er kurz (zum Testen des Gruppen-Chats).
  if (DEMO_ON && room.members.indexOf(DEMO_ID) >= 0 && sid(id) !== DEMO_ID) {
    const reply = DEMO_REPLIES[room.messages.length % DEMO_REPLIES.length];
    room.messages.push({ from: DEMO_ID, text: reply, at: Date.now() });
    if (room.messages.length > MAX_MSGS) room.messages = room.messages.slice(-MAX_MSGS);
    room.updatedAt = Date.now();
    const c2 = [['SET', roomKey(rid), JSON.stringify(room)]];
    room.members.forEach(function (m) { if (sid(m) !== DEMO_ID && sid(m) !== id) c2.push(['HINCRBY', roomUnreadKey(sid(m)), rid, 1]); });
    try { await redisPipeline(c2); } catch (e) {}
  }
  const nm = await nameMapFor(room.members);
  return { ok: true, messages: roomView(room, id, nm) };
}
async function getRoom(id, rid) {
  id = sid(id); rid = sid(rid); const room = await loadRoom(rid);
  if (!room || !inRoom(room, id)) return { ok: false, error: 'not_member' };
  try { await redisPipeline([['HDEL', roomUnreadKey(id), rid]]); } catch (e) {}
  const nm = await nameMapFor(room.members);
  const members = room.members.map(function (m) { const name = nm[sid(m)] || 'Mitglied'; return { id: sid(m), name: name, initials: initialsOf(name) }; });
  return { ok: true, room: { id: room.id, name: room.name, owner: sid(room.owner) === id, memberCount: room.members.length, members: members }, messages: roomView(room, id, nm) };
}
async function roomUnreadMap(id) {
  id = sid(id); const out = {};
  try { const [h] = await redisPipeline([['HGETALL', roomUnreadKey(id)]]);
    if (Array.isArray(h)) { for (let i = 0; i + 1 < h.length; i += 2) { const c = parseInt(h[i + 1], 10) || 0; if (c > 0) out[h[i]] = c; } }
    else if (h && typeof h === 'object') { Object.keys(h).forEach(function (k) { const c = parseInt(h[k], 10) || 0; if (c > 0) out[k] = c; }); }
  } catch (e) {}
  return out;
}
async function listRooms(id) {
  id = sid(id); if (!hasStore) return [];
  const rids = await membersOf(roomIdxKey(id));
  if (!rids.length) return [];
  let raw; try { raw = await redisPipeline(rids.map(r => ['GET', roomKey(r)])); } catch (e) { return []; }
  const unread = await roomUnreadMap(id); const out = [];
  for (let i = 0; i < rids.length; i++) {
    let room = null; try { room = JSON.parse(raw[i]); } catch (e) {}
    if (!room || !inRoom(room, id)) { try { await redisPipeline([['SREM', roomIdxKey(id), rids[i]]]); } catch (e) {} continue; }
    const msgs = room.messages || []; const last = msgs.length ? msgs[msgs.length - 1] : null;
    out.push({ id: room.id, name: room.name, memberCount: (room.members || []).length, unread: unread[room.id] || 0, updatedAt: room.updatedAt || 0, lastText: last ? String(last.text).slice(0, 60) : '' });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// ── B6: Studio-Notaus (globaler Kill-Switch), Sperre einzelner Mitglieder, Meldungen, Export ──
const ENABLED_KEY = 'soc:enabled';      // '0' = global aus
const BANNED_SET = 'soc:banned';        // SET gesperrter Mitglieder
async function socialEnabled() { if (!hasStore) return true; try { const [v] = await redisPipeline([['GET', ENABLED_KEY]]); return v !== '0'; } catch (e) { return true; } }
async function setSocialEnabled(on) { try { await redisPipeline([['SET', ENABLED_KEY, on ? '1' : '0']]); } catch (e) {} return { ok: true, enabled: !!on }; }
async function isBanned(id) { id = sid(id); if (!hasStore || !id) return false; try { const [v] = await redisPipeline([['SISMEMBER', BANNED_SET, id]]); return !!v; } catch (e) { return false; } }
async function setBan(id, on) {
  id = sid(id); if (!hasStore || !id) return { ok: true };
  try { if (on) await redisPipeline([['SADD', BANNED_SET, id]]); else await redisPipeline([['SREM', BANNED_SET, id]]); } catch (e) {}
  if (on) { try { await disable(id); } catch (e) {} }   // Sperre räumt die Social-Daten mit auf
  return { ok: true };
}
async function listBanned() {
  if (!hasStore) return [];
  const ids = await membersOf(BANNED_SET);
  return decorate(ids);
}
async function listReports(limit) {
  if (!hasStore) return [];
  let raw; try { [raw] = await redisPipeline([['LRANGE', REPORTS, 0, (limit || 50) - 1]]); } catch (e) { return []; }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    let r = null; try { r = JSON.parse(s); } catch (e) {}
    if (!r) continue;
    const by = await loadMe(r.by), ag = await loadMe(r.against);
    out.push({ by: { id: sid(r.by), name: (by && by.displayName) || '—' }, against: { id: sid(r.against), name: (ag && ag.displayName) || '—' }, reason: r.reason || '', at: r.at || 0 });
  }
  return out;
}
async function clearReports() { try { await redisPipeline([['DEL', REPORTS]]); } catch (e) {} return { ok: true }; }
// DSGVO-Auskunft: die eigenen Social-Daten (für den Datenexport des Mitglieds).
async function socialExport(id) {
  id = sid(id); const me = await loadMe(id);
  if (!me) return { enabled: false };
  const [buddies, rooms] = await Promise.all([listBuddies(id), listRooms(id)]);
  return { enabled: !!me.enabled, consentAt: me.consentAt || null, displayName: me.displayName || null, share: normShare(me.share), code: me.code || null, buddyCount: buddies.length, buddies: buddies.map(b => b.name), groupCount: rooms.length };
}

async function snapshot(id) {
  id = sid(id);
  if (!hasStore) return { ok: true, available: false };
  const me = await loadMe(id);
  if (!me || !me.enabled) return { ok: true, available: true, enabled: false };
  const [buddies, requests, unread, plans, rooms] = await Promise.all([listBuddies(id), listRequests(id), unreadMap(id), listPlans(id), listRooms(id)]);
  return { ok: true, available: true, enabled: true, profile: publicMe(me), buddies: buddies, requests: requests, unread: unread, plans: plans, rooms: rooms, demoCode: DEMO_ON ? DEMO_CODE : null };
}

module.exports = {
  MIN_AGE, MAX_BUDDIES,
  ageOk, ageFrom, initialsOf,
  enable, disable, setShare,
  connectByCode, accept, decline, removeBuddy, block, unblock,
  listBuddies, listRequests, areBuddies, isBlocked,
  getDm, sendDm, report, unreadMap,
  buddyDetail, proposePlan, joinPlan, cancelPlan, listPlans,
  createRoom, roomInvite, roomLeave, roomSend, getRoom, listRooms,
  nutriStreakOf, cheer,
  socialEnabled, setSocialEnabled, isBanned, setBan, listBanned, listReports, clearReports, socialExport,
  loadMe, snapshot,
};
