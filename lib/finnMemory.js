'use strict';

/**
 * FINN-Langzeitgedächtnis pro Mitglied (Opt-in, datensparsam).
 * -------------------------------------------------------------------------
 * FINN darf sich sitzungsübergreifend das WESENTLICHE über ein Mitglied merken
 * (Ziel, Erfahrung, Vorlieben/Abneigungen, wichtige Einschränkung, Meilenstein)
 * – KEIN Voll-Transkript. Die Fakten fließen als kompakter Kontext in FINNs
 * System-Prompt (siehe api/member/coach.js → memberDetails/coachReply).
 *
 * Erfassung: FINN hängt an seine Antwort einen unsichtbaren Marker
 *   [[merke: <kurzer Fakt>]]
 * an; der Server parst ihn (extractMemos), entfernt ihn aus der sichtbaren
 * Antwort und speichert den Fakt – ABER nur, wenn das Mitglied das Gedächtnis
 * aktiviert hat (Opt-in, Standard AUS).
 *
 * Key:  finn:mem:<memberId>   JSON { v, on:boolean, items:[{t,ts}] }
 *       TTL wird bei jedem Schreiben erneuert → wirklich inaktive Gedächtnisse
 *       verblassen von selbst (Datenminimierung).
 *
 * WICHTIG: Ohne aktiviertes Opt-in wird NICHTS gespeichert. Wird das Opt-in
 * abgeschaltet, werden die gemerkten Fakten sofort gelöscht („aus = vergessen").
 * Ohne konfigurierten KV-Store degradiert alles sauber zum No-Op.
 */

const { redisPipeline, hasStore } = require('./store');

const MAX_ITEMS = 12;                 // höchstens so viele gemerkte Fakten (LRU)
const MAX_LEN = 140;                  // Zeichen je Fakt
const MAX_PER_TURN = 3;               // höchstens so viele neue Fakten pro Antwort
const TTL = 400 * 24 * 3600;          // ~13 Monate, bei jedem Schreiben erneuert
const MKEY = (id) => 'finn:mem:' + String(id);

// ── Reine Logik (ohne KV – voll unit-testbar) ──

// Einen Fakt säubern: Zeilenumbrüche/Steuerzeichen raus, trimmen, kappen.
function cleanFact(s) {
  const t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN).trim();
  return t.length >= 3 ? t : '';
}

// [[merke: …]]-Marker aus einer FINN-Antwort ziehen und aus dem Text entfernen.
// Gibt { text, memos:[...] } zurück (memos gesäubert + auf MAX_PER_TURN begrenzt).
function extractMemos(answer) {
  const memos = [];
  const text = String(answer || '')
    .replace(/\[\[\s*merke\s*:\s*([^\]]+?)\s*\]\]/gi, (mm, fact) => {
      const c = cleanFact(fact);
      if (c && memos.length < MAX_PER_TURN) memos.push(c);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, memos };
}

// Neue Fakten in die vorhandene Liste einpflegen: dedupliziert (case-insensitive),
// bekannte Fakten werden „aufgefrischt" (ts=now), Liste bleibt auf MAX_ITEMS (LRU).
function mergeItems(existing, incoming, now) {
  const out = Array.isArray(existing) ? existing.map((x) => ({ t: cleanFact(x && x.t), ts: Number(x && x.ts) || 0 })).filter((x) => x.t) : [];
  const key = (s) => cleanFact(s).toLowerCase();
  (Array.isArray(incoming) ? incoming : []).forEach((raw) => {
    const c = cleanFact(raw); if (!c) return;
    const k = c.toLowerCase();
    const idx = out.findIndex((x) => key(x.t) === k);
    if (idx >= 0) out[idx].ts = now;                 // schon bekannt → nur auffrischen
    else out.push({ t: c, ts: now });
  });
  // LRU: neueste MAX_ITEMS behalten
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-MAX_ITEMS);
}

// Kompakter Prompt-Block aus dem Gedächtnis (nur wenn aktiviert + vorhanden).
function toPromptText(mem) {
  if (!mem || !mem.on || !Array.isArray(mem.items) || !mem.items.length) return '';
  const lines = mem.items.map((x) => '– ' + cleanFact(x && x.t)).filter((l) => l.length > 2);
  if (!lines.length) return '';
  return 'Was du dir aus früheren Gesprächen über dieses Mitglied gemerkt hast '
    + '(vertraulich, gilt NUR für die angemeldete Person):\n' + lines.join('\n');
}

// Anweisung an FINN, dauerhafte Fakten zu merken (nur wenn Opt-in an) – kommt in
// den DYNAMISCHEN (nicht gecachten) Prompt-Teil, damit der Cache-Vorspann stabil bleibt.
const MEMO_DIRECTIVE = 'Wenn im Gespräch ein DAUERHAFT nützlicher Fakt über dieses Mitglied auftaucht '
  + '(Ziel, Trainingserfahrung, Vorlieben/Abneigungen, wichtige Einschränkung wie „Knie schonen", Meilenstein), '
  + 'darfst du ihn dir merken: hänge ans ENDE deiner Antwort genau einen unsichtbaren Marker [[merke: <Fakt in höchstens 12 Wörtern>]] an. '
  + 'Nur wirklich Dauerhaftes, sparsam (meist gar nicht), keine sensiblen Gesundheitsdiagnosen. Bereits Gemerktes NICHT erneut als Marker anhängen.';

// ── KV-gebundene Operationen (No-Op ohne Store) ──

function normalize(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const items = Array.isArray(o.items) ? o.items.map((x) => ({ t: cleanFact(x && x.t), ts: Number(x && x.ts) || 0 })).filter((x) => x.t) : [];
  return { on: !!o.on, items: items, decided: !!o.decided };
}

async function get(id) {
  if (!hasStore || !id) return { on: false, items: [], decided: false };
  try {
    const [v] = await redisPipeline([['GET', MKEY(id)]]);
    if (!v) return { on: false, items: [], decided: false };
    return normalize(typeof v === 'string' ? JSON.parse(v) : v);
  } catch (e) { return { on: false, items: [], decided: false }; }
}

async function save(id, state) {
  if (!hasStore || !id) return state;
  const clean = normalize(state);
  try {
    await redisPipeline([['SET', MKEY(id), JSON.stringify({ v: 1, on: clean.on, items: clean.items, decided: clean.decided })]]);
    try { await redisPipeline([['EXPIRE', MKEY(id), String(TTL)]]); } catch (e) {}
  } catch (e) {}
  return clean;
}

// Opt-in setzen (Ja ODER Nein zählt als getroffene Entscheidung → keine erneute Nachfrage).
// AUS ⇒ gemerkte Fakten werden sofort gelöscht („aus = vergessen").
async function setOptIn(id, on) {
  const cur = await get(id);
  const next = { on: !!on, items: on ? cur.items : [], decided: true };
  return save(id, next);
}

// Neue Fakten merken – nur wenn Opt-in an. Gibt den neuen Zustand zurück.
async function remember(id, memos) {
  const cur = await get(id);
  if (!cur.on) return cur;                    // ohne Zustimmung wird nichts gespeichert
  const items = mergeItems(cur.items, memos, Date.now());
  return save(id, { on: true, items: items, decided: true });
}

// Einen bestimmten Fakt vergessen (für die Profil-UI).
async function forget(id, text) {
  const cur = await get(id);
  const k = cleanFact(text).toLowerCase(); if (!k) return cur;
  const items = cur.items.filter((x) => cleanFact(x.t).toLowerCase() !== k);
  return save(id, { on: cur.on, items: items, decided: cur.decided });
}

// Alles Gemerkte löschen (Opt-in-Status bleibt).
async function clear(id) {
  const cur = await get(id);
  return save(id, { on: cur.on, items: [], decided: cur.decided });
}

module.exports = {
  MAX_ITEMS, MAX_LEN, MAX_PER_TURN, MEMO_DIRECTIVE, MKEY,
  cleanFact, extractMemos, mergeItems, toPromptText,
  get, setOptIn, remember, forget, clear,
};
