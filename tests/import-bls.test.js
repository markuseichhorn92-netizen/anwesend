'use strict';
// Prüft den BLS-Konverter (scripts/import-bls.js): CSV-Parsing, deutsche Zahlen,
// Spaltenerkennung über die BLS-Codes (die Wert-Spalte, NICHT die Köderspalten
// „Datenherkunft"/„Referenz") und die Zeilen-zu-Lebensmittel-Logik inkl.
// Atwater-Ausreißerfilter. XLSX wird separat gegen eine echte Excel-Datei geprüft;
// hier reicht CSV, damit der Test überall (auch in der CI) läuft.
const IB = require('../scripts/import-bls');

function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── Zahlen ──
  ok('1. deutsche Dezimalzahl "12,3" -> 12.3', IB.num('12,3') === 12.3);
  ok('2. "1.234,5" -> 1234.5 (Tausenderpunkt)', IB.num('1.234,5') === 1234.5);
  ok('3. "12.3" -> 12.3', IB.num('12.3') === 12.3);
  ok('4. leere/„k.A." -> null', IB.num('') === null && IB.num('k.A.') === null && IB.num('-') === null);

  // ── Spaltenerkennung: Wert-Spalte, nicht Datenherkunft/Referenz ──
  const header = ['BLS Code', 'Lebensmittelbezeichnung', 'Food name',
    'ENERCJ Energie (Kilojoule) [kJ/100g]', 'ENERCJ Datenherkunft', 'ENERCJ Referenz',
    'ENERCC Energie (immer berechnet) [kcal/100g]', 'ENERCC Datenherkunft', 'ENERCC Referenz',
    'PROT625 Protein (Nx6,25) [g/100g]', 'PROT625 Datenherkunft', 'PROT625 Referenz'];
  ok('5. ENERCC (kcal) findet die Wert-Spalte', IB.findCol(header, 'ENERCC') === 6, String(IB.findCol(header, 'ENERCC')));
  ok('6. …nicht ENERCJ (kJ)', IB.findCol(header, 'ENERCC') !== 3);
  ok('7. Datenherkunft/Referenz werden übersprungen',
    header[IB.findCol(header, 'ENERCC')].indexOf('kcal/100g') > 0);
  ok('8. unbekannter Code -> -1', IB.findCol(header, 'GIBTESNICHT') === -1);

  // ── CSV lesen ──
  const csv = [
    'BLS Code;Lebensmittelbezeichnung;Food name;ENERCC Energie [kcal/100g];ENERCC Datenherkunft;PROT625 Protein [g/100g];CHO Kohlenhydrate [g/100g];FAT Fett [g/100g];FIBT Ballaststoffe [g/100g];SUGAR Zucker [g/100g];FASAT Fettsäuren ges [g/100g];NA Natrium [mg/100g]',
    'N410000;Kartoffeln gegart;Potatoes;87;berechnet;2,0;20,0;0,1;1,8;0,9;0,0;6',
    'F110000;Apfel roh;Apple;52;berechnet;0,3;14,0;0,2;2,4;10,0;0,0;1',
    'X000000;;kein Name;0;berechnet;0;0;0;0;0;0;0',                         // ohne Namen -> raus
    'Y000000;Unsinn Extrem;weird;999;berechnet;5,0;5,0;5,0;0;0;0;0',        // Ausreißer -> raus
  ].join('\n');
  const rows = IB.readCsv(csv);
  ok('9. CSV: Kopf + 4 Datenzeilen', rows.length === 5, String(rows.length));
  ok('10. Semikolon-Trenner erkannt (12 Spalten)', rows[0].length === 12, String(rows[0].length));

  // ── Zeilen -> Lebensmittel ──
  const { foods, stats } = IB.rowsToFoods(rows);
  ok('11. zwei plausible Lebensmittel übernommen', foods.length === 2, String(foods.length));
  ok('12. Zeile ohne Namen übersprungen', stats.skippedNoName === 1);
  ok('13. Ausreißer per Atwater verworfen', stats.outliers.length === 1, stats.outliers.join(''));
  const k = foods.find((f) => /Kartoffeln/.test(f.name));
  ok('14. Kartoffeln: 87 kcal, korrekte Makros', k && k.kcal === 87 && k.p === 2 && k.c === 20 && k.f === 0.1, JSON.stringify(k));
  ok('15. Salz aus Natrium abgeleitet (6 mg -> ~0,02 g)', k && k.salt === 0.02, k && String(k.salt));
  ok('16. ges. Fett übernommen', k && k.satfat === 0, k && String(k.satfat));

  // ── Fehlende Pflichtspalte -> klarer Fehler statt stiller Murks ──
  let threw = false;
  try { IB.rowsToFoods([['BLS Code', 'Lebensmittelbezeichnung', 'Food name']]); } catch (e) { threw = /Pflicht-Spalten/.test(e.message); }
  ok('17. Fehlende kcal/Makro-Spalten -> Fehler', threw);

  console.log(pass ? 'IMPORT-BLS PASS' : 'IMPORT-BLS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
