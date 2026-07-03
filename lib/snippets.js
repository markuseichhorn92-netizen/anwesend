'use strict';

/**
 * Textbaustein-Store (Team-Backend -> Antwort-Komposition im Posteingang).
 * Vom Team gepflegte Schnellantworten ("Textbausteine"), persistiert über Upstash KV.
 * Die Bausteine werden beim Antworten in den Entwurf (#draft) eingefügt.
 *
 * Ersetzt die bisher fest im Frontend (team-backend.html, var TEMPLATES) stehenden
 * Vorlagen durch editierbare, persistente und erweiterbare Einträge.
 *
 * Keys:
 *   snip:idx        SET der Baustein-IDs
 *   snip:<id>       JSON des Bausteins
 *   snip:seq        INCR-Zähler für IDs
 *   snip:seeded     Flag: Standard-Bausteine bereits angelegt
 *
 * Baustein: { id, text, order, createdAt, updatedAt }
 *
 * Grundsatz (wie im Bestand): wirft NIE. Ohne Store -> DEFAULTS als Fallback,
 * damit die Schnellantworten auch ohne KV/Upstash nutzbar bleiben.
 */

const { redisPipeline, hasStore } = require('./store');

// Standard-Bausteine — identisch zu den bisher fest im Frontend (team-backend.html,
// `var TEMPLATES`) hinterlegten Schnellantworten. Dienen als Seed für den Store und
// als Fallback ohne Store (Graceful Degradation).
const DEFAULTS = [
  'Vielen Dank für deine Nachricht! Wir kümmern uns darum und melden uns zeitnah bei dir.',
  'Gerne kannst du dazu direkt bei uns an der Theke vorbeikommen – wir helfen dir sofort weiter.',
  'Deinen Vorgang haben wir aufgenommen und bearbeiten ihn schnellstmöglich. Wir geben dir Bescheid, sobald es Neuigkeiten gibt.',
  'Kein Problem – wir haben das für dich erledigt. Melde dich jederzeit, wenn du noch etwas brauchst.',
];

const IDX = 'snip:idx';
const SEQ = 'snip:seq';
const SEEDED = 'snip:seeded';
const sKey = (id) => 'snip:' + id;
const MAX_LEN = 1000;   // Textlänge begrenzen

// Text säubern + auf Maximallänge kürzen.
function clean(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim().slice(0, MAX_LEN);
}

// DEFAULTS als Fallback-Liste (ohne Store) im {id,text,order}-Format.
function defaultList() {
  return DEFAULTS.map((text, i) => ({ id: 'd' + (i + 1), text: text, order: i }));
}

// Nur die für das Frontend relevanten Felder zurückgeben.
function publicSnippet(s) {
  return { id: s.id, text: s.text, order: Number(s.order) || 0 };
}

async function nextId() {
  const r = await redisPipeline([['INCR', SEQ]]);
  return 's' + (Number(r && r[0]) || 1);
}

// Alle Bausteine roh aus dem Store lesen, sortiert nach order (dann createdAt).
async function readAll() {
  let ids;
  try { [ids] = await redisPipeline([['SMEMBERS', IDX]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', sKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  out.sort((a, b) => ((Number(a.order) || 0) - (Number(b.order) || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)));
  return out;
}

// Standard-Bausteine einmalig in den Store schreiben (idempotent via Flag snip:seeded).
// So sind die eingebauten Vorlagen im Team-Backend sichtbar/bearbeitbar.
async function seedDefaults() {
  if (!hasStore) return;
  let flag, ids;
  try { [flag, ids] = await redisPipeline([['GET', SEEDED], ['SMEMBERS', IDX]]); }
  catch (e) { return; }
  if (flag) return;
  if (Array.isArray(ids) && ids.length) { try { await redisPipeline([['SET', SEEDED, '1']]); } catch (e) {} return; }
  try { await redisPipeline([['SET', SEEDED, '1']]); } catch (e) {}   // zuerst sperren (gegen Doppel-Seed)
  const now = Date.now();
  for (let i = 0; i < DEFAULTS.length; i++) {
    try {
      const id = await nextId();
      const snip = { id: id, text: clean(DEFAULTS[i]), order: i, createdAt: now + i, updatedAt: now + i };
      await redisPipeline([['SET', sKey(id), JSON.stringify(snip)], ['SADD', IDX, id]]);
    } catch (e) {}
  }
}

// Liste aller Bausteine. Ohne Store -> DEFAULTS. Beim ersten Aufruf mit Store werden
// die DEFAULTS geseedet. Ein bewusst geleerter Store liefert eine leere Liste.
async function listSnippets() {
  if (!hasStore) return defaultList();
  try { await seedDefaults(); } catch (e) {}
  const all = await readAll();
  return all.map(publicSnippet);
}

// Neuen Baustein anlegen. Liefert den neuen Eintrag oder null (leerer Text / kein Store).
async function addSnippet(text) {
  const t = clean(text);
  if (!t || !hasStore) return null;
  try { await seedDefaults(); } catch (e) {}
  try {
    const all = await readAll();
    const maxOrder = all.reduce((m, s) => Math.max(m, Number(s.order) || 0), -1);
    const id = await nextId();
    const now = Date.now();
    const snip = { id: id, text: t, order: maxOrder + 1, createdAt: now, updatedAt: now };
    await redisPipeline([['SET', sKey(id), JSON.stringify(snip)], ['SADD', IDX, id]]);
    return publicSnippet(snip);
  } catch (e) { return null; }
}

// Baustein bearbeiten. Liefert den aktualisierten Eintrag oder null.
async function updateSnippet(id, text) {
  const t = clean(text);
  if (!hasStore || !id || !t) return null;
  try { await seedDefaults(); } catch (e) {}
  try {
    const [s] = await redisPipeline([['GET', sKey(id)]]);
    if (!s) return null;
    let snip; try { snip = JSON.parse(s); } catch (e) { return null; }
    snip.text = t;
    snip.updatedAt = Date.now();
    await redisPipeline([['SET', sKey(id), JSON.stringify(snip)]]);
    return publicSnippet(snip);
  } catch (e) { return null; }
}

// Baustein löschen. Liefert true bei Erfolg.
async function deleteSnippet(id) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['DEL', sKey(id)], ['SREM', IDX, id]]); return true; }
  catch (e) { return false; }
}

module.exports = { listSnippets, addSnippet, updateSnippet, deleteSnippet, hasStore, DEFAULTS };
