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
const STOP = new Set(['und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'ich', 'du', 'wie', 'was', 'ist', 'kann', 'mein', 'meine', 'meinen', 'bei', 'mit', 'von', 'für', 'fuer', 'auf', 'zu', 'im', 'in', 'den', 'dem', 'es', 'nicht', 'noch', 'mal', 'bitte', 'hallo', 'hi', 'the', 'and', 'ihr', 'euch', 'wir',
  'wenn', 'als', 'dass', 'man', 'dann', 'sich', 'sind', 'wird', 'hat', 'hast', 'habe', 'gibt', 'viel', 'viele', 'eure', 'euer', 'eurer', 'euren', 'eurem']);
function tokens(s) { return norm(s).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)); }

// Einfache Wortstamm-Kürzung, damit „spare"/„sparst", „bestehendes"/„bestehende",
// „starte"/„startest" zusammenfinden. Höchstens zwei Endungen, Stamm mindestens 4 Zeichen.
const SUFFIX = ['ern', 'em', 'en', 'er', 'es', 'et', 'st', 'e', 'n', 's'];
function stem(t) {
  let s = t;
  for (let i = 0; i < 2; i++) {
    const m = SUFFIX.find((x) => s.length - x.length >= 4 && s.endsWith(x));
    if (!m) break;
    s = s.slice(0, -m.length);
  }
  return s;
}

function rulesDoc() {
  let F = null; try { F = require('../features'); } catch (e) {}
  const lines = ['Fit-Inn Trier, Auf Hirtenberg 8, 54296 Trier. Telefon 0651 493 688 19, E-Mail info@fit-inn-trier.de.'];
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
  // Team-Artikel (Backend) haben Vorrang: ein eingebauter Artikel mit gleichem Titel entfällt –
  // wie in der App-Hilfe. Sonst stünde derselbe Text doppelt in den Treffern.
  const kvTitles = new Set();
  try { const A = require('../articles'); const list = await A.listPublished(); (list || []).forEach((a) => { if (a && a.title) { kvTitles.add(String(a.title).trim().toLowerCase()); out.push({ id: 'art:' + a.id, source: 'articles', title: a.title, body: String(a.body || ''), cat: a.cat || '' }); } }); } catch (e) {}
  try { require('../help').forEach((a, i) => { if (a && a.t && !kvTitles.has(String(a.t).trim().toLowerCase())) out.push({ id: 'help:' + i, source: 'help', title: a.t, body: String(a.body || ''), cat: a.cat || '' }); }); } catch (e) {}
  out.push(rulesDoc());
  cache = { at: Date.now(), docs: out };
  return out;
}

// Seltene Begriffe zählen mehr als Allerweltswörter („Aufnahmegebühr" vs. „Mitglied"):
// Gewicht je Suchwort = 1 + ln(N / (1 + Anzahl Dokumente mit dem Wort)), mindestens 0,2.
function weights(idx, qStems) {
  const w = {};
  const n = idx.length || 1;
  qStems.forEach((q) => {
    if (w[q] != null) return;
    let df = 0;
    idx.forEach((x) => { if (x.tset.has(q) || x.bset.has(q)) df++; });
    w[q] = Math.max(0.2, 1 + Math.log(n / (1 + df)));
  });
  return w;
}

// x = { t, b, tset, bset } – Wortstämme von Titel und Text.
function score(x, qStems, w) {
  let s = 0;
  for (const q of qStems) {
    const g = (w && w[q] != null) ? w[q] : 1;
    if (x.tset.has(q)) s += 3 * g;
    else if (x.t.some((y) => y.indexOf(q) >= 0 || q.indexOf(y) >= 0)) s += 1.5 * g;
    if (x.bset.has(q)) s += 1 * g;
    // Teilwort: Suchwort steckt im Wort („mitglied" in „Neumitglieder") oder ein langes Wort
    // ist der Anfang des Suchworts („telefon" in „Telefonnummer").
    else if (x.b.some((y) => (y.indexOf(q) >= 0 && q.length >= 5) || (y.length >= 6 && q.indexOf(y) === 0))) s += 0.5 * g;
  }
  return s;
}

function indexOf(d) {
  const t = tokens(d.title).map(stem), b = tokens(d.body).map(stem);
  return { d: d, t: t, b: b, tset: new Set(t), bset: new Set(b) };
}

// Top-k Treffer: [{ id, source, title, snippet, score }]
// o.chars: Länge der Ausschnitte (sonst 900 – so bleibt das Werkzeug search_knowledge klein).
async function search(query, k, o) {
  const q = tokens(query).map(stem);
  if (!q.length) return [];
  const idx = (await docs()).map(indexOf);
  const w = weights(idx, q);
  const chars = (o && o.chars) || 900;
  return idx.map((x) => ({ d: x.d, s: score(x, q, w) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k || 4)
    .map((x) => ({ id: x.d.id, source: x.d.source, title: x.d.title, snippet: x.d.body.slice(0, chars), score: Math.round(x.s * 10) / 10 }));
}

// Kontextblock für den System-Prompt (klein halten; Vollwissen bleibt im
// bestehenden coachSystemParts-Vorspann, der gecacht wird).
// Treffer möglichst vollständig: je Artikel bis DOC_CHARS, zusammen bis BUDGET, jeder aber
// mindestens MIN_CHARS. Bei harter Kürzung auf 500 Zeichen fehlten z. B. beim Aktionsartikel
// Bedingungen und Leistungen – FINN riet dann; und eine mehrdeutige Frage („Kann ich das als
// bestehendes Mitglied nutzen?") setzt die Aktion nicht immer auf Platz 1.
const DOC_CHARS = 3000, BUDGET = 6500, MIN_CHARS = 500;
async function contextFor(query, k) {
  const hits = await search(query, k || 3, { chars: DOC_CHARS });
  if (!hits.length) return '';
  let left = BUDGET;
  return 'WISSENSBASIS (Auszüge; wenn Live-Daten etwas anderes sagen, gelten die Live-Daten):\n'
    + hits.map((h) => {
      const n = Math.min(h.snippet.length, Math.max(MIN_CHARS, left));
      left -= n;
      return '• [' + h.source + '] ' + h.title + ': ' + h.snippet.slice(0, n);
    }).join('\n');
}

function _reset() { cache = { at: 0, docs: [] }; }

module.exports = { search, contextFor, docs, tokens, _reset };
