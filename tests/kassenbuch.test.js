'use strict';
// Kassenbuch: lib/kassenbuch.js – reine Rechenlogik (computeMonth), Säuberung
// (sanitizeMonth/sanitizeDay) und Prompt-Text. Keine Store-Mocks nötig.
const path = require('path');
const KB = require(path.resolve(__dirname, '..', 'lib', 'kassenbuch.js'));

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

// 1) Monatsschlüssel-Validierung.
ok('1. gültige Schlüssel', KB.isMonthKey('2026-07') && KB.isMonthKey('2026-01') && KB.isMonthKey('2026-12'));
ok('1b. ungültige Schlüssel', !KB.isMonthKey('2026-13') && !KB.isMonthKey('2026-00') && !KB.isMonthKey('2026-7') && !KB.isMonthKey('') && !KB.isMonthKey('foo'));

// 2) Einnahmen-Berechnung je Tag = Kaffee*1.5 + Shake*2.5 + Beutel*20.5 + Sonstiges.
const m1 = {
  key: '2026-07', year: 2026, month: 7, anfangsbestand: 100,
  prices: KB.DEFAULT_PRICES,
  days: {
    '1': { kaffee: 2, eiweissshake: 1, eiweissbeutel: 0, sonstigesBetrag: 0, ausgaben: 0 },  // 3.0 + 2.5 = 5.5
    '3': { kaffee: 0, eiweissshake: 0, eiweissbeutel: 1, sonstigesText: 'Trinkgeld', sonstigesBetrag: 4.5, ausgaben: 0 }, // 20.5 + 4.5 = 25.0
    '5': { kaffee: 0, eiweissshake: 0, eiweissbeutel: 0, sonstigesBetrag: 0, ausgaben: 30, ausgabenText: 'Reinigung' },  // Ausgabe 30
  },
};
const t1 = KB.computeMonth(m1);
const r1 = t1.rows[0], r3 = t1.rows[2], r5 = t1.rows[4];
ok('2. Tag1 Einnahme 2·1,5 + 1·2,5 = 5,5', r1.einnahmen === 5.5);
ok('2b. Tag3 Einnahme 1·20,5 + 4,5 = 25,0', r3.einnahmen === 25);
ok('2c. Tag5 Ausgabe 30', r5.ausgaben === 30 && r5.einnahmen === 0);

// 3) Beschreibung wird automatisch gebaut.
ok('3. Beschreibung Tag1', r1.beschreibung === '2 Kaffee + 1 Eiweißshake');
ok('3b. Beschreibung Tag3 mit Sonstiges', r3.beschreibung === '1 Eiweißbeutel + Trinkgeld');
ok('3c. Prüfung ✓ nur bei Einnahme', r1.pruefung === '✓' && r5.pruefung === '');

// 4) Laufender Bestand: 100 +5,5 (T1) +25 (T3) -30 (T5) = 100,5 durchgehend fortgeschrieben.
ok('4. Bestand nach Tag1 = 105,5', r1.bestand === 105.5);
ok('4b. Bestand nach Tag3 = 130,5', r3.bestand === 130.5);
ok('4c. Bestand nach Tag5 = 100,5', r5.bestand === 100.5);
ok('4d. Endbestand = letzter Bestand', t1.endbestand === 100.5 && t1.rows[30].bestand === 100.5);

// 5) Summen + Zähler.
ok('5. Summe Einnahmen 30,5', t1.sumEinnahmen === 30.5);
ok('5b. Summe Ausgaben 30', t1.sumAusgaben === 30);
ok('5c. Endbestand = Anfang + Ein - Aus', t1.endbestand === KB.round2(100 + 30.5 - 30));
ok('5d. entriesCount = 3 Buchungstage', t1.entriesCount === 3);
ok('5e. immer 31 Zeilen', t1.rows.length === 31);

// 6) Kassensturz: gezählter Bestand vs. rechnerischer -> Differenz + kontrolleOk.
const gezMatch = KB.computeMonth(Object.assign({}, m1, { gezaehlterEndbestand: 100.5 }));
ok('6. exakt gezählt -> Differenz 0, ok', gezMatch.differenz === 0 && gezMatch.kontrolleOk === true);
const gezOff = KB.computeMonth(Object.assign({}, m1, { gezaehlterEndbestand: 95 }));
ok('6b. Fehlbetrag -> Differenz -5,5, nicht ok', gezOff.differenz === -5.5 && gezOff.kontrolleOk === false);
ok('6c. ohne Zählung -> Differenz null, ok', t1.differenz === null && t1.kontrolleOk === true);

// 7) Eigene Preisliste wird angewendet (nicht Default).
const mPrice = { key: '2026-07', anfangsbestand: 0, prices: { kaffee: 2, eiweissshake: 3, eiweissbeutel: 25 }, days: { '2': { kaffee: 1, eiweissshake: 1, eiweissbeutel: 1 } } };
const tP = KB.computeMonth(mPrice);
ok('7. eigene Preise: 2+3+25 = 30', tP.rows[1].einnahmen === 30);
ok('7b. Preise im Ergebnis gespiegelt', tP.prices.kaffee === 2 && tP.prices.eiweissbeutel === 25);

// 8) Rundung / Komma-Eingaben robust (deutsches Komma).
const mComma = { key: '2026-07', anfangsbestand: '10,00', prices: KB.DEFAULT_PRICES, days: { '4': { kaffee: 0, eiweissshake: 0, eiweissbeutel: 0, sonstigesBetrag: '2,50', ausgaben: '1,25' } } };
const tC = KB.computeMonth(mComma);
ok('8. Komma-Betrag 2,50 als Einnahme', tC.rows[3].einnahmen === 2.5);
ok('8b. Endbestand 10 + 2,50 - 1,25 = 11,25', tC.endbestand === 11.25);

// 9) sanitizeMonth: nur befüllte Tage bleiben, Felder geklammert, negatives -> 0.
const dirty = KB.sanitizeMonth('2026-07', {
  anfangsbestand: '50', gezaehlterEndbestand: '', blattNr: 'x'.repeat(40),
  prices: { kaffee: -1, eiweissshake: 3 },
  days: {
    '1': { kaffee: '2', eiweissshake: 0, eiweissbeutel: 0, ausgaben: -5, sonstigesText: 'y'.repeat(200) },
    '2': {},                       // leer -> verworfen
    '9': { kaffee: 0, eiweissshake: 0, eiweissbeutel: 0, sonstigesBetrag: 0, ausgaben: 0 }, // nichts -> verworfen
  },
});
ok('9. leere Tage verworfen', !dirty.days['2'] && !dirty.days['9'] && !!dirty.days['1']);
ok('9b. negative Ausgabe -> 0', dirty.days['1'].ausgaben === 0);
ok('9c. ungültiger Preis fällt auf Default', dirty.prices.kaffee === 1.5 && dirty.prices.eiweissshake === 3);
ok('9d. Text gekappt (<=120)', dirty.days['1'].sonstigesText.length === 120);
ok('9e. blattNr gekappt (<=20)', dirty.blattNr.length === 20);
ok('9f. leerer gezählter Bestand -> null', dirty.gezaehlterEndbestand === null);

// 10) sanitizeDay: Artikel als positive Ganzzahlen.
const sd = KB.sanitizeDay({ kaffee: '3', eiweissshake: '-2', eiweissbeutel: '1.9', sonstigesBetrag: '4,20' });
ok('10. Kaffee 3, Shake -2 -> 0, Beutel 1', sd.kaffee === 3 && sd.eiweissshake === 0 && sd.eiweissbeutel === 1);
ok('10b. Betrag mit Komma 4,20', sd.sonstigesBetrag === 4.2);

// 11) toPromptText: nicht-personenbezogen, enthält Kernzahlen, keine „Anweisung befolgen".
const txt = KB.toPromptText(m1, t1);
ok('11. Prompt nennt Anfangsbestand', /Anfangsbestand: 100/.test(txt));
ok('11b. Prompt nennt Endbestand', /Endbestand: 100\.5/.test(txt));
ok('11c. Prompt listet Buchungen', /Buchungen \(3\)/.test(txt) && /Reinigung/.test(txt));
ok('11d. Monat/Jahr korrekt (07/2026)', /07\/2026/.test(txt) && !/07\/7\//.test(txt));

// 12) Determinismus: gleiche Eingabe -> gleiches Ergebnis.
ok('12. deterministisch', JSON.stringify(KB.computeMonth(m1)) === JSON.stringify(KB.computeMonth(m1)));

// 13) Beleg-Häkchen je Buchung (sanitizeDay als Boolean, Durchreichen in die Zeile).
ok('13. sanitizeDay belegOk -> true', KB.sanitizeDay({ ausgaben: 5, belegOk: 1 }).belegOk === true);
ok('13b. sanitizeDay ohne belegOk -> false', KB.sanitizeDay({ ausgaben: 5 }).belegOk === false);
const mBeleg = { key: '2026-07', month: 7, year: 2026, anfangsbestand: 0, prices: KB.DEFAULT_PRICES,
  days: { '5': { ausgaben: 30, ausgabenText: 'Hornbach', belegOk: true }, '6': { ausgaben: 12, ausgabenText: 'Post' } } };
const tBeleg = KB.computeMonth(mBeleg);
ok('13c. belegOk fließt in die Zeile', tBeleg.rows[4].belegOk === true && tBeleg.rows[5].belegOk === false);
ok('13d. sanitizeMonth behält Tag mit nur belegOk+Ausgabe', !!KB.sanitizeMonth('2026-07', { days: { '5': { ausgaben: 30, belegOk: true } } }).days['5']);

// 14) toPromptText: vollständiges Datum + Rahmenregeln (Datum/USt/Beleg/Kassensturz),
//     damit FINN diese – vom Studio bereits geklärten – Punkte nicht mehr bemängelt.
const txtB = KB.toPromptText(mBeleg, tBeleg);
ok('14. vollständiges Datum je Buchung (05.07.2026 / 06.07.2026)', /05\.07\.2026/.test(txtB) && /06\.07\.2026/.test(txtB));
ok('14b. USt pauschal 19 % genannt', /pauschal 19 %/.test(txtB));
ok('14c. Beleg-Status je Ausgabe (ja/nein)', /Beleg: ja/.test(txtB) && /Beleg: nein/.test(txtB));
ok('14d. Kassensturz als freiwillig markiert', /freiwillig/.test(txtB));

console.log(pass ? 'KASSENBUCH PASS' : 'KASSENBUCH FAIL');
process.exit(pass ? 0 : 1);
