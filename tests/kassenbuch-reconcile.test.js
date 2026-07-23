'use strict';
// Kassenbuch-Selbstheilung (lib/kassenbuch.reconcileSeed): ein bereits importierter
// Archiv-Monat mit VERALTETEN Summen wird auf die geprüften Seed-Werte gebracht.
// Deckt genau den Juni-Fall ab: falsch gespeichert 283,50 € / Endbestand 139,56 € ->
// korrekt 777,00 € / 633,06 €. Import-Archive (source:'import') werden korrigiert,
// manuell geführte Monate NICHT, und der Lauf ist idempotent.

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
    if (op === 'SADD') { const s = SETS.get(key) || new Set(); const b = s.size; s.add(c[2]); SETS.set(key, s); return s.size - b; }
    if (op === 'SMEMBERS') return Array.from(SETS.get(key) || []);
    return null;
  }));
}
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline } };

const KB = require(path.join(ROOT, 'lib/kassenbuch.js'));
const SEED = require(path.join(ROOT, 'lib/kassenbuchSeed.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const juneSeed = SEED.SEED_2026.find((s) => s.key === '2026-06');

  // 0. Seed selbst ist korrekt (777,00 / 633,06) – Absicherung gegen Regression.
  ok('0. Seed Juni korrekt (Einnahmen 777,00 / Endbestand 633,06)', juneSeed.sumEinnahmen === 777.00 && juneSeed.endbestand === 633.06);

  // 1. Falschen (veralteten) Juni als Import-Archiv ablegen.
  const wrong = Object.assign(SEED.seedRecord(juneSeed), { imported: { sumEinnahmen: 283.50, sumAusgaben: 1516.52, endbestand: 139.56 } });
  await KB.overwriteMonth(wrong);
  let t = KB.computeMonth(await KB.getMonth('2026-06'));
  ok('1. Vorher falsch: Endbestand 139,56', t.endbestand === 139.56 && t.sumEinnahmen === 283.50);

  // 2. Selbstheilung korrigiert genau einen Monat auf die Seed-Werte.
  const fixed = await KB.reconcileSeed();
  ok('2. reconcileSeed korrigiert 1 Monat', fixed === 1);
  t = KB.computeMonth(await KB.getMonth('2026-06'));
  ok('2b. Nachher korrekt: Endbestand 633,06 (Einnahmen 777,00)', t.endbestand === 633.06 && t.sumEinnahmen === 777.00);

  // 3. Idempotent – kein zweiter Schreibvorgang.
  ok('3. zweiter Lauf korrigiert nichts mehr', (await KB.reconcileSeed()) === 0);

  // 4. Der korrigierte Juni-Endbestand fließt in den Juli-Anfangsbestand (Übernahme-Knopf).
  const sug = await KB.suggestOpening('2026-07');
  ok('4. suggestOpening Juli = 633,06 aus korrigiertem Juni, Blatt 844', sug.anfangsbestand === 633.06 && sug.blattNr === '844');

  // 5. Manuell geführter Monat (kein source:'import') wird NICHT angefasst.
  await KB.saveMonth('2026-09', { blattNr: '900', anfangsbestand: '100,00', days: { '1': { kaffee: 1 } } });
  const before = JSON.stringify(await KB.getMonth('2026-09'));
  await KB.reconcileSeed();
  ok('5. manueller Monat bleibt unverändert', JSON.stringify(await KB.getMonth('2026-09')) === before);

  console.log(pass ? 'KASSENBUCH-RECONCILE PASS' : 'KASSENBUCH-RECONCILE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('ERR', e); process.exit(2); });
