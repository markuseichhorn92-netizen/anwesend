'use strict';
// FINN-Kassenbuch-Prüfung: der Parser (lib/ai.js kbParseFindings) muss die
// KI-Antwort robust zu validierten Befunden verarbeiten – auch bei Text drumherum,
// Müll oder unerlaubten Aktionen. Keine KI-/Netzwerkaufrufe.
const path = require('path');
const AI = require(path.resolve(__dirname, '..', 'lib', 'ai.js'));
const P = AI.kbParseFindings;

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

// 1. Sauberes Array wird übernommen.
const a = P('[{"spalte":"Ausgaben","tag":6,"schwere":"warnung","titel":"Große Anschaffung","problem":"1413,60 € Miele – ggf. Anlagevermögen/AfA.","vorschlag":"Mit Steuerberater klären.","aktion":null}]');
ok('1. ein Befund geparst', a.length === 1 && a[0].spalte === 'Ausgaben' && a[0].tag === 6 && a[0].schwere === 'warnung');
ok('1b. aktion null bleibt null', a[0].aktion === null);

// 2. Text vor/nach dem JSON wird ignoriert (nur das Array zählt).
const b = P('Klar, hier meine Befunde:\n[{"titel":"Beleg fehlt","problem":"Tag 3 ohne Beschreibung","vorschlag":"Zweck ergänzen","spalte":"Ausgaben","tag":3}]\nViele Grüße');
ok('2. JSON aus Fließtext extrahiert', b.length === 1 && b[0].titel === 'Beleg fehlt' && b[0].tag === 3);
ok('2b. fehlende schwere -> hinweis', b[0].schwere === 'hinweis');

// 3. dayText-Aktion validiert (gültiges Feld + Tag + Text).
const c = P('[{"spalte":"Sonstiges","tag":4,"schwere":"hinweis","titel":"Privateinlage kennzeichnen","problem":"500 € ohne Kennzeichnung","vorschlag":"Als Privateinlage markieren","aktion":{"typ":"dayText","tag":4,"feld":"sonstigesText","text":"Privateinlage"}}]');
ok('3. dayText-Aktion übernommen', c[0].aktion && c[0].aktion.typ === 'dayText' && c[0].aktion.tag === 4 && c[0].aktion.feld === 'sonstigesText' && c[0].aktion.text === 'Privateinlage');

// 4. Ungültiges Aktionsfeld -> Aktion verworfen (Befund bleibt).
const d = P('[{"titel":"X","problem":"y","aktion":{"typ":"dayText","tag":4,"feld":"HACK","text":"boom"}}]');
ok('4. ungültiges feld -> aktion null', d.length === 1 && d[0].aktion === null);

// 5. gezaehlt-Aktion validiert (Zahl).
const e = P('[{"spalte":"Kassensturz","titel":"Bestand zählen","problem":"Kein gezählter Bestand","vorschlag":"Zählen","aktion":{"typ":"gezaehlt","wert":"633,06"}}]');
ok('5. gezaehlt: nur echte Zahl', e[0].aktion === null); // "633,06" ist keine JS-Number -> verworfen
const e2 = P('[{"titel":"Bestand","problem":"p","aktion":{"typ":"gezaehlt","wert":633.06}}]');
ok('5b. gezaehlt mit Number ok', e2[0].aktion && e2[0].aktion.typ === 'gezaehlt' && e2[0].aktion.wert === 633.06);

// 6. Müll / kein Array -> leer.
ok('6. kein JSON -> []', P('Alles gut, keine Beanstandungen.').length === 0);
ok('6b. leeres Array -> []', P('[]').length === 0);
ok('6c. defektes JSON -> []', P('[{titel:kaputt}]').length === 0);

// 7. Kappung: max 10 Befunde; Tag außerhalb 1..31 -> null.
const many = '[' + Array.from({ length: 15 }, (_, i) => '{"titel":"t' + i + '","problem":"p"}').join(',') + ']';
ok('7. max 10 Befunde', P(many).length === 10);
ok('7b. Tag 99 -> null', P('[{"titel":"t","problem":"p","tag":99}]')[0].tag === null);

// 8. Leere Befunde (ohne titel/problem) werden übersprungen.
ok('8. leerer Befund übersprungen', P('[{"spalte":"Ausgaben"},{"titel":"echt","problem":"da"}]').length === 1);

console.log(pass ? 'KASSENBUCH-FINN PASS' : 'KASSENBUCH-FINN FAIL');
process.exit(pass ? 0 : 1);
