'use strict';
// Prüft die deterministische Bestätigungs-Textung der WhatsApp-App-Aktionen
// (lib/waAgent.js): Essen-Eintrag, Wasser, Tagesstand und Fehlermeldung – ohne KI.
const WAAgent = require('../lib/waAgent');

function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  const stand = { kcal: 1200, kcalZiel: 2000, eiweissG: 90, eiweissZielG: 150, khG: 100, fettG: 40, wasserGlaeser: 4, wasserZielGlaeser: 10 };

  // ── compact() ──
  const c = WAAgent.compact({ today: { totals: { kcal: 1234.6, p: 89.4, c: 100, f: 40 }, water: 3.5, waterGoal: 10 }, targets: { kcal: 2000, protein: 150, carbs: 200, fat: 60 } });
  ok('1. compact rundet kcal', c.kcal === 1235 && c.kcalZiel === 2000, JSON.stringify(c));
  ok('2. compact Eiweiß + Ziel', c.eiweissG === 89 && c.eiweissZielG === 150);
  ok('3. compact Wasser + Ziel', c.wasserGlaeser === 3.5 && c.wasserZielGlaeser === 10);

  // ── replyFor() ──
  const rFood = WAAgent.replyFor([{ ok: true, kind: 'log_food', added: [{ name: 'Hähnchen mit Reis', kcal: 450 }], stand: stand }]);
  ok('4. Essen: nennt Eintrag + kcal', /Eingetragen: Hähnchen mit Reis \(~450 kcal\)/.test(rFood), rFood);
  ok('5. Essen: Tagesbilanz', /heute 1200 von 2000 kcal/.test(rFood) && /Eiweiß 90\/150 g/.test(rFood), rFood);
  ok('6. Essen: Motivations-Emoji', /💪$/.test(rFood.trim()), rFood);

  const rWater = WAAgent.replyFor([{ ok: true, kind: 'add_water', glasses: 2, stand: stand }]);
  ok('7. Wasser: Bestätigung + Plural', /Wasser notiert \(\+2 Gläser\)/.test(rWater), rWater);

  const rWater1 = WAAgent.replyFor([{ ok: true, kind: 'add_water', glasses: 1, stand: stand }]);
  ok('8. Wasser: Singular korrekt', /\(\+1 Glas\)/.test(rWater1), rWater1);

  const rStatus = WAAgent.replyFor([{ ok: true, kind: 'nutrition_today', stand: stand }]);
  ok('9. Tagesstand: Bilanz ohne „Eingetragen"', /heute 1200 von 2000 kcal/.test(rStatus) && !/Eingetragen/.test(rStatus), rStatus);
  ok('10. Tagesstand: kein Aktions-Emoji', !/💪/.test(rStatus), rStatus);

  const rFail = WAAgent.replyFor([{ ok: false, message: 'Ich konnte kein Lebensmittel erkennen – beschreib es bitte etwas genauer.' }]);
  ok('11. Fehlschlag: klare Meldung', /kein Lebensmittel erkennen/.test(rFail), rFail);

  const toolNames = WAAgent.ACTION_TOOLS.map((t) => t.name);
  const expected = ['log_food', 'add_water', 'nutrition_today', 'list_appointments', 'cancel_appointment', 'list_bookable_types', 'find_appointment_slots', 'book_appointment', 'log_weight_checkin', 'log_workout', 'present_options'];
  const missing = expected.filter((n) => toolNames.indexOf(n) < 0);
  ok('12. Alle Aktions-Werkzeuge vorhanden (Ernährung, Termine, Gewicht, Training, Auswahl)', missing.length === 0, 'fehlt: ' + missing.join(', '));
  ok('13. Jedes Werkzeug hat name + input_schema', WAAgent.ACTION_TOOLS.every((t) => t.name && t.input_schema && t.input_schema.type === 'object'));

  // ── buildChoice(): present_options-Eingabe -> Buttons + nummerierter Fallback ──
  const ch = WAAgent.buildChoice({ text: 'Welche Einweisung interessiert dich?', options: ['Einführungstraining', 'Biocircuit', 'Trainingsplanung'] });
  ok('14. buildChoice: body + 3 Optionen', !!ch && ch.body === 'Welche Einweisung interessiert dich?' && ch.options.length === 3, JSON.stringify(ch));
  ok('15. buildChoice: stabile ids + Titel', !!ch && ch.options[1].id === 'opt_2' && ch.options[1].title === 'Biocircuit');
  ok('16. buildChoice: nummerierter Fallback-Text', !!ch && /1\. Einführungstraining/.test(ch.numbered) && /2\. Biocircuit/.test(ch.numbered) && /3\. Trainingsplanung/.test(ch.numbered), ch && ch.numbered);
  ok('17. buildChoice: <2 Optionen -> null', WAAgent.buildChoice({ text: 'x', options: ['nur eins'] }) === null);

  // ── openingMessage(): Verlauf als Kontext-Vorspann, „2" bekommt Bezug ──
  const om = WAAgent.openingMessage([{ role: 'user', text: 'Ich möchte einen Termin zur Einweisung' }, { role: 'assistant', text: '1. Einführungstraining 2. Biocircuit 3. Trainingsplanung' }], '2');
  ok('18. openingMessage: enthält Verlauf + aktuelle Nachricht', /Bisheriger WhatsApp-Verlauf/.test(om) && /FINN: 1\. Einführungstraining/.test(om) && /Aktuelle Nachricht des Mitglieds: 2/.test(om), om);
  ok('19. openingMessage: ohne Verlauf nur die Frage', WAAgent.openingMessage([], 'Wie viele kcal habe ich noch?') === 'Aktuelle Nachricht des Mitglieds: Wie viele kcal habe ich noch?');

  console.log(pass ? 'WA-AGENT PASS' : 'WA-AGENT FAIL');
  process.exit(pass ? 0 : 1);
}
run();
