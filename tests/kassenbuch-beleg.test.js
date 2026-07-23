'use strict';
// Beleg-Ablage im Kassenbuch (lib/kassenbuch: saveBeleg/getBeleg/delBeleg/listBelege):
// gescannte/hochgeladene Kassenbons je Buchungstag, studioweit, ohne Personenbezug.
// Prüft Validierung (Datentyp/Größe), Round-trip, Index und Löschen.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));

const KV = new Map(), SETS = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase(), key = c[1];
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET') { KV.set(key, c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(key) || SETS.delete(key); return had ? 1 : 0; }
    if (op === 'SADD') { const s = SETS.get(key) || new Set(); const b = s.size; s.add(String(c[2])); SETS.set(key, s); return s.size - b; }
    if (op === 'SREM') { const s = SETS.get(key); if (!s) return 0; const had = s.delete(String(c[2])); return had ? 1 : 0; }
    if (op === 'SMEMBERS') return Array.from(SETS.get(key) || []);
    return null;
  }));
}
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline } };

const KB = require(path.join(ROOT, 'lib/kassenbuch.js'));

const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);   // gültiges (Mini-)JPEG-Data-URL

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. Ablegen + Round-trip.
  const s1 = await KB.saveBeleg('2026-07', 5, IMG);
  ok('1. saveBeleg ok', s1.ok === true);
  ok('1b. getBeleg liefert exakt zurück', (await KB.getBeleg('2026-07', 5)) === IMG);

  // 2. Index listet nur Tage mit Beleg, sortiert.
  await KB.saveBeleg('2026-07', 12, IMG);
  await KB.saveBeleg('2026-07', 3, IMG);
  const list = await KB.listBelege('2026-07');
  ok('2. listBelege sortiert [3,5,12]', JSON.stringify(list) === JSON.stringify([3, 5, 12]));

  // 3. Validierung: ungültiges Format / Tag / zu groß werden abgelehnt.
  ok('3. Nicht-Data-URL abgelehnt', (await KB.saveBeleg('2026-07', 5, 'hallo')).ok === false);
  ok('3b. ungültiger Tag abgelehnt', (await KB.saveBeleg('2026-07', 41, IMG)).ok === false);
  ok('3c. zu groß abgelehnt', (await KB.saveBeleg('2026-07', 6, 'data:image/jpeg;base64,' + 'A'.repeat(1700000))).error === 'too_large');
  ok('3d. ungültiger Monat abgelehnt', (await KB.saveBeleg('2026-13', 5, IMG)).ok === false);

  // 4. PDF-Beleg ist ebenfalls erlaubt.
  ok('4. PDF-Data-URL erlaubt', (await KB.saveBeleg('2026-07', 8, 'data:application/pdf;base64,' + 'A'.repeat(300))).ok === true);

  // 5. Löschen entfernt Bild + Index-Eintrag, andere bleiben.
  await KB.delBeleg('2026-07', 5);
  ok('5. getBeleg nach del = null', (await KB.getBeleg('2026-07', 5)) === null);
  const list2 = await KB.listBelege('2026-07');
  ok('5b. Index ohne Tag 5, Rest bleibt', list2.indexOf(5) < 0 && list2.indexOf(3) >= 0 && list2.indexOf(12) >= 0);

  // 6. Monat ohne Belege -> leere Liste (kein Fehler).
  ok('6. leerer Monat -> []', JSON.stringify(await KB.listBelege('2026-09')) === '[]');

  console.log(pass ? 'KASSENBUCH-BELEG PASS' : 'KASSENBUCH-BELEG FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('ERR', e); process.exit(2); });
