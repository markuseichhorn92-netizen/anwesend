'use strict';
// Vital-Akku: lib/battery.js compute() – reine Funktion (Ladung aus Erholung+Schlaf,
// Entladung aus Trainingslast/Übertraining/Regenerationsmodus). Keine Store-Mocks nötig.
const path = require('path');
const B = require(path.resolve(__dirname, '..', 'lib', 'battery.js'));

const NOW = 1_700_000_000_000;   // fester Zeitpunkt (Aktualität der letzten Einheit)
const h = (n) => NOW - n * 3.6e6;

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

// 1) Kein Erholungs-Score -> kein Akku (nur mit HRV/Health-Daten sichtbar).
const none = B.compute({ readiness: null, now: NOW });
ok('1. ohne Score -> hasData:false', none.hasData === false && none.level === null);
const noScore = B.compute({ readiness: { score: null, level: 'kalibrierung' }, now: NOW });
ok('1b. score:null -> hasData:false', noScore.hasData === false);

// 2) Hohe Erholung + guter Schlaf, keine Last -> hoch/grün.
const fresh = B.compute({ readiness: { score: 88 }, sleepDetail: { score: 82 }, weekLoad: { trimp: 0, lastLoad: 0, lastTs: null }, now: NOW });
ok('2. erholt+ausgeschlafen -> hoch', fresh.hasData === true && fresh.level >= 80);
ok('2b. tone grün', fresh.tone === 'gruen');
ok('2c. Faktor „Erholung stark" +', fresh.factors.some((f) => f.label === 'Erholung stark' && f.dir === '+'));
ok('2d. Faktor „Schlaf gut" +', fresh.factors.some((f) => f.label === 'Schlaf gut'));

// 3) Harte Einheit HEUTE entlädt spürbar (gleicher Ladezustand, nur mehr Last).
const restedNoLoad = B.compute({ readiness: { score: 70 }, sleepDetail: { score: 70 }, now: NOW });
const hardToday = B.compute({ readiness: { score: 70 }, sleepDetail: { score: 70 }, weekLoad: { trimp: 120, lastLoad: 120, lastTs: h(2) }, now: NOW });
ok('3. harte Einheit heute senkt den Akku', hardToday.level < restedNoLoad.level);
ok('3b. Entladung > 0', hardToday.drain > 0);
ok('3c. Faktor „Training heute" -', hardToday.factors.some((f) => f.label === 'Training heute' && f.dir === '-'));

// 3d) Dieselbe Einheit vor 3 Tagen entlädt kaum noch (Aktualitätsgewichtung).
const hardOld = B.compute({ readiness: { score: 70 }, sleepDetail: { score: 70 }, weekLoad: { trimp: 120, lastLoad: 120, lastTs: h(72) }, now: NOW });
ok('3d. alte Einheit entlädt weniger als frische', hardOld.level > hardToday.level);

// 4) Aktiver Regenerationsmodus + Übertraining-Alarm drücken deutlich Richtung Reserve.
const rec = B.compute({ readiness: { score: 60 }, recoveryActive: true, overtraining: { level: 'alert' }, now: NOW });
ok('4. Regeneration+Übertraining -> niedrig/rot', rec.level < 40 && rec.tone === 'rot');
ok('4b. Faktoren nennen Regeneration/Übertraining', rec.factors.some((f) => /Regeneration|Übertraining/.test(f.label)));

// 5) Grenzen: nie < 5 oder > 100; Faktoren max. 3.
const floor = B.compute({ readiness: { score: 20 }, sleepDetail: { score: 20 }, weekLoad: { trimp: 900, lastLoad: 300, lastTs: h(1) }, recoveryActive: true, overtraining: { level: 'alert' }, now: NOW });
ok('5. Untergrenze 5 eingehalten', floor.level >= 5 && floor.level <= 100);
const ceil = B.compute({ readiness: { score: 100 }, sleepDetail: { score: 100 }, now: NOW });
ok('5b. Obergrenze 100 eingehalten', ceil.level <= 100);
ok('5c. max. 3 Faktor-Chips', floor.factors.length <= 3);

// 6) Quelle wird durchgereicht.
ok('6. source durchgereicht', B.compute({ readiness: { score: 75 }, source: 'passiv', now: NOW }).source === 'passiv');

// 7) Ohne Schlaf-Score = reine Erholung als Ladung.
const noSleep = B.compute({ readiness: { score: 64 }, now: NOW });
ok('7. ohne Schlaf: Ladung = Erholung', noSleep.charge === 64);

console.log(pass ? 'BATTERY PASS' : 'BATTERY FAIL');
process.exit(pass ? 0 : 1);
