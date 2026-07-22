'use strict';
// Kassenbuch-Altbestände (lib/kassenbuchSeed.js): jede Monatszeile muss in sich
// stimmen (Anfang + Einnahmen − Ausgaben === Endbestand) und computeMonth muss für
// die Archiv-Datensätze exakt die erfassten Summen liefern. Zusätzlich Blatt-Nr.-
// Fortlauf und Monatskette (März→Juni) prüfen. Keine Store-Mocks nötig.
const path = require('path');
const KB = require(path.resolve(__dirname, '..', 'lib', 'kassenbuch.js'));
const SEED = require(path.resolve(__dirname, '..', 'lib', 'kassenbuchSeed.js'));

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
const r2 = (n) => Math.round(n * 100) / 100;

// Erwartete Endbestände laut Original-Belegen (unabhängig gegengeprüft).
const EXPECT_END = { '2026-01': 620.65, '2026-02': 920.65, '2026-03': 990.15, '2026-04': 1210.15, '2026-05': 1372.58, '2026-06': 139.56 };

// 1. Jede Zeile: Anfang + Ein − Aus === Endbestand.
SEED.SEED_2026.forEach((s) => {
  ok(s.key + ': Anfang+Ein−Aus = Endbestand', r2(s.anfangsbestand + s.sumEinnahmen - s.sumAusgaben) === r2(s.endbestand));
  ok(s.key + ': Endbestand wie Beleg (' + EXPECT_END[s.key] + ')', r2(s.endbestand) === EXPECT_END[s.key]);
});

// 2. computeMonth liefert für den Archiv-Datensatz die erfassten Summen.
SEED.SEED_2026.forEach((s) => {
  const t = KB.computeMonth(SEED.seedRecord(s));
  ok(s.key + ': computeMonth Endbestand', t.endbestand === r2(s.endbestand) && t.imported === true);
  ok(s.key + ': computeMonth Summen', t.sumEinnahmen === r2(s.sumEinnahmen) && t.sumAusgaben === r2(s.sumAusgaben));
});

// 3. Blatt-Nr. läuft lückenlos 838…843.
const blaetter = SEED.SEED_2026.map((s) => parseInt(s.blattNr, 10));
ok('3. Blatt-Nr. lückenlos 838..843', blaetter.join(',') === '838,839,840,841,842,843');
ok('3b. nächste Blatt-Nr. nach Juni = 844', KB.nextBlattNr('843') === '844');

// 4. Kette März→April→Mai→Juni: Endbestand == Anfang des Folgemonats (neues Layout).
const byKey = {}; SEED.SEED_2026.forEach((s) => { byKey[s.key] = s; });
[['2026-03', '2026-04'], ['2026-04', '2026-05'], ['2026-05', '2026-06']].forEach(([a, b]) => {
  ok(a + '→' + b + ' Bestand zieht durch', r2(byKey[a].endbestand) === r2(byKey[b].anfangsbestand));
});

// 5. seedRecord ist ein abgeschlossener Archiv-Monat mit Quelle 'import'.
const rec = SEED.seedRecord(byKey['2026-06']);
ok('5. seedRecord Juni: closed + source import + blattNr 843', rec.closed === true && rec.source === 'import' && rec.blattNr === '843');
ok('5b. seedRecord hat imported-Summen', rec.imported && rec.imported.endbestand === 139.56);
ok('5c. Juni Anfangsbestand 1372,58 -> Juli erbt das', rec.anfangsbestand === 1372.58);

// 6. Aktuelle Preisliste = Kaffee 2,00 (Stand Juni).
ok('6. Seed-Preis Kaffee 2,00', SEED.SEED_PRICES.kaffee === 2.0 && SEED.SEED_PRICES.eiweissshake === 2.5 && SEED.SEED_PRICES.eiweissbeutel === 20.5);

console.log(pass ? 'KASSENBUCH-SEED PASS' : 'KASSENBUCH-SEED FAIL');
process.exit(pass ? 0 : 1);
