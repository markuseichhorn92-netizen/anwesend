'use strict';

/**
 * FINN – Wissensschicht (Knowledge Layer).
 * -----------------------------------------------------------------------------
 * Quellen mit Herkunftsangabe:
 *   help      lib/help.js         – eingebaute Hilfe-Artikel (statisch)
 *   articles  lib/articles.js     – vom Team gepflegte, veröffentlichte Artikel (KV)
 *   rules     Feature-Regeln      – was die App gerade kann (Ernährung/Training/Abo aus)
 *   hours     Öffnungszeiten      – aus Magicline (über den Tool-Layer, Cache im Modul)
 *
 * Retrieval ist bewusst einfach und deterministisch (Token-Überlappung mit
 * Titel-Gewichtung, ohne Embeddings – zero-dependency). Ergebnis: Top-k mit
 * `source`, damit der Agent sagen kann, woher etwas stammt.
 *
 * Grundsatz: Live-Daten aus Magicline schlagen die Wissensbasis. Deshalb liefert
 * `contextFor` die Regel als ersten Satz mit, und der Runtime-Prompt stellt die
 * Live-Daten VOR die Wissensausschnitte.
 */

let cache = { at: 0, docs: [] };
const TTL = 5 * 60 * 1000;

function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ');
}
const STOP = new Set(['und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'ich', 'du', 'wie', 'was', 'ist', 'kann', 'mein', 'meine', 'meinen', 'bei', 'mit', 'von', 'für', 'fuer', 'auf', 'zu', 'im', 'in', 'den', 'dem', 'es', 'nicht', 'noch', 'mal', 'bitte', 'hallo', 'hi', 'the', 'and', 'ihr', 'euch', 'wir']);
function tokens(s) { return norm(s).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)); }

function rulesDoc() {
  let F = null; try { F = require('../features'); } catch (e) {}
  const lines = ['Fit-Inn Trier, Auf Hirtenberg 8, 54296 Trier. Telefon 0651 308524, E-Mail info@fit-inn-trier.de.'];
  if (F) {
    lines.push(F.aboOn() ? 'Es gibt ein Abo-Modell (Coach Premium).' : 'Es gibt kein Abo und kein Premium in der App – Coaching ist inklusive.');
    lines.push(F.ernOn() ? 'Das Ernährungsmodul der App ist aktiv.' : ('Ernährung läuft beim Partner Upfit' + (F.upfitUrl() ? (' (' + F.upfitUrl() + ')') : '') + ', nicht in der App.'));
    lines.push(F.trainOn() ? 'Der Trainingsbereich der App ist aktiv.' : 'Trainingspläne laufen über die Technogym-App, nicht in der Mitglieder-App.');
  }
  lines.push('Die App kann: Vertrag einsehen, Kündigung/Widerruf/Beitragspause beantragen, Termine buchen und stornieren, Check-in, Beitragskonto, Dokumente, Mitgliedskarte, Postfach zum Team.');
  return { id: 'rules', source: 'rules', title: 'Was die App gerade kann', body: lines.join(' '), cat: 'App' };
}

async function docs() {
  if (cache.docs.length && Date.now() - cache.at < TTL) return cache.docs;
  const out = [];
  try { require('../help').forEach((a, i) => { if (a && a.t) out.push({ id: 'help:' + i, source: 'help', title: a.t, body: String(a.body || ''), cat: a.cat || '' }); }); } catch (e) {}
  try { const A = require('../articles'); const list = await A.listPublished(); (list || []).forEach((a) => { if (a && a.title) out.push({ id: 'art:' + a.id, source: 'articles', title: a.title, body: String(a.body || ''), cat: a.cat || '' }); }); } catch (e) {}
  out.push(rulesDoc());
  cache = { at: Date.now(), docs: out };
  return out;
}

function score(doc, qTokens) {
  const t = tokens(doc.title), b = tokens(doc.body);
  const tset = new Set(t), bset = new Set(b);
  let s = 0;
  for (const q of qTokens) {
    if (tset.has(q)) s += 3;
    else if ([...tset].some((x) => x.indexOf(q) >= 0 || q.indexOf(x) >= 0)) s += 1.5;
    if (bset.has(q)) s += 1;
    else if (b.some((x) => x.indexOf(q) >= 0 && q.length >= 5)) s += 0.5;
  }
  return s;
}

// Top-k Treffer: [{ id, source, title, snippet, score }]
async function search(query, k) {
  const q = tokens(query);
  if (!q.length) return [];
  const all = await docs();
  return all.map((d) => ({ d: d, s: score(d, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k || 4)
    .map((x) => ({ id: x.d.id, source: x.d.source, title: x.d.title, snippet: x.d.body.slice(0, 900), score: Math.round(x.s * 10) / 10 }));
}

// Kontextblock für den System-Prompt (klein halten; Vollwissen bleibt im
// bestehenden coachSystemParts-Vorspann, der gecacht wird).
async function contextFor(query, k) {
  const hits = await search(query, k || 3);
  if (!hits.length) return '';
  return 'WISSENSBASIS (Auszüge; wenn Live-Daten etwas anderes sagen, gelten die Live-Daten):\n'
    + hits.map((h) => '• [' + h.source + '] ' + h.title + ': ' + h.snippet.slice(0, 500)).join('\n');
}

function _reset() { cache = { at: 0, docs: [] }; }

module.exports = { search, contextFor, docs, tokens, _reset };
