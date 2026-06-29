'use strict';

/**
 * Postfach / Vorgänge-Store (Mitglieder-Nachrichtensystem).
 * Persistenz über Upstash KV (lib/store.js). Jeder Vorgang = ein Fall mit
 * Status + Nachrichten-Thread. Mitglieder können antworten (-> E-Mail ans
 * Studio); echte Studio-Antworten im Postfach folgen später (CRM).
 *
 * Keys (pro Mitglied, memberId = Session-Kunden-ID):
 *   pf:idx:<m>      LIST der Vorgang-IDs (neueste zuerst)
 *   pf:v:<m>:<id>   JSON des Vorgangs (inkl. messages[])
 *   pf:seq:<m>      INCR-Zähler für IDs/Referenznummern
 */

const { redisPipeline, hasStore } = require('./store');

const TTL = 60 * 60 * 24 * 365;   // 1 Jahr
const MAX_LIST = 100;

const idxKey = (m) => 'pf:idx:' + m;
const vKey = (m, id) => 'pf:v:' + m + ':' + id;
const seqKey = (m) => 'pf:seq:' + m;

// Typ -> Referenz-Präfix (z. B. #K-1042)
const PREFIX = {
  kuendigung: 'K', widerruf: 'W', adresse: 'D', iban: 'B',
  kontakt: 'A', termin: 'T', pause: 'P', willkommen: '0',
  angebot: 'R', whatsapp: 'C', allgemein: 'M',
};

async function nextSeq(m) {
  if (!hasStore) return Math.floor(Math.random() * 9000) + 1000;
  const r = await redisPipeline([['INCR', seqKey(m)], ['EXPIRE', seqKey(m), String(TTL)]]);
  return Number(r && r[0]) || 1;
}

/**
 * Legt einen neuen Vorgang an.
 * opts: { type, subject, status?, systemText?, teamText?, needsAction? }
 * Liefert den Vorgang oder null (kein Store/keine memberId).
 */
async function addVorgang(memberId, opts) {
  if (!hasStore || !memberId || !opts) return null;
  const m = String(memberId);
  const seq = await nextSeq(m);
  const id = String(seq);
  const now = Date.now();
  const ref = '#' + (PREFIX[opts.type] || 'M') + '-' + String(1000 + seq);
  const messages = [];
  if (opts.systemText) messages.push({ from: 'system', text: String(opts.systemText), at: now });
  if (opts.teamText) messages.push({ from: 'team', text: String(opts.teamText), at: now + 1, needsAction: !!opts.needsAction });
  const v = {
    id, type: opts.type || 'allgemein', subject: opts.subject || 'Vorgang',
    status: opts.status || 'bearbeitung', ref,
    channel: opts.channel || 'portal',        // 'portal' | 'whatsapp' (bestimmt den Antwort-Kanal)
    phone: opts.phone || null,                 // WhatsApp-Nummer des Mitglieds (für Antworten)
    createdAt: now, updatedAt: now, unread: true, messages,
  };
  try {
    await redisPipeline([
      ['SET', vKey(m, id), JSON.stringify(v), 'EX', String(TTL)],
      ['LPUSH', idxKey(m), id],
      ['LTRIM', idxKey(m), '0', String(MAX_LIST - 1)],
      ['EXPIRE', idxKey(m), String(TTL)],
    ]);
  } catch (e) { return null; }
  return v;
}

async function list(memberId) {
  if (!hasStore || !memberId) return [];
  const m = String(memberId);
  let ids;
  try { [ids] = await redisPipeline([['LRANGE', idxKey(m), '0', String(MAX_LIST - 1)]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', vKey(m, id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function get(memberId, id) {
  if (!hasStore || !memberId || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', vKey(String(memberId), String(id))]]); }
  catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function save(memberId, v) {
  try { await redisPipeline([['SET', vKey(String(memberId), v.id), JSON.stringify(v), 'EX', String(TTL)]]); }
  catch (e) {}
  return v;
}

async function markRead(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  if (v.unread) { v.unread = false; await save(memberId, v); }
  return v;
}

async function reply(memberId, id, text) {
  const v = await get(memberId, id);
  if (!v) return null;
  const now = Date.now();
  v.messages = v.messages || [];
  v.messages.forEach((mm) => { if (mm.needsAction) mm.needsAction = false; });
  v.messages.push({ from: 'member', text: String(text || '').slice(0, 4000), at: now });
  if (v.status === 'aktion') v.status = 'bearbeitung';
  v.updatedAt = now; v.unread = false;
  await save(memberId, v);
  return v;
}

// Antwort des Studios/Teams an den Vorgang hängen (serverseitig, ohne Member-Session).
// Erscheint im Postfach als „Team"-Bubble, setzt den Vorgang auf ungelesen + beantwortet.
async function teamReply(memberId, id, text, opts) {
  opts = opts || {};
  const v = await get(memberId, id);
  if (!v) return null;
  const now = Date.now();
  v.messages = v.messages || [];
  v.messages.forEach((mm) => { if (mm.needsAction) mm.needsAction = false; });
  v.messages.push({ from: 'team', text: String(text || '').slice(0, 4000), at: now, needsAction: !!opts.needsAction });
  v.status = opts.status || 'beantwortet';
  v.updatedAt = now; v.unread = true;
  await save(memberId, v);
  return v;
}

async function resolve(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  v.status = 'abgeschlossen'; v.updatedAt = Date.now();
  await save(memberId, v);
  return v;
}

async function unreadCount(memberId) {
  const l = await list(memberId);
  return l.filter((v) => v.unread).length;
}

module.exports = { addVorgang, list, get, markRead, reply, teamReply, resolve, unreadCount, hasStore, PREFIX };
