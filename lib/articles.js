'use strict';

/**
 * Hilfe-Artikel-Store (Team-Backend -> Mitgliederbereich).
 * Vom Team gepflegte Wissensdatenbank, persistiert über Upstash KV.
 * Veröffentlichte Artikel werden im Mitgliederbereich angezeigt (api/articles.js).
 *
 * Keys:
 *   art:idx        SET der Artikel-IDs
 *   art:<id>       JSON des Artikels
 *   art:seq        INCR-Zähler für IDs
 *
 * Artikel: { id, title, cat, status, body, views, helpfulYes, helpfulNo, createdAt, updatedAt }
 *   cat    = 'mitglied' | 'training' | 'studio' | 'abrechnung'
 *   status = 'veröffentlicht' | 'entwurf'
 */

const { redisPipeline, hasStore } = require('./store');

const IDX = 'art:idx';
const SEQ = 'art:seq';
const aKey = (id) => 'art:' + id;
const CATS = ['mitglied', 'training', 'studio', 'abrechnung'];
const STATUSES = ['veröffentlicht', 'entwurf'];

// Kategorie-Schlüssel -> deutsches Label (für den Mitgliederbereich).
const CAT_LABEL = { mitglied: 'Mitgliedschaft', training: 'Training', studio: 'Studio', abrechnung: 'Abrechnung' };

async function nextId() {
  const r = await redisPipeline([['INCR', SEQ]]);
  return 'a' + (Number(r && r[0]) || 1);
}

async function list() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', aKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function listPublished() {
  return (await list()).filter((a) => a.status === 'veröffentlicht');
}

async function get(id) {
  if (!hasStore || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', aKey(id)]]); }
  catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Anlegen (ohne art.id) oder Aktualisieren (mit art.id).
async function save(art) {
  if (!hasStore || !art) return null;
  const now = Date.now();
  let a; let isNew = false;
  if (art.id) { a = await get(art.id) || { id: art.id, createdAt: now, views: 0, helpfulYes: 0, helpfulNo: 0 }; if (!a.createdAt) { isNew = true; a.createdAt = now; } }
  else { a = { id: await nextId(), createdAt: now, views: 0, helpfulYes: 0, helpfulNo: 0 }; isNew = true; }

  if (art.title != null) a.title = String(art.title).slice(0, 200);
  if (art.body != null) a.body = String(art.body).slice(0, 20000);
  if (CATS.indexOf(art.cat) >= 0) a.cat = art.cat;
  if (STATUSES.indexOf(art.status) >= 0) a.status = art.status;
  a.title = a.title || ''; a.body = a.body || ''; a.cat = a.cat || 'mitglied'; a.status = a.status || 'entwurf';
  a.views = a.views || 0; a.helpfulYes = a.helpfulYes || 0; a.helpfulNo = a.helpfulNo || 0;
  a.updatedAt = now;

  try {
    const cmds = [['SET', aKey(a.id), JSON.stringify(a)]];
    if (isNew) cmds.push(['SADD', IDX, a.id]);
    await redisPipeline(cmds);
  } catch (e) { return null; }
  return a;
}

async function setStatus(id, status) {
  if (STATUSES.indexOf(status) < 0) return null;
  const a = await get(id); if (!a) return null;
  a.status = status; a.updatedAt = Date.now();
  try { await redisPipeline([['SET', aKey(a.id), JSON.stringify(a)]]); } catch (e) {}
  return a;
}

async function remove(id) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['DEL', aKey(id)], ['SREM', IDX, id]]); return true; }
  catch (e) { return false; }
}

// Aufruf zählen (ohne updatedAt-Reorder).
async function incrView(id) {
  const a = await get(id); if (!a) return null;
  a.views = (a.views || 0) + 1;
  try { await redisPipeline([['SET', aKey(a.id), JSON.stringify(a)]]); } catch (e) {}
  return a;
}

// Hilfreich-Bewertung.
async function vote(id, helpful) {
  const a = await get(id); if (!a) return null;
  if (helpful) a.helpfulYes = (a.helpfulYes || 0) + 1; else a.helpfulNo = (a.helpfulNo || 0) + 1;
  try { await redisPipeline([['SET', aKey(a.id), JSON.stringify(a)]]); } catch (e) {}
  return a;
}

module.exports = { list, listPublished, get, save, setStatus, remove, incrView, vote, hasStore, CATS, CAT_LABEL };
