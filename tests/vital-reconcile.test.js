'use strict';
// Vital-Check Reconciliation (lib/morning.js): der 138-ms-Ausreißer darf keinen
// Übertrainings-Fehlalarm auslösen, und dayVerdict() liefert GENAU EIN widerspruchsfreies
// Tages-Urteil (kein „Vollgas" + „Ruhetag" gleichzeitig). Reine Funktionen, kein Store nötig.
const path = require('path');
const MO = require(path.resolve(__dirname, '..', 'lib', 'morning.js'));

let pass = true;
const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

// Echte Messreihe aus den Screenshots (neueste zuerst). 19.07. = 138 ms ist ein als RMSSD
// fehl-importierter SDNN-Wert (Ausreißer). Baseline-HRV der übrigen Tage ~43 ms.
const REAL = [
  { date: '2026-07-22', rhr: 59, hrvRmssd: 69 },
  { date: '2026-07-21', rhr: 60, hrvRmssd: 43 },
  { date: '2026-07-20', rhr: 65, hrvRmssd: 43 },
  { date: '2026-07-19', rhr: 61, hrvRmssd: 138 },
  { date: '2026-07-18', rhr: 63, hrvRmssd: 42 },
];

// 0) winsorizeHrv zieht den 138er in den plausiblen Korridor (median≈43 -> Kappe ~86).
const w = MO.winsorizeHrv([42, 43, 43, 138]);
ok('0. winsorize kappt 138 -> <= median*2', Math.max.apply(null, w) <= 43 * 2 + 0.1);
ok('0b. winsorize lässt normale Werte unberührt', w.indexOf(42) >= 0 && w.indexOf(43) >= 0);

// 1) readiness: heute (59/69) ist gegen die robuste Baseline (rhr~62, hrv~43) klar GRÜN.
const base = MO.baseline(REAL);
const r = MO.readiness(REAL[0], base);
ok('1. Baseline-HRV robust (~43, nicht vom 138er verzogen)', base.hrv != null && base.hrv <= 60);
ok('1b. readiness heute = gruen', r.level === 'gruen' && r.score >= 75);

// 2) KERNFIX: overtraining darf NICHT „alert" sein (früher Fehlalarm durch den 138er).
const ot = MO.overtraining(REAL);
ok('2. overtraining KEIN Fehlalarm', ot.level === 'ok');

// 3) dayVerdict ohne Pause: EIN Urteil = voll/gruen (heute top erholt).
const vNoRec = MO.dayVerdict({ readiness: r, overtraining: ot, recovery: null, latest: REAL[0] });
ok('3. Verdict ohne Pause -> voll/gruen', vNoRec.intensity === 'voll' && vNoRec.level === 'gruen');
ok('3b. nicht stale', vNoRec.recoveryStale === false);

// 4) dayVerdict mit AKTIVER, aber „stale" Pause (heute grün): kein harter Ruhetag mehr,
//    sondern der echte grüne Zustand + recoveryStale=true (Vorschlag: Pause beenden).
const vStale = MO.dayVerdict({ readiness: r, overtraining: ot, recovery: { active: true, until: '2030-01-01' }, latest: REAL[0] });
ok('4. Verdict: aktive Pause + heute grün -> stale', vStale.recoveryStale === true);
ok('4b. stale -> NICHT „ruhe" (kein Widerspruch Vollgas/Pause)', vStale.intensity === 'voll');

// 5) dayVerdict mit AKTIVER Pause und heute ROT: Pause gewinnt -> ruhe, nicht stale.
const redToday = { date: '2026-07-22', rhr: 80, hrvRmssd: 25 };
const rRed = MO.readiness(redToday, base);
const vRec = MO.dayVerdict({ readiness: rRed, overtraining: MO.overtraining([redToday].concat(REAL.slice(1))), recovery: { active: true, until: '2030-01-01' }, latest: redToday });
ok('5. Verdict: aktive Pause + heute rot -> ruhe', vRec.intensity === 'ruhe' && vRec.source === 'recovery');
ok('5b. nicht stale', vRec.recoveryStale === false);

// 6) Weiches subjektives Signal (schlecht geschlafen) kippt die objektiv gute Erholung NICHT
//    nach unten (sonst „100-Score, aber moderat"-Widerspruch) – bleibt voll/grün + Hinweis.
const vSubj = MO.dayVerdict({ readiness: r, overtraining: ot, recovery: null, latest: Object.assign({}, REAL[0], { sleepSelf: 'schlecht' }) });
ok('6. grün + schlecht geschlafen -> bleibt voll/grün', vSubj.intensity === 'voll' && vSubj.level === 'gruen');
ok('6b. subjektiver Hinweis als note (kein Level-Downgrade)', !!vSubj.note && /geschlafen/.test(vSubj.note) && vSubj.source === 'physio+hinweis');
// 6c) Krankheit ist der EINZIGE subjektive Faktor, der überstimmt -> Ruhetag.
const vSick = MO.dayVerdict({ readiness: r, overtraining: ot, recovery: null, latest: Object.assign({}, REAL[0], { sick: 1 }) });
ok('6c. krank -> Ruhetag (Sicherheit)', vSick.intensity === 'ruhe' && vSick.source === 'krank');

// 7) Echter Übertrainings-Alarm (nachhaltig gedämpfte HRV) -> ruhe.
const strained = [
  { date: '2026-07-22', rhr: 70, hrvRmssd: 28 },
  { date: '2026-07-21', rhr: 71, hrvRmssd: 27 },
  { date: '2026-07-20', rhr: 69, hrvRmssd: 29 },
  { date: '2026-07-19', rhr: 60, hrvRmssd: 45 },
  { date: '2026-07-18', rhr: 61, hrvRmssd: 44 },
  { date: '2026-07-17', rhr: 60, hrvRmssd: 46 },
];
const otA = MO.overtraining(strained);
ok('7. echter Alarm wird erkannt', otA.level === 'alert');
const vAlert = MO.dayVerdict({ readiness: MO.readiness(strained[0], MO.baseline(strained)), overtraining: otA, recovery: null, latest: strained[0] });
ok('7b. Alarm -> Verdict ruhe', vAlert.intensity === 'ruhe' && vAlert.source === 'alert');

// 8) toPromptText nennt genau EIN Fazit + Gegencheck-Pflicht, kein rohes Doppel-Signal.
const txt = MO.toPromptText(REAL, { age: 40 });
ok('8. FINN-Prompt enthält EIN FAZIT', txt.indexOf('FAZIT HEUTE') >= 0);
ok('8b. FINN-Prompt enthält Gegencheck-Pflicht', txt.indexOf('GEGENCHECK-PFLICHT') >= 0);
ok('8c. kein roher Doppel-Alarm mehr', txt.indexOf('ACHTUNG Übertrainings-Signal') < 0);

console.log(pass ? 'VITAL-RECONCILE PASS' : 'VITAL-RECONCILE FAIL');
process.exit(pass ? 0 : 1);
