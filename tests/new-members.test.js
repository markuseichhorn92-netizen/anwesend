'use strict';
// Neue Mitglieder (lib/newMembers.js): recordJoin merkt Beitritte in einer Redis-Liste,
// listJoins liefert neueste zuerst, dedupliziert nach Kunden-ID, gekappt. In-Memory-KV-Mock
// mit Listen-Semantik (LPUSH/LTRIM/LRANGE/EXPIRE).

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
const LISTS = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase();
    const key = c[1];
    if (op === 'LPUSH') { const a = LISTS.get(key) || []; a.unshift(c[2]); LISTS.set(key, a); return a.length; }
    if (op === 'LTRIM') {
      const a = LISTS.get(key) || []; const start = parseInt(c[2], 10), stop = parseInt(c[3], 10);
      LISTS.set(key, a.slice(start, stop + 1)); return 'OK';
    }
    if (op === 'LRANGE') {
      const a = LISTS.get(key) || []; const start = parseInt(c[2], 10); let stop = parseInt(c[3], 10);
      if (stop < 0) stop = a.length + stop; return a.slice(start, stop + 1);
    }
    if (op === 'EXPIRE') return LISTS.has(key) ? 1 : 0;
    return null;
  }));
}
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline },
};

const NM = require(path.join(ROOT, 'lib/newMembers.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. Leer am Anfang
  ok('1. leer am Anfang', (await NM.listJoins(10)).length === 0);

  // 2. recordJoin merkt einen Beitritt
  ok('2. recordJoin ok', (await NM.recordJoin('1001')).ok === true);
  const l1 = await NM.listJoins(10);
  ok('2b. ein Eintrag, id gemerkt', l1.length === 1 && l1[0].id === '1001');
  ok('2c. joinedAt gesetzt (ISO)', typeof l1[0].joinedAt === 'string' && /\d{4}-\d\d-\d\dT/.test(l1[0].joinedAt));

  // 3. Neueste zuerst
  await NM.recordJoin('1002');
  await NM.recordJoin('1003');
  const l2 = await NM.listJoins(10);
  ok('3. neueste zuerst', l2[0].id === '1003' && l2[2].id === '1001');

  // 4. Deduplizierung nach ID (doppeltes Event -> nur ein Eintrag, jüngster bleibt)
  await NM.recordJoin('1002');
  const l3 = await NM.listJoins(10);
  ok('4. dedup nach id (1002 nur einmal)', l3.filter((x) => x.id === '1002').length === 1);
  ok('4b. dedup: 1002 jetzt vorn (jüngstes Event)', l3[0].id === '1002');

  // 5. numerische und string-id werden gleich behandelt (String())
  await NM.recordJoin(2001);
  const l4 = await NM.listJoins(10);
  ok('5. numerische id wird String', l4[0].id === '2001');

  // 6. limit begrenzt die Ausgabe
  ok('6. limit begrenzt', (await NM.listJoins(2)).length === 2);

  // 7. id null/leer -> kein Eintrag
  const before = (await NM.listJoins(50)).length;
  ok('7. recordJoin(null) -> nicht ok', (await NM.recordJoin(null)).ok === false);
  ok('7b. kein Eintrag hinzugefügt', (await NM.listJoins(50)).length === before);

  // 8. Kappung: mehr als CAP Beitritte -> nur CAP vorgehalten
  for (let i = 0; i < NM.CAP + 20; i++) { await NM.recordJoin('bulk-' + i); }
  const full = await NM.listJoins(NM.CAP + 100);
  ok('8. Kappung auf CAP', full.length <= NM.CAP);

  console.log(pass ? 'NEWMEMBERS PASS' : 'NEWMEMBERS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
