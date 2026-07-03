'use strict';

/**
 * Mitglieder-Tags (Team-Backend): das Studio-Team markiert Mitglieder mit frei
 * wählbaren Etiketten (z. B. VIP, Beschwerde, Risiko, Stammkunde) und kann die
 * Mitgliederliste danach filtern. Persistiert über Upstash KV (REST, kein SDK).
 *
 * Datenmodell (zwei Redis-SETs):
 *   tag:m:<memberId>   SET  -> Tags dieses Mitglieds
 *   tag:idx:<tag>      SET  -> memberIds, die diesen Tag tragen (Reverse-Index für den Filter)
 *
 * Grundsatz (wie im Bestand): wirft NIE. Ohne Store -> leere Ergebnisse, keine
 * Fehler (Graceful Degradation). setTags normalisiert (trim, dedupe, Cap, Länge).
 */

const { redisPipeline, hasStore } = require('./store');

// Vorschläge zum schnellen Antippen im Profil. Freitext bleibt jederzeit möglich.
const TAG_PRESETS = ['VIP', 'Stammkunde', 'Beschwerde', 'Risiko', 'Beobachten', 'Interessent'];

const MAX_TAGS = 10;   // pro Mitglied
const MAX_LEN = 32;    // je Tag (Zeichen)

const mKey = (id) => 'tag:m:' + id;
const idxKey = (tag) => 'tag:idx:' + tag;

// Ein einzelnes Tag säubern: interne Whitespaces normalisieren, trimmen, kürzen.
function cleanTag(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

// Tag-Liste normalisieren: säubern, leere entfernen, case-insensitiv deduplizieren
// (erste Schreibweise gewinnt), auf MAX_TAGS begrenzen.
function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : (tags == null ? [] : [tags]);
  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < arr.length; i++) {
    const t = cleanTag(arr[i]);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Tags eines Mitglieds lesen (alphabetisch sortiert). Ohne Store / bei Fehler -> [].
async function getTags(memberId) {
  if (!hasStore || memberId == null) return [];
  try {
    const [members] = await redisPipeline([['SMEMBERS', mKey(memberId)]]);
    return Array.isArray(members) ? members.map(String).sort() : [];
  } catch (e) { return []; }
}

// Tags eines Mitglieds setzen (ersetzt die bisherigen) und den Reverse-Index pflegen.
// Liefert die tatsächlich gespeicherten (normalisierten) Tags. Ohne Store -> normalisierte
// Liste ohne Persistenz (kein Fehler). Wirft nie.
async function setTags(memberId, tags) {
  const next = normalizeTags(tags);
  if (!hasStore || memberId == null) return next;
  try {
    const prev = await getTags(memberId);
    const nextSet = Object.create(null); next.forEach((t) => { nextSet[t] = 1; });
    const prevSet = Object.create(null); prev.forEach((t) => { prevSet[t] = 1; });
    const cmds = [['DEL', mKey(memberId)]];
    if (next.length) cmds.push(['SADD', mKey(memberId)].concat(next));
    // Reverse-Index nur bei Differenz anfassen (entfernte Tags raus, neue rein).
    prev.forEach((t) => { if (!nextSet[t]) cmds.push(['SREM', idxKey(t), String(memberId)]); });
    next.forEach((t) => { if (!prevSet[t]) cmds.push(['SADD', idxKey(t), String(memberId)]); });
    await redisPipeline(cmds);
    return next;
  } catch (e) { return next; }
}

// memberIds, die einen bestimmten Tag tragen (für den Listen-Filter). Ohne Store -> [].
async function membersByTag(tag) {
  const t = cleanTag(tag);
  if (!hasStore || !t) return [];
  try {
    const [ids] = await redisPipeline([['SMEMBERS', idxKey(t)]]);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (e) { return []; }
}

module.exports = { TAG_PRESETS, getTags, setTags, membersByTag };
