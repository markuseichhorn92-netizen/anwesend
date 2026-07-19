'use strict';
// Passive Vitalwerte (lib/vitals.js): Sanitize (Apple-Health-Aliase/Klammern),
// persönliche Baseline (Median der Vortage), Whoop/Oura-artige Erholungs-Ampel
// aus Ruhepuls + HRV + Schlaf, Schlaf-Referenz, Trend, Prompt-Text für FINN.
const V = require('../lib/vitals');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const mk = (date, rhr, hrv, sleepMin) => V.sanitize({ date: date, restingHr: rhr, hrv: hrv, sleepMin: sleepMin });

  // 1. sanitize: Aliase, Klammern, Rundung
  const s = V.sanitize({ date: '2026-07-19', restingHr: 58, hrv: 62.4, sleepMin: 445.6, steps: 8432, vo2max: 47.6, weightKg: 82.4, bodyFatPct: 18.5 });
  ok('1. sanitize übernimmt Apple-Health-Werte', s.restingHr === 58 && s.hrv === 62.4 && s.sleepMin === 446 && s.steps === 8432 && s.vo2max === 47.6);
  ok('1b. sanitize: source=health, date übernommen', s.source === 'health' && s.date === '2026-07-19');
  ok('1c. sanitize: rhr-Alias + Ausreißer verworfen', V.sanitize({ rhr: 60 }).restingHr === 60 && V.sanitize({ restingHr: 200 }).restingHr === null && V.sanitize({ hrv: 1 }).hrv === null);
  ok('1d. sanitize: ohne Datum -> heute', /^\d{4}-\d{2}-\d{2}$/.test(V.sanitize({ restingHr: 60 }).date));
  ok('1e. hasAny false bei leer', V.hasAny(V.sanitize({})) === false && V.hasAny(s) === true);

  // 2. Baseline = Median der VORTAGE (ohne heute)
  const list = [mk('2026-07-19', 54, 62, 460), mk('2026-07-18', 55, 60, 450), mk('2026-07-17', 56, 61, 440), mk('2026-07-16', 55, 59, 455), mk('2026-07-15', 54, 60, 450)];
  const base = V.baseline(list);
  ok('2. Baseline RHR = Median der 4 Vortage (55)', base.rhr === 55);
  ok('2b. Baseline HRV (60)', base.hrv === 60);
  ok('2c. Baseline Schlaf (450 min)', base.sleepMin === 450);
  ok('2d. nicht mehr in Kalibrierung', base.calibrating === false && base.rhrN === 4);

  // 3. Kalibrierung: zu wenige Vortage
  ok('3. <MIN_CALIB Vortage -> calibrating', V.baseline([mk('2026-07-19', 60, 55, 450), mk('2026-07-18', 58, 57, 440)]).calibrating === true);

  // 4. Erholungs-Ampel: gut erholt = grün
  ok('4. readiness grün (im Bereich der Baseline)', V.readiness(list[0], base).level === 'gruen');
  // 5. schlechte Werte (RHR hoch, HRV runter, wenig Schlaf) = rot
  const bad = mk('2026-07-20', 68, 40, 300);
  const rBad = V.readiness(bad, base);
  ok('5. readiness rot bei hohem Ruhepuls + niedriger HRV + wenig Schlaf', rBad.level === 'rot' && rBad.score < 55);
  // 6. ohne Baseline -> Kalibrierung
  ok('6. readiness ohne Baseline -> kalibrierung', V.readiness(list[0], V.baseline([list[0]])).level === 'kalibrierung');

  // 7. Schlaf-Referenz
  ok('7. sleepRef 7,5 h -> good', V.sleepRef(mk('x', 55, 60, 450), base).cat === 'good');
  ok('7b. sleepRef 6 h -> warn', V.sleepRef(mk('x', 55, 60, 360), base).cat === 'warn');
  ok('7c. sleepRef 5 h -> bad', V.sleepRef(mk('x', 55, 60, 300), base).cat === 'bad');
  ok('7d. sleepRef Label + Ref', V.sleepRef(list[0], base).label === '7h 40m' && /Schnitt 7h 30m/.test(V.sleepRef(list[0], base).ref));

  // 8. Trend seit Vortag
  const tr = V.trend(list);
  ok('8. trend: Ruhepuls -1 seit gestern', tr && tr.since && tr.since.rhr === -1);

  // 9. Prompt-Text für FINN
  const pt = V.toPromptText(list);
  ok('9. toPromptText nennt Schlaf + Erholungs-Ampel', /Schlaf letzte Nacht 7h 40m/.test(pt) && /Erholungs-Ampel/.test(pt) && /Apple Health/.test(pt));
  ok('9b. toPromptText leer bei leerer Liste', V.toPromptText([]) === '');

  // 10. evaluate liefert Items je Kennzahl
  const ev = V.evaluate(list[0], base);
  ok('10. evaluate: rhr/hrv/sleep vorhanden', ev.some((x) => x.key === 'rhr') && ev.some((x) => x.key === 'hrv') && ev.some((x) => x.key === 'sleep'));

  // 11. add ohne Store: sanitisiert, aber stored:false (No-Op); leer -> error
  return Promise.all([
    V.add(null, { restingHr: 60, hrv: 55, sleepMin: 430 }, 1700000000000),
    V.add(null, {}, 0),
  ]).then((rs) => {
    ok('11. add ohne Store -> ok, stored:false, sanitisiert', rs[0].ok === true && rs[0].stored === false && rs[0].saved.restingHr === 60);
    ok('11b. add leer -> error empty', rs[1].ok === false && rs[1].error === 'empty');
    console.log(pass ? 'VITALS PASS' : 'VITALS FAIL');
    process.exit(pass ? 0 : 1);
  });
}
run();
