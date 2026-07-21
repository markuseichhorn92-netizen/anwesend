'use strict';
// Wochenbeitrag-Ableitung (lib/members.js weeklyFromPrice): normalisiert den
// Vertragspreis je Zahlweise auf eine Wochenbasis; der 52-Wochen-Gesamtbetrag
// auf der Mitgliedschaftsbestätigung ist dann Woche × 52.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.resolve(ROOT, 'lib/members.js'));
const w = M.weeklyFromPrice;

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const near = (a, b) => Math.abs(a - b) < 0.005;

  // WEEK: Preis ist bereits wöchentlich (Studio-Konvention)
  ok('1. WEEK 9,90 -> 9,90', near(w(9.9, 'WEEK'), 9.9));
  ok('2. WEEK -> 52 Wochen = 514,80', near(w(9.9, 'WEEK') * 52, 514.8));

  // MONTH -> Woche = Monat*12/52, auf Cent gerundet (9,92). Der 52-Wochen-Betrag auf dem PDF
  // ist bewusst der ANGEZEIGTE Wochenwert × 52 (also 9,92 × 52 = 515,84) – in sich konsistent.
  ok('3. MONTH 43 -> 9,92/Woche', near(w(43, 'MONTH'), 9.92));
  ok('4. MONTH: 52 Wochen = gerundeter Wochenwert × 52 (515,84)', near(w(43, 'MONTH') * 52, 515.84));

  // YEAR -> Woche = Jahr/52
  ok('5. YEAR 520 -> 10,00/Woche', near(w(520, 'YEAR'), 10));

  // DAY -> Woche = Tag*7
  ok('6. DAY 2 -> 14,00/Woche', near(w(2, 'DAY'), 14));

  // QUARTER -> Woche = Quartal*4/52
  ok('7. QUARTER 130 -> 10,00/Woche', near(w(130, 'QUARTER'), 10));

  // Unbekannte/leere Einheit -> als Wochenbeitrag interpretiert (Studio rechnet wöchentlich)
  ok('8. leere Einheit -> Wochenbeitrag', near(w(9.9, null), 9.9));
  ok('9. unbekannte Einheit -> Wochenbeitrag', near(w(9.9, 'FOO'), 9.9));

  // Ungültige/leere Preise -> null (Zeilen werden dann weggelassen)
  ok('10. 0 -> null', w(0, 'WEEK') === null);
  ok('11. negativ -> null', w(-5, 'WEEK') === null);
  ok('12. null -> null', w(null, 'WEEK') === null);
  ok('13. NaN-String -> null', w('abc', 'WEEK') === null);

  // Rundung auf 2 Nachkommastellen
  ok('14. rundet auf 2 Stellen', w(43, 'MONTH') === Math.round((43 * 12 / 52) * 100) / 100);

  console.log(pass ? 'MEMBERSHIP-PRICE PASS' : 'MEMBERSHIP-PRICE FAIL');
  process.exit(pass ? 0 : 1);
}
run();
