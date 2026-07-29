'use strict';
// Prüft die feste Wochen-Schichtvorlage (lib/shifts.templateSpecs): die tatsächlichen
// Studio-Schichten pro Wochentag (Mo–Fr 5, Sa 2, So 2), korrekte Zeiten & Reihenfolge.
// Rein rechnerisch – kein Store, kein Magicline. Testet ISO-Tage einer bekannten Woche.
const SH = require('../lib/shifts');

function run() {
  let pass = true;
  const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // Woche Mo 2026-08-03 … So 2026-08-09 (2026-08-03 ist ein Montag).
  const mon = '2026-08-03';
  const week = SH.weekDates(mon);
  ok('0. weekDates: 7 Tage ab Montag', week.length === 7 && week[0] === '2026-08-03' && week[6] === '2026-08-09', week.join(','));

  const specs = SH.templateSpecs(week);
  const byDate = {};
  specs.forEach((s) => { (byDate[s.date] = byDate[s.date] || []).push(s.start + '-' + s.end); });

  // ── Montag (Werktag): 5 Schichten ──
  ok('1. Mo: 5 Schichten', (byDate['2026-08-03'] || []).length === 5, JSON.stringify(byDate['2026-08-03']));
  ok('2. Mo: exakte Zeiten in Reihenfolge',
    JSON.stringify(byDate['2026-08-03']) === JSON.stringify(['09:30-11:30', '11:30-13:00', '15:00-17:30', '17:30-19:30', '19:30-21:30']),
    JSON.stringify(byDate['2026-08-03']));

  // ── Freitag: wie Werktag ──
  ok('3. Fr: 5 Schichten wie Werktag', JSON.stringify(byDate['2026-08-07']) === JSON.stringify(['09:30-11:30', '11:30-13:00', '15:00-17:30', '17:30-19:30', '19:30-21:30']), JSON.stringify(byDate['2026-08-07']));

  // ── Samstag: 2 Schichten ──
  ok('4. Sa: 2 Schichten', (byDate['2026-08-08'] || []).length === 2);
  ok('5. Sa: exakte Zeiten', JSON.stringify(byDate['2026-08-08']) === JSON.stringify(['13:00-16:00', '16:00-18:00']), JSON.stringify(byDate['2026-08-08']));

  // ── Sonntag: 2 Schichten ──
  ok('6. So: 2 Schichten', (byDate['2026-08-09'] || []).length === 2);
  ok('7. So: exakte Zeiten', JSON.stringify(byDate['2026-08-09']) === JSON.stringify(['09:00-12:00', '12:00-15:00']), JSON.stringify(byDate['2026-08-09']));

  // ── Summe der Woche: 5*5 + 2 + 2 = 29 ──
  ok('8. Woche gesamt 29 Schichten', specs.length === 29, 'ist ' + specs.length);

  // ── Rolle default 'theke', gültige Zeiten ──
  ok('9. Alle Specs: Rolle theke + gültige HH:MM', specs.every((s) => s.role === 'theke' && /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end)));

  // ── Robustheit: leere/ungültige Eingabe -> keine Specs, wirft nicht ──
  ok('10. leere Eingabe -> []', SH.templateSpecs([]).length === 0 && SH.templateSpecs(null).length === 0);
  ok('11. ungültiges Datum wird übersprungen', SH.templateSpecs(['nope', '2026-08-08']).length === 2);

  console.log(pass ? 'SHIFTS-TEMPLATE PASS' : 'SHIFTS-TEMPLATE FAIL');
  process.exit(pass ? 0 : 1);
}
run();
