'use strict';
// Buchbare Terminarten (Stoffwechselberatung, Einweisung, Trainingsplanung …)
// fuer den Telefonassistenten.
//
// Der heikle Teil ist die Zuordnung: Der Anrufer sagt einen Namen, die
// Spracherkennung macht daraus irgendetwas Aehnliches, und daraus muss die
// RICHTIGE Terminart werden. Eine Stoffwechselberatung zu buchen, wo eine
// Einweisung gemeint war, ist schlimmer als eine Rueckfrage.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { hasStore: false, redisPipeline: async () => [null] } };

const B = require(path.join(ROOT, 'lib/bookable.js'));

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// Wie die Arten in Magicline typischerweise heissen.
const ARTEN = [
  { id: '101', title: 'Stoffwechselberatung', duration: 45, category: 'Beratung' },
  { id: '102', title: 'Geräteeinweisung', duration: 60, category: 'Training' },
  { id: '103', title: 'Trainingsplanung', duration: 45, category: 'Training' },
  { id: '104', title: 'Ernährungsberatung', duration: 30, category: 'Beratung' },
];

// ── 1. Der Normalfall: gesagt wie angelegt ──
ok('1. Genauer Name trifft', B.matchType(ARTEN, 'Stoffwechselberatung').type.id === '101');
ok('1b. Gross/Kleinschreibung egal', B.matchType(ARTEN, 'stoffwechselberatung').type.id === '101');
ok('1c. Umlaute aus der Spracherkennung', B.matchType(ARTEN, 'Geraeteeinweisung').type.id === '102',
  JSON.stringify(B.matchType(ARTEN, 'Geraeteeinweisung').type));
ok('1d. … und mit echtem Umlaut genauso', B.matchType(ARTEN, 'Geräteeinweisung').type.id === '102');

// ── 2. So, wie man es wirklich sagt ──
ok('2. Kurzform „Stoffwechsel"', B.matchType(ARTEN, 'Stoffwechsel').type.id === '101');
ok('2b. „Einweisung" ohne „Geräte"', B.matchType(ARTEN, 'Einweisung').type.id === '102',
  JSON.stringify(B.matchType(ARTEN, 'Einweisung')));
ok('2c. Getrennt gesprochen: „Trainings Planung"', B.matchType(ARTEN, 'Trainings Planung').type.id === '103',
  JSON.stringify(B.matchType(ARTEN, 'Trainings Planung')));
ok('2d. Ganzer Satz drumherum', B.matchType(ARTEN, 'ich möchte eine Stoffwechselberatung').type.id === '101',
  JSON.stringify(B.matchType(ARTEN, 'ich möchte eine Stoffwechselberatung')));

// ── 3. Mehrdeutig -> KEIN Treffer, sondern Rueckfrage ──
// „Beratung" passt auf Stoffwechsel- UND Ernaehrungsberatung. Raten waere hier
// der teuerste Fehler: der Anrufer erscheint zum falschen Termin.
const mehr = B.matchType(ARTEN, 'Beratung');
ok('3. Mehrdeutiges bleibt ohne Treffer', mehr.type === null, JSON.stringify(mehr.type));
ok('3b. … nennt aber die passenden Kandidaten', mehr.kandidaten.length === 2
  && mehr.kandidaten.every(function (t) { return /beratung/i.test(t.title); }), JSON.stringify(mehr.kandidaten));
// Verglichen wird nur der TITEL, nicht die Kategorie - der Anrufer nennt den
// Namen des Termins. „Training" trifft deshalb eindeutig die Trainingsplanung,
// obwohl die Einweisung in derselben Kategorie liegt.
ok('3c. Nur der Titel zaehlt, nicht die Kategorie',
  B.matchType(ARTEN, 'Training').type.id === '103');
// Kommt eine zweite Art mit demselben Wortstamm dazu, muss die Sperre greifen.
const MIT_ZWEITER = ARTEN.concat([{ id: '105', title: 'Trainingsberatung', duration: 30, category: 'Beratung' }]);
const mehr2 = B.matchType(MIT_ZWEITER, 'Training');
ok('3d. Zwei Arten mit demselben Wortstamm -> Rueckfrage', mehr2.type === null, JSON.stringify(mehr2.type));
ok('3e. … und beide werden zur Auswahl genannt', mehr2.kandidaten.length === 2,
  JSON.stringify(mehr2.kandidaten.map(function (t) { return t.title; })));
// Der genaue Name muss trotzdem weiter eindeutig treffen.
ok('3f. Der volle Name bleibt eindeutig',
  B.matchType(MIT_ZWEITER, 'Trainingsplanung').type.id === '103'
  && B.matchType(MIT_ZWEITER, 'Trainingsberatung').type.id === '105');

// ── 4. Nichts gesagt / Unsinn ──
const leer = B.matchType(ARTEN, '');
ok('4. Ohne Angabe kein Treffer, aber die volle Liste',
  leer.type === null && leer.kandidaten.length === 4);
const quatsch = B.matchType(ARTEN, 'Fahrradreparatur');
ok('4b. Etwas, das es nicht gibt, wird nicht erfunden', quatsch.type === null, JSON.stringify(quatsch.type));
ok('4c. … und die Liste kommt zur Auswahl mit', quatsch.kandidaten.length === 4);
ok('4d. Leere Artenliste stuerzt nicht ab', B.matchType([], 'Einweisung').type === null
  && B.matchType(null, 'Einweisung').type === null);

// ── 5. Die ID direkt (aus einer frueheren Antwort) ──
ok('5. ID trifft die Art', B.matchType(ARTEN, '103').type.id === '103');
ok('5b. Unbekannte ID erfindet nichts', B.matchType(ARTEN, '999').type === null);

// ── 6. Kurze Woerter duerfen nicht querschlagen ──
// „ein" steckt in „Einweisung"; ohne Mindestlaenge wuerde jedes Fuellwort treffen.
const kurz = B.matchType(ARTEN, 'ein Termin bitte');
ok('6. Fuellwoerter loesen keinen Zufallstreffer aus', kurz.type === null, JSON.stringify(kurz.type));

// ── 7. Normalisierung ──
ok('7. norm entfernt Trennzeichen', B.norm('Geräte-Einweisung') === B.norm('geraeteeinweisung'));
ok('7b. … und Leerzeichen', B.norm('Trainings Planung') === B.norm('trainingsplanung'));

// ── 8. Die ECHTEN Terminarten von Fit-Inn Trier ──
// Aus Magicline uebernommen. Der Abgleich muss gegen diese Namen sitzen, nicht
// gegen ausgedachte - die deutschen Zusammenschreibungen sind hier das Problem.
const ECHT = [
  { id: '1', title: 'Beratung Stoffwechsel-Coaching', duration: 90, category: 'Termin-Leistung' },
  { id: '2', title: 'Biocircuit Einweisung', duration: 30, category: 'Termin-Leistung' },
  { id: '3', title: 'Einführungstraining', duration: 60, category: 'Termin-Leistung' },
  { id: '4', title: 'Gesundheits-Check-Up', duration: 60, category: 'Termin-Leistung' },
  { id: '5', title: 'Stoffwechsel Analyse', duration: 90, category: 'Termin-Leistung' },
  { id: '6', title: 'Trainingsplanung', duration: 45, category: 'Termin-Leistung' },
];
const treffer = (q) => { const r = B.matchType(ECHT, q); return r.type ? r.type.title : null; };

ok('9. Genaue Namen treffen', treffer('Stoffwechsel Analyse') === 'Stoffwechsel Analyse'
  && treffer('Trainingsplanung') === 'Trainingsplanung'
  && treffer('Einführungstraining') === 'Einführungstraining');
// Im Deutschen wird zusammengeschrieben, was das Studio getrennt benannt hat.
// „Stoffwechselberatung" ist EIN Wort - vorher fand das gar nichts.
ok('10. Zusammengeschrieben trifft den getrennten Titel',
  treffer('Stoffwechselberatung') === 'Beratung Stoffwechsel-Coaching', String(treffer('Stoffwechselberatung')));
ok('10b. … auch bei der Analyse', treffer('Stoffwechselanalyse') === 'Stoffwechsel Analyse',
  String(treffer('Stoffwechselanalyse')));
ok('10c. … und beim Check-Up', treffer('Gesundheitscheckup') === 'Gesundheits-Check-Up',
  String(treffer('Gesundheitscheckup')));
ok('10d. Im ganzen Satz genauso',
  treffer('ich möchte eine Stoffwechselberatung') === 'Beratung Stoffwechsel-Coaching');
// Kurzformen
ok('11. „Coaching" trifft eindeutig', treffer('Coaching') === 'Beratung Stoffwechsel-Coaching');
ok('11b. „Analyse" trifft eindeutig', treffer('Analyse') === 'Stoffwechsel Analyse');
ok('11c. „Check-Up" trifft eindeutig', treffer('Check-Up') === 'Gesundheits-Check-Up');
ok('11d. „Biocircuit" trifft eindeutig', treffer('Biocircuit') === 'Biocircuit Einweisung');
ok('11e. Umlaut aus der Spracherkennung', treffer('Einfuehrungstraining') === 'Einführungstraining');

// Das Wichtigste: Das Studio hat ZWEI Stoffwechsel-Angebote (90 Min. Coaching
// und 90 Min. Analyse) und ZWEI Trainings-Angebote. Wer nur „Stoffwechsel" sagt,
// darf keinen Zufallstreffer bekommen.
const stw = B.matchType(ECHT, 'Stoffwechsel');
ok('12. Blosses „Stoffwechsel" ist mehrdeutig -> Rueckfrage', stw.type === null, String(stw.type && stw.type.title));
ok('12b. … und nennt genau die beiden Stoffwechsel-Angebote',
  stw.kandidaten.length === 2 && stw.kandidaten.every(function (t) { return /stoffwechsel/i.test(t.title); }),
  JSON.stringify(stw.kandidaten.map(function (t) { return t.title; })));
const tr = B.matchType(ECHT, 'Training');
ok('12c. Blosses „Training" ebenso', tr.type === null && tr.kandidaten.length === 2,
  JSON.stringify(tr.kandidaten.map(function (t) { return t.title; })));
// Nichts erfinden.
ok('13. Etwas, das es nicht gibt, trifft nichts', treffer('Fahrradreparatur') === null);
ok('13b. Fuellwoerter treffen nichts', treffer('ein Termin bitte') === null);
ok('13c. … und liefern die volle Auswahl zurueck',
  B.matchType(ECHT, 'ein Termin bitte').kandidaten.length === 6);

// ── 8b. Die Fenstergrenze der API ──
// daysAhead ist auf 6 begrenzt; ein groesserer Zeitraum entsteht nur aus
// mehreren Fenstern. Steht die Zahl falsch, liefert Magicline nichts.
ok('8. Fenstergroesse entspricht der API-Vorgabe', B.WINDOW === 6, String(B.WINDOW));

console.log(pass ? 'BOOKABLE PASS' : 'BOOKABLE FAIL');
process.exit(pass ? 0 : 1);
