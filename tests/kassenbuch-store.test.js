'use strict';
// Kassenbuch-Speicher (lib/kassenbuch.js) mit In-Memory-KV-Mock: Speichern/Laden,
// Sperre bei Abschluss, Blatt-Nr.-Fortlauf und Monatsübernahme (Endbestand -> nächster
// Anfangsbestand). Deckt genau die Steuerberater-Anforderung ab (nextBlattNr + suggestOpening).

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));

// Minimaler Redis-Mock: GET/SET (String), SADD/SMEMBERS (Set), DEL.
const KV = new Map();
const SETS = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase(), key = c[1];
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET') { KV.set(key, c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(key) || SETS.delete(key); return had ? 1 : 0; }
    if (op === 'SADD') { const s = SETS.get(key) || new Set(); const before = s.size; s.add(c[2]); SETS.set(key, s); return s.size - before; }
    if (op === 'SMEMBERS') { return Array.from(SETS.get(key) || []); }
    return null;
  }));
}
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline } };

const KB = require(path.join(ROOT, 'lib/kassenbuch.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. Blatt-Nr. fortlaufend.
  ok('1. nextBlattNr 843 -> 844', KB.nextBlattNr('843') === '844');
  ok('1b. nextBlattNr mit Präfix "Blatt 12" -> "Blatt 13"', KB.nextBlattNr('Blatt 12') === 'Blatt 13');
  ok('1c. nextBlattNr leer -> leer', KB.nextBlattNr('') === '' && KB.nextBlattNr(null) === '');

  // 2. Juni speichern (Blatt 843, Anfang 1372,58, eine Einnahme 20,50, eine Ausgabe 3,99).
  const jun = { blattNr: '843', anfangsbestand: '1372,58',
    days: { '1': { eiweissbeutel: 1, sonstigesText: 'Hornbach', ausgaben: '3,99', ausgabenText: 'Hornbach' } } };
  const sr = await KB.saveMonth('2026-06', jun);
  ok('2. Juni gespeichert', sr.ok === true);
  const junM = await KB.getMonth('2026-06');
  const junT = KB.computeMonth(junM);
  // 1372,58 + 20,50 - 3,99 = 1389,09
  ok('2b. Juni Endbestand 1389,09', junT.endbestand === 1389.09);
  ok('2c. Juni Blatt-Nr. 843 erhalten', junM.blattNr === '843');

  // 3. suggestOpening für Juli: Anfang = Juni-Endbestand, Blatt = 844.
  const sug = await KB.suggestOpening('2026-07');
  ok('3. Juli Anfangsbestand aus Juni-Endbestand (1389,09)', sug.anfangsbestand === 1389.09);
  ok('3b. Juli Blatt-Nr. = 844', sug.blattNr === '844');
  ok('3c. carried-Flag gesetzt + fromMonth Juni', sug.carried === true && sug.fromMonth === '2026-06');

  // 4. Ohne Vormonat keine Übernahme.
  const sug0 = await KB.suggestOpening('2026-01');
  ok('4. kein Vormonat -> anfang 0, blatt leer, carried false', sug0.anfangsbestand === 0 && sug0.blattNr === '' && sug0.carried === false);

  // 5. Lücke: März existiert nicht, aber Juni schon -> Übernahme aus Juni beim Öffnen von September.
  const sugSep = await KB.suggestOpening('2026-09');
  ok('5. September übernimmt jüngsten Vormonat (Juni)', sugSep.fromMonth === '2026-06' && sugSep.anfangsbestand === 1389.09 && sugSep.blattNr === '844');

  // 6. Abschluss sperrt weitere Speicherungen.
  const cr = await KB.closeMonth('2026-06', '', 'Chef');
  ok('6. Juni abgeschlossen', cr.ok === true);
  const sr2 = await KB.saveMonth('2026-06', jun);
  ok('6b. Speichern auf abgeschlossenem Monat abgelehnt', sr2.ok === false && sr2.error === 'closed');

  // 7. Wieder öffnen erlaubt erneut speichern.
  await KB.reopenMonth('2026-06');
  const sr3 = await KB.saveMonth('2026-06', jun);
  ok('7. nach Wieder-Öffnen speicherbar', sr3.ok === true);

  // 8. listMonths liefert den Monat mit Kennzahlen.
  const list = await KB.listMonths();
  ok('8. listMonths enthält 2026-06', list.some((m) => m.key === '2026-06' && m.endbestand === 1389.09));

  console.log(pass ? 'KASSENBUCH-STORE PASS' : 'KASSENBUCH-STORE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('ERR', e); process.exit(2); });
