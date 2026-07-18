'use strict';
// FINN-Langzeitgedächtnis (lib/finnMemory.js): Marker-Parsing, Dedup/Cap, Prompt-Text
// und – gegen einen In-Memory-KV-Mock – das Opt-in-Gate (aus = nichts gespeichert,
// abschalten = vergessen), Merken/Vergessen/Löschen.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ── KV-Store mocken (In-Memory), BEVOR finnMemory geladen wird ──
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
const KV = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return KV.has(c[1]) ? KV.get(c[1]) : null;
    if (op === 'SET') { KV.set(c[1], c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(c[1]); return had ? 1 : 0; }
    if (op === 'EXPIRE') return KV.has(c[1]) ? 1 : 0;
    return null;
  }));
}
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline },
};

const Mem = require(path.join(ROOT, 'lib/finnMemory.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. extractMemos: Marker ziehen + aus Text entfernen
  const ex = Mem.extractMemos('Klar, mach das so. [[merke: Ziel ist Abnehmen]] Viel Erfolg!');
  ok('1. extractMemos findet den Fakt', ex.memos.length === 1 && ex.memos[0] === 'Ziel ist Abnehmen');
  ok('1b. Marker aus sichtbarem Text entfernt', !/merke|\[\[/.test(ex.text) && /Viel Erfolg/.test(ex.text));

  // 2. mehrere Marker, aber max. MAX_PER_TURN
  const many = Mem.extractMemos('a [[merke: eins]] b [[merke: zwei]] c [[merke: drei]] d [[merke: vier]]');
  ok('2. höchstens MAX_PER_TURN Fakten pro Antwort', many.memos.length === Mem.MAX_PER_TURN);

  // 3. cleanFact kappt Länge + verwirft zu Kurzes
  ok('3. cleanFact kappt auf MAX_LEN', Mem.cleanFact('x'.repeat(500)).length === Mem.MAX_LEN);
  ok('3b. cleanFact verwirft zu kurze Fakten', Mem.cleanFact('a') === '');

  // 4. mergeItems: dedupliziert (case-insensitive) + Cap MAX_ITEMS (LRU)
  const merged = Mem.mergeItems([{ t: 'Ziel Abnehmen', ts: 1 }], ['ziel abnehmen', 'mag kein Beintraining'], 100);
  ok('4. Duplikat wird nicht doppelt gespeichert', merged.length === 2);
  const big = [];
  for (let i = 0; i < Mem.MAX_ITEMS; i++) big.push({ t: 'fakt ' + i, ts: i });
  const capped = Mem.mergeItems(big, ['ganz neuer fakt'], 999);
  ok('4b. Liste bleibt auf MAX_ITEMS gedeckelt', capped.length === Mem.MAX_ITEMS);
  ok('4c. ältester Fakt fällt raus (LRU)', !capped.some((x) => x.t === 'fakt 0') && capped.some((x) => x.t === 'ganz neuer fakt'));

  // 5. toPromptText nur bei aktiviertem Gedächtnis
  ok('5. toPromptText leer, wenn Opt-in aus', Mem.toPromptText({ on: false, items: [{ t: 'x', ts: 1 }] }) === '');
  const pt = Mem.toPromptText({ on: true, items: [{ t: 'Ziel Abnehmen', ts: 1 }] });
  ok('5b. toPromptText listet Fakten, wenn an', /Ziel Abnehmen/.test(pt) && /– /.test(pt));

  // ── Opt-in-Gate gegen den KV-Mock ──
  const ID = 'M1';
  // 6. Standard: aus, leer, noch nicht entschieden
  const g0 = await Mem.get(ID);
  ok('6. Standard: Opt-in aus, keine Fakten, noch nicht entschieden', g0.on === false && g0.items.length === 0 && g0.decided === false);

  // 7. Ohne Opt-in wird NICHTS gespeichert
  await Mem.remember(ID, ['heimlicher Fakt']);
  const g1 = await Mem.get(ID);
  ok('7. remember ohne Opt-in speichert nichts', g1.items.length === 0);

  // 8. Opt-in an -> merken funktioniert
  await Mem.setOptIn(ID, true);
  await Mem.remember(ID, ['Ziel ist Muskelaufbau']);
  const g2 = await Mem.get(ID);
  ok('8. mit Opt-in wird gemerkt + gilt als entschieden', g2.on === true && g2.decided === true && g2.items.some((x) => /Muskelaufbau/.test(x.t)));

  // 9. Einzeln vergessen
  await Mem.forget(ID, 'Ziel ist Muskelaufbau');
  const g3 = await Mem.get(ID);
  ok('9. forget entfernt den Fakt', !g3.items.some((x) => /Muskelaufbau/.test(x.t)));

  // 10. Opt-in abschalten -> alles vergessen
  await Mem.remember(ID, ['mag frühes Training']);
  await Mem.setOptIn(ID, false);
  const g4 = await Mem.get(ID);
  ok('10. Opt-in aus = Fakten gelöscht („aus = vergessen"), Entscheidung bleibt', g4.on === false && g4.items.length === 0 && g4.decided === true);

  // 11. Frischer Nutzer, der „Nein" sagt: nichts an, aber entschieden (fragt nicht erneut).
  const NO = 'M2';
  await Mem.setOptIn(NO, false);
  const gn = await Mem.get(NO);
  ok('11. „Nein" zählt als Entscheidung (on=false, decided=true)', gn.on === false && gn.decided === true);

  console.log(pass ? 'FINN-MEMORY PASS' : 'FINN-MEMORY FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
