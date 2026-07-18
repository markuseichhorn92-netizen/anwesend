'use strict';
// Morgen-Check-Logik (lib/morning.js): persönliche Baseline (Median vorheriger
// Messungen), Bewertung gegen Baseline (RHR-Delta, HRV-Verhältnis), deterministische
// Bereitschafts-Ampel, Trend, VP-Ledger, Prompt-Text.
const MO = require('../lib/morning');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const catOf = (ev, key) => { const r = ev.find((x) => x.key === key); return r ? r.cat : null; };

  // Helfer: Liste (neueste zuerst) aus Ruhepuls-Reihe bauen
  const mk = (date, rhr, hrv) => MO.sanitize({ date: date, rhr: rhr, hrvRmssd: hrv });

  // 1. sanitize klammert Werte + akzeptiert Aliase
  const s = MO.sanitize({ date: '2026-07-18', restingHr: 58, hrv: 62, respRate: 14, orthostatic: 22, sleepSelf: 'GUT', moodSelf: 'ok', note: '  frisch  ' });
  ok('1. sanitize: Aliase (restingHr/hrv/orthostatic) übernommen', s.rhr === 58 && s.hrvRmssd === 62 && s.orthostaticDelta === 22);
  ok('1b. sanitize: Enums normalisiert (gut/ok), Note getrimmt', s.sleepSelf === 'gut' && s.moodSelf === 'ok' && s.note === 'frisch');
  ok('1c. sanitize: Ausreißer verworfen (rhr 300 -> null)', MO.sanitize({ rhr: 300 }).rhr === null);

  // 2. Baseline = Median der VORHERIGEN Messungen (ohne die neueste)
  const list = [mk('2026-07-18', 70, 40), mk('2026-07-17', 54, 60), mk('2026-07-16', 56, 62), mk('2026-07-15', 55, 58), mk('2026-07-14', 55, 61)];
  const base = MO.baseline(list);
  ok('2. Baseline RHR ~55 (Median der 4 vorherigen, ohne heutige 70)', base.rhr === 55);
  ok('2b. Baseline HRV ~60', base.hrv === 60.5 || base.hrv === 60);
  ok('2c. Baseline nicht mehr in Kalibrierung (4 Vergleichswerte)', base.calibrating === false && base.rhrN === 4);

  // 3. Kalibrierung: zu wenige Vergleichsmessungen
  const few = [mk('2026-07-18', 60, 55), mk('2026-07-17', 58, 57)];
  ok('3. <MIN_CALIB Vergleichsmessungen -> calibrating', MO.baseline(few).calibrating === true);
  ok('3b. evaluate ohne Baseline -> RHR cat info', catOf(MO.evaluate(few[0], MO.baseline(few)), 'rhr') === 'info');

  // 4. Bewertung gegen Baseline
  const evHigh = MO.evaluate(list[0], base); // heute RHR 70 vs Baseline 55 -> +15
  ok('4. RHR +15 über Baseline -> bad', catOf(evHigh, 'rhr') === 'bad');
  ok('4b. HRV 40 vs Schnitt ~60 (Ratio ~0,66) -> bad', catOf(evHigh, 'hrv') === 'bad');
  const evGood = MO.evaluate(mk('2026-07-18', 56, 61), base); // +1 RHR, HRV ~ Schnitt
  ok('4c. RHR +1, HRV im Schnitt -> good/good', catOf(evGood, 'rhr') === 'good' && catOf(evGood, 'hrv') === 'good');
  const evMild = MO.evaluate(mk('2026-07-18', 60, 50), base); // +5 RHR (warn), HRV ratio ~0,83 (warn)
  ok('4d. RHR +5 -> warn, HRV Ratio ~0,83 -> warn', catOf(evMild, 'rhr') === 'warn' && catOf(evMild, 'hrv') === 'warn');

  // 5. Bereitschafts-Ampel (deterministisch)
  ok('5. Gute Werte -> grün', MO.readiness(mk('2026-07-18', 55, 60), base).level === 'gruen');
  ok('5b. Stark erhöhter RHR + niedrige HRV -> rot', MO.readiness(mk('2026-07-18', 70, 40), base).level === 'rot');
  ok('5c. Leicht erhöht -> gelb', MO.readiness(mk('2026-07-18', 60, 50), base).level === 'gelb');
  ok('5d. Ohne Baseline -> kalibrierung', MO.readiness(few[0], MO.baseline(few)).level === 'kalibrierung');

  // 6. Trend berechnet RHR-/HRV-Delta
  const t = MO.trend(list);
  ok('6. Trend sincePrev RHR-Delta = +16 (70-54)', t && t.sincePrev && t.sincePrev.rhr === 16);
  ok('6b. Trend zählt alle Messungen', t.count === 5);

  // 7. VP-Ledger: +30 je Tag, Dedup nach Datum
  const led = MO.vpLedger(list);
  ok('7. VP-Ledger: 5 Einträge à 30 Punkte', led.length === 5 && led[0].pts === 30 && led[0].reason === 'Morgen-Check');
  const dup = MO.vpLedger([mk('2026-07-18', 55), mk('2026-07-18', 56)]);
  ok('7b. VP-Ledger dedupliziert gleichen Tag', dup.length === 1);

  // 8. Prompt-Text enthält Baseline + Ampel + Disclaimer
  const txt = MO.toPromptText(list);
  ok('8. toPromptText nennt Ruhepuls + Baseline', /Ruhepuls 70 bpm \(Baseline 55\)/.test(txt));
  ok('8b. toPromptText enthält Ampel + Disclaimer (keine Diagnose)', /Bereitschafts-Ampel: ROT/.test(txt) && /KEINE Diagnose/.test(txt));
  ok('8c. toPromptText leer bei keinen Daten', MO.toPromptText([]) === '');

  // 9. hasAny
  ok('9. hasAny true bei RHR', MO.hasAny(mk('2026-07-18', 55)) === true);
  ok('9b. hasAny false bei leerem Objekt', MO.hasAny(MO.sanitize({})) === false);

  console.log(pass ? 'MORNING PASS' : 'MORNING FAIL');
  process.exit(pass ? 0 : 1);
}
run();
