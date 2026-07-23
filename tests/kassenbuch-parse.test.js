'use strict';
// FINN-Kassenbuchprüfung: die Modellantwort muss auch bei unsauberem JSON in
// strukturierte Befunde (Karten) münden, statt in die Rohtext-Ansicht zu kippen.
// Deckt die realen Bedrock/Haiku-Ausreißer ab: Codefences, typografische
// Anführungszeichen, Trailing-Kommas, in ein Objekt gehülltes Array, einzelne
// {…}-Objekte ohne Array-Klammern, JSON-Kommentare. Zugleich muss ein legitimes
// deutsches „…"-Zitat IM Wert unversehrt bleiben.

const path = require('path');
const AI = require(path.resolve(__dirname, '..', 'lib', 'ai.js'));
const P = AI.kbParseFindings;

const item = { spalte: 'Ausgaben', tag: 3, schwere: 'warnung', titel: 'Beleg fehlt',
  problem: 'Zur Ausgabe am 3. fehlt ein Belegzweck.', vorschlag: 'Beschreibung ergänzen.', aktion: null };

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
const n = (x) => { const r = P(x); return Array.isArray(r) ? r.length : -1; };

ok('1. sauberes Array', n(JSON.stringify([item])) === 1);
ok('2. Markdown-Codefence', n('```json\n' + JSON.stringify([item]) + '\n```') === 1);
ok('3. Prosa vor dem Array', n('Hier die Befunde:\n' + JSON.stringify([item]) + '\nSonst ok.') === 1);
ok('4. Array in Objekt gehüllt', n(JSON.stringify({ befunde: [item] })) === 1);
ok('5. Trailing-Komma', n('[\n' + JSON.stringify(item) + ',\n]') === 1);
ok('6. typografische Anführungszeichen', n(JSON.stringify([item]).replace(/"/g, '“')) === 1);
ok('7. einzelne {…}-Objekte ohne Array', n(JSON.stringify(item) + '\n' + JSON.stringify(item)) === 2);
ok('8. Array mit // Kommentar', n('[\n  // Befund\n  ' + JSON.stringify(item) + '\n]') === 1);
ok('9. einzelnes Objekt ohne Array', n(JSON.stringify(item)) === 1);

// Kein JSON -> leer (Client zeigt Hinweis-Kästchen mit Rohtext), niemals ein Fehler.
ok('10. leeres Array = keine Befunde', n('[]') === 0);
ok('11. reine Prosa/Bullets = keine Befunde', n('- Beleg fehlt: fehlender Belegzweck.') === 0);
ok('12. Leerantwort = keine Befunde', n('') === 0);

// Legitimes „…"-Zitat im Wert bleibt unversehrt (roher Parse zuerst, erst dann Normalisierung).
const withQuote = [{ titel: 'Hinweis', schwere: 'hinweis', spalte: 'Kaffee',
  problem: 'Es wurde „Kaffee“ ohne Betrag notiert.' }];
const parsed = P(JSON.stringify(withQuote));
ok('13. deutsches „…"-Zitat im Wert erhalten',
  parsed.length === 1 && parsed[0].problem.indexOf('„Kaffee“') >= 0);

// Aktion (dayText) übersteht das Bergen und wird validiert.
const withAction = [{ titel: 'Beschreibung fehlt', problem: 'Sonstiges am 5. ohne Text.', schwere: 'hinweis',
  spalte: 'Sonstiges', aktion: { typ: 'dayText', tag: 5, feld: 'sonstigesText', text: 'Getränke Einkauf' } }];
const pa = P('```json\n' + JSON.stringify(withAction) + ',\n```'.replace(',', ''));
ok('14. Aktion dayText bleibt erhalten',
  pa.length === 1 && pa[0].aktion && pa[0].aktion.typ === 'dayText' && pa[0].aktion.feld === 'sonstigesText');

// Höchstens 10 Befunde (Kappe gegen Wildwuchs).
const many = []; for (let i = 0; i < 20; i++) many.push(Object.assign({}, item, { titel: 'F' + i }));
ok('15. Kappe auf max. 10 Befunde', n(JSON.stringify(many)) === 10);

console.log(pass ? 'KASSENBUCH-PARSE PASS' : 'KASSENBUCH-PARSE FAIL');
process.exit(pass ? 0 : 1);
