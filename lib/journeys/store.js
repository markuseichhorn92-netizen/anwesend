'use strict';

/**
 * FINN Journeys – Zustand je Person („Subjekt").
 * -----------------------------------------------------------------------------
 * Subjekt = Magicline-Kunden-Id (Mitglied, z. B. "12345") oder Lead-Id ("L17").
 * Die Kunden-Id steht als eigenes Schlüsselsegment im Schlüssel, damit Export und
 * Löschung (lib/privacy, Präfix "jr:") die Daten finden.
 *
 *   jr:st:<subj>   { subj, kind, cid, leadId, phone, firstName, inbox, facts:{…},
 *                    runs:{ <journey>: { startedAt, done:{step:{at,r}}, defer:{step:ts}, exit } },
 *                    sent:[{at,j,s,cat,via}], createdAt, updatedAt }
 *   jr:ph:<nummer> -> subj (Mitglied schlägt Lead)
 *   jr:due         ZSET subj -> nächster fälliger Zeitpunkt (ms)
 *   jr:idx         ZSET Kunden-Id -> zuletzt gesehen (ms) – eigener Kandidaten-Index,
 *                  gefüllt aus Webhooks. KEIN Mitgliederverzeichnis (MEMBER_LIST_READ).
 */

const KV = require('../finn/kv');
const Phone = require('../phone');

const ST_TTL = 400 * 86400;
const PH_TTL = 400 * 86400;
const SENT_CAP = 40;
const IDX_CAP = 5000;
const IDX_MAX_AGE = 180 * 86400 * 1000;

const SK = (s) => 'jr:st:' + String(s);
const PK = (p) => 'jr:ph:' + p;
const DUE = 'jr:due';
const IDX = 'jr:idx';
const MEM = 'jr:mem';

function isMemberId(s) { return /^[0-9]{1,12}$/.test(String(s || '')); }
function isLeadId(s) { return /^L[0-9]{1,9}$/.test(String(s || '')); }
function validSubj(s) { return isMemberId(s) || isLeadId(s); }

function blank(subj) {
  const member = isMemberId(subj);
  return { subj: String(subj), kind: member ? 'member' : 'lead', cid: member ? String(subj) : null, leadId: member ? null : String(subj), phone: null, firstName: null, inbox: member ? String(subj) : null, facts: {}, runs: {}, sent: [], createdAt: Date.now(), updatedAt: Date.now() };
}

async function load(subj) {
  if (!validSubj(subj)) return null;
  return KV.getJSON(SK(subj));
}
async function loadOrCreate(subj) {
  if (!validSubj(subj)) return null;
  return (await load(subj)) || blank(subj);
}
async function save(st) {
  if (!st || !validSubj(st.subj)) return false;
  st.updatedAt = Date.now();
  if (Array.isArray(st.sent) && st.sent.length > SENT_CAP) st.sent = st.sent.slice(-SENT_CAP);
  return !!(await KV.set(SK(st.subj), st, ST_TTL));
}

async function forPhone(phone) {
  const p = Phone.canon(phone); if (!p) return null;
  const s = await KV.get(PK(p));
  return s && validSubj(s) ? String(s) : null;
}
// Nummer einem Subjekt zuordnen. Ein Mitglied verdrängt einen Lead, nie umgekehrt.
async function linkPhone(phone, subj) {
  const p = Phone.canon(phone); if (!p || !validSubj(subj)) return false;
  const cur = await forPhone(p);
  if (cur && cur !== String(subj) && isMemberId(cur) && isLeadId(subj)) return false;
  const ok = !!(await KV.set(PK(p), String(subj), PH_TTL));
  if (ok && isMemberId(subj)) await KV.zadd(MEM, Date.now(), String(subj));
  return ok;
}
// Mitglieder mit bekannter WhatsApp-Nummer – die Menge, über die der Tagesdurchlauf läuft.
async function memberPage(offset, count) { return KV.zrevrange(MEM, offset || 0, (offset || 0) + (count || 50) - 1); }
async function memberCount() { return KV.zcard(MEM); }

async function schedule(subj, at) {
  if (!validSubj(subj)) return false;
  if (at == null || !isFinite(at)) return KV.zrem(DUE, String(subj));
  return KV.zadd(DUE, Math.round(at), String(subj));
}
async function unschedule(subj) { return KV.zrem(DUE, String(subj)); }
async function due(now, limit) { return KV.zrangeByScore(DUE, '-inf', String(Math.round(now || Date.now())), limit || 50); }
async function dueCount() { return KV.zcard(DUE); }

// Kandidaten-Index: nur Kunden-Ids, die wir selbst gesehen haben.
async function index(cid, at) {
  if (!isMemberId(cid)) return false;
  return KV.zadd(IDX, Math.round(at || Date.now()), String(cid));
}
async function indexSize() { return KV.zcard(IDX); }
async function indexPage(offset, count) { return KV.zrevrange(IDX, offset || 0, (offset || 0) + (count || 50) - 1); }
async function pruneIndex(now) {
  await KV.zremRangeByScore(IDX, '-inf', String((now || Date.now()) - IDX_MAX_AGE));
  await KV.ztrimTop(IDX, IDX_CAP);
}

// Löschung der App-Daten eines Mitglieds (lib/privacy.deleteAppData).
async function erase(cid) {
  if (!isMemberId(cid)) return { ok: false };
  const st = await load(cid);
  const phones = new Set();
  if (st && st.phone) phones.add(st.phone);
  const Consent = require('./consent');
  for (const p of phones) {
    const linked = await forPhone(p);
    if (linked === String(cid)) await KV.del(PK(p));
    await Consent.erase(p);
    await KV.del('jr:win:' + p); await KV.del('jr:ask:' + p); await KV.del('jr:last:' + p);
  }
  await KV.zrem(DUE, String(cid)); await KV.zrem(IDX, String(cid)); await KV.zrem(MEM, String(cid));
  await KV.del(SK(cid)); await KV.del('jr:eng:' + cid);
  try { await require('./sendlog').eraseSubj(String(cid)); } catch (e) {}
  return { ok: true, phones: phones.size };
}

module.exports = {
  ST_TTL, SK, DUE, IDX, MEM, IDX_CAP, isMemberId, isLeadId, validSubj, blank,
  load, loadOrCreate, save, forPhone, linkPhone, memberPage, memberCount, schedule, unschedule, due, dueCount,
  index, indexSize, indexPage, pruneIndex, erase,
};
