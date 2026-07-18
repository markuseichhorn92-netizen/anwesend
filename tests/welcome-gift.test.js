'use strict';
// Willkommensgeschenk (lib/welcomeGift.js): jeder Bereich einmalig gratis einlösbar,
// danach gesperrt – gegen einen In-Memory-KV-Mock.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

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

const W = require(path.join(ROOT, 'lib/welcomeGift.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const ID = 'M1';

  // 1. Standard: nichts eingelöst
  const g0 = await W.get(ID);
  ok('1. Standard: kein Geschenk eingelöst', g0.train === false && g0.ern === false);

  // 2. Training einmal gratis, danach gesperrt
  ok('2. erster Trainingsplan ist frei', (await W.tryClaim(ID, 'train')) === true);
  ok('2b. zweiter Trainingsplan NICHT mehr frei', (await W.tryClaim(ID, 'train')) === false);

  // 3. Ernährung unabhängig davon noch frei
  ok('3. erster Ernährungsplan ist frei', (await W.tryClaim(ID, 'ern')) === true);
  ok('3b. zweiter Ernährungsplan NICHT mehr frei', (await W.tryClaim(ID, 'ern')) === false);

  // 4. Zustand persistiert
  const g1 = await W.get(ID);
  ok('4. beide als eingelöst gemerkt', g1.train === true && g1.ern === true);

  // 5. Unbekannter Bereich zählt nicht
  ok('5. unbekannter Bereich -> false', (await W.tryClaim(ID, 'quatsch')) === false);

  // 6. Anderes Mitglied hat sein eigenes Geschenk
  ok('6. anderes Mitglied hat frisches Geschenk', (await W.tryClaim('M2', 'train')) === true);

  // 7. available() prüft nur (verbraucht nichts) – mehrfach abfragbar
  const M3 = 'M3';
  ok('7. available anfangs true', (await W.available(M3, 'ern')) === true);
  ok('7b. available verändert nichts (noch true)', (await W.available(M3, 'ern')) === true);

  // 8. consume() erst nach Erfolg -> danach nicht mehr verfügbar
  ok('8. consume löst ein', (await W.consume(M3, 'ern')) === true);
  ok('8b. danach available false', (await W.available(M3, 'ern')) === false);
  ok('8c. zweites consume schlägt fehl', (await W.consume(M3, 'ern')) === false);
  ok('8d. anderer Bereich bleibt frei', (await W.available(M3, 'train')) === true);

  console.log(pass ? 'WELCOME-GIFT PASS' : 'WELCOME-GIFT FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
