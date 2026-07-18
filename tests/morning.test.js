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
  ok('7. VP-Ledger: 5 Einträge à 30 Punkte', led.length === 5 && led[0].pts === 30 && led[0].reason === 'Morgen-Check-in');
  const dup = MO.vpLedger([mk('2026-07-18', 55), mk('2026-07-18', 56)]);
  ok('7b. VP-Ledger dedupliziert gleichen Tag', dup.length === 1);
  const ledT = MO.vpLedgerTraining([mk('2026-07-18', 55), mk('2026-07-18', 56), mk('2026-07-17', 57)]);
  ok('7c. Trainings-VP-Ledger: +15/Tag, Dedup nach Datum', ledT.length === 2 && ledT[0].pts === 15 && ledT[0].reason === 'Trainings-Check-in');

  // 8. Prompt-Text enthält Baseline + Ampel + Disclaimer
  const txt = MO.toPromptText(list);
  ok('8. toPromptText nennt Ruhepuls + Baseline', /Ruhepuls 70 bpm \(Baseline 55\)/.test(txt));
  ok('8b. toPromptText enthält Ampel + Disclaimer (keine Diagnose)', /Bereitschafts-Ampel: ROT/.test(txt) && /KEINE Diagnose/.test(txt));
  ok('8c. toPromptText leer bei keinen Daten', MO.toPromptText([]) === '');

  // 9. hasAny
  ok('9. hasAny true bei RHR', MO.hasAny(mk('2026-07-18', 55)) === true);
  ok('9b. hasAny false bei leerem Objekt', MO.hasAny(MO.sanitize({})) === false);

  // 10. SDNN wird übernommen + evaluiert
  ok('10. sanitize hrvSdnn (Alias sdnn)', MO.sanitize({ sdnn: 65 }).hrvSdnn === 65);
  const evS = MO.evaluate(MO.sanitize({ rhr: 55, hrvRmssd: 60, sdnn: 70 }), base);
  ok('10b. evaluate enthält SDNN-Zeile', !!evS.find(function (x) { return x.key === 'sdnn'; }));

  // 11. Vegetative Balance (Anspannung <-> Regeneration)
  ok('11. Gute Werte -> hohe Balance (Regeneration)', (function () { var b = MO.balance(mk('2026-07-18', 54, 66), base); return b && b.value >= 66 && b.level === 'regeneration'; })());
  ok('11b. Stress-Werte -> niedrige Balance (Anspannung)', (function () { var b = MO.balance(mk('2026-07-18', 70, 38), base); return b && b.value <= 40 && b.level === 'anspannung'; })());
  ok('11c. Ohne Baseline -> kalibrierung', (function () { var b = MO.balance(few[0], MO.baseline(few)); return b && b.level === 'kalibrierung'; })());

  // 12. HRV-Fitnessalter
  const ha = MO.hrvAge(mk('2026-07-18', 55, 42), 40, base);   // base.hrv ~60 -> jung
  ok('12. hrvAge nutzt Baseline-HRV + liefert age/delta', ha && typeof ha.age === 'number' && ha.actualAge === 40 && typeof ha.delta === 'number');
  ok('12b. hohe HRV -> jüngeres HRV-Alter als 40', ha.age < 40);
  ok('12c. hrvAge null ohne HRV', MO.hrvAge(mk('2026-07-18', 55), 40, { rhr: 55 }) === null);

  // 13. Belastungssteuerung aus Ampel
  ok('13. grün -> volle Belastung', MO.trainingLoad({ level: 'gruen' }).key === 'voll');
  ok('13b. rot -> Regeneration', MO.trainingLoad({ level: 'rot' }).key === 'ruhe');
  ok('13c. kalibrierung -> kalibrierung', MO.trainingLoad({ level: 'kalibrierung' }).key === 'kalibrierung');

  // 14. toPromptText nennt die vegetative Balance
  ok('14. toPromptText enthält Anspannung↔Regeneration', /Anspannung↔Regeneration/.test(MO.toPromptText(list)));

  // 15. Fragebogen-Felder (Whoop-Journal) werden übernommen
  var jm = MO.sanitize({ rhr: 55, sleepSelf: 'gut', moodSelf: 'ok', stressSelf: 'hoch', soreness: 'stark', sick: '1' });
  ok('15. sanitize Journal (stress/soreness/sick)', jm.stressSelf === 'hoch' && jm.soreness === 'stark' && jm.sick === 1);
  ok('15b. sick nein -> 0', MO.sanitize({ rhr: 55, sick: 'nein' }).sick === 0);
  ok('15c. ungültiger Stress -> leer', MO.sanitize({ rhr: 55, stressSelf: 'foo' }).stressSelf === '');

  // 16. Subjektive Kappung der Belastungssteuerung
  ok('16. gute Ampel aber angeschlagen -> Ruhe', MO.trainingLoad({ level: 'gruen' }, MO.sanitize({ rhr: 55, sick: '1' })).key === 'ruhe');
  ok('16b. gute Ampel aber schlecht geschlafen -> moderat', MO.trainingLoad({ level: 'gruen' }, MO.sanitize({ rhr: 55, sleepSelf: 'schlecht' })).key === 'moderat');
  ok('16c. gute Ampel ohne Flags -> voll (keine Kappung)', MO.trainingLoad({ level: 'gruen' }, MO.sanitize({ rhr: 55 })).key === 'voll');
  ok('16d. Kappung hebt nie an (rote Ampel bleibt Ruhe)', MO.trainingLoad({ level: 'rot' }, MO.sanitize({ rhr: 55 })).key === 'ruhe');

  // 17. Muster-Erkenntnisse (insights): guter vs. schlechter Schlaf -> RHR-Unterschied
  var big = [];
  ['2026-07-18', '2026-07-17', '2026-07-16'].forEach(function (dt) { big.push(MO.sanitize({ date: dt, rhr: 52, hrvRmssd: 66, sleepSelf: 'gut' })); });
  ['2026-07-15', '2026-07-14', '2026-07-13'].forEach(function (dt) { big.push(MO.sanitize({ date: dt, rhr: 60, hrvRmssd: 50, sleepSelf: 'schlecht' })); });
  ['2026-07-12', '2026-07-11'].forEach(function (dt) { big.push(MO.sanitize({ date: dt, rhr: 56, hrvRmssd: 58, sleepSelf: 'ok' })); });
  var ins = MO.insights(big);
  ok('17. insights liefert Muster (>=1)', Array.isArray(ins) && ins.length >= 1 && /gutem Schlaf/.test(ins.join(' ')));
  ok('17b. insights leer bei <8 Messungen', MO.insights(big.slice(0, 5)).length === 0);

  // 18. Trainings-Bereitschaft (Trainings-Check-in) gegen die Morgen-Baseline
  var trGood = MO.trainReadiness(mk('2026-07-18', 54, 62), base);
  ok('18. trainReadiness grün + trainingsbezogene Worte', trGood.level === 'gruen' && /Bereit fürs Training/.test(trGood.headline) && typeof trGood.advice === 'string' && trGood.advice.length > 0);
  ok('18b. trainReadiness rot bei hohem Puls/niedriger HRV', MO.trainReadiness(mk('2026-07-18', 72, 40), base).level === 'rot');
  ok('18c. trainReadiness ohne Baseline -> kalibrierung', MO.trainReadiness(mk('2026-07-18', 55), MO.baseline(few)).level === 'kalibrierung' && MO.trainReadiness(mk('2026-07-18', 55), MO.baseline(few)).hasBaseline === false);
  ok('18d. sanitize kind training/morgen', MO.sanitize({ rhr: 55, kind: 'training' }).kind === 'training' && MO.sanitize({ rhr: 55 }).kind === 'morgen');

  // 19. Trainings-Herzfrequenzzonen aus max. HF (Tanaka)
  const z = MO.trainingZones(40);
  ok('19. trainingZones: hrMax ~180 + 5 Zonen', z && z.hrMax === 180 && z.table.length === 5);
  ok('19b. Z2 bpm-Bereich = 60–70% von 180', (function () { const z2 = z.table.find((t) => t.key === 'Z2'); return z2 && z2.bpmLo === 108 && z2.bpmHi === 126; })());
  ok('19c. trainingZones null ohne Alter', MO.trainingZones(0) === null && MO.trainingZones(null) === null);

  // 20. HRV-Fitnessalter-Verlauf (aus Tages-HRV, ältester zuerst)
  const bser = [MO.sanitize({ date: '2026-07-18', rhr: 54, hrvRmssd: 60 }), MO.sanitize({ date: '2026-07-17', rhr: 55, hrvRmssd: 50 }), MO.sanitize({ date: '2026-07-16', rhr: 56, hrvRmssd: 40 })];
  const hs = MO.hrvAgeSeries(bser);
  ok('20. hrvAgeSeries: 3 Punkte, ältester zuerst', hs.length === 3 && hs[0].date === '2026-07-16' && typeof hs[0].age === 'number');
  ok('20b. höhere HRV -> jüngeres HRV-Alter im Verlauf', hs[2].age < hs[0].age);
  ok('20c. hrvAgeSeries ignoriert Messungen ohne HRV', MO.hrvAgeSeries([MO.sanitize({ date: '2026-07-18', rhr: 55 })]).length === 0);

  // 21. Übertrainings-/Erholungs-Frühwarnung
  const otBase = ['2026-07-13', '2026-07-12', '2026-07-11', '2026-07-10'].map((dt) => MO.sanitize({ date: dt, rhr: 55, hrvRmssd: 60 }));
  const otAlert = [MO.sanitize({ date: '2026-07-18', rhr: 63, hrvRmssd: 48 }), MO.sanitize({ date: '2026-07-17', rhr: 62, hrvRmssd: 49 }), MO.sanitize({ date: '2026-07-16', rhr: 61, hrvRmssd: 50 })].concat(otBase);
  ok('21. overtraining alert bei 3 belasteten Messungen', MO.overtraining(otAlert).level === 'alert' && MO.overtraining(otAlert).days === 3);
  ok('21b. overtraining ok bei erholtem jüngsten Tag', MO.overtraining([MO.sanitize({ date: '2026-07-18', rhr: 54, hrvRmssd: 61 })].concat(otBase)).level === 'ok');
  ok('21c. overtraining ok bei <3 Messungen', MO.overtraining([MO.sanitize({ rhr: 55 })]).level === 'ok');

  // 22. FINN-Vollkontext (toPromptText) mit Kraft/Zonen, Trainings-Check-in, HRV-Alter, Übertraining
  const ctx = MO.toPromptText(otAlert, { trList: [MO.sanitize({ rhr: 60, hrvRmssd: 50 })], age: 41 });
  ok('22. FINN-Kontext nennt Belastungsempfehlung (Cardio & Kraft)', /Belastungsempfehlung/.test(ctx) && /Kraft/.test(ctx));
  ok('22b. FINN-Kontext nennt Übertrainings-Signal', /Übertrainings-Signal/.test(ctx));
  ok('22c. FINN-Kontext nennt HRV-Fitnessalter + Trainings-Check-in', /HRV-Fitnessalter/.test(ctx) && /Trainings-Check-in/.test(ctx));

  // 23. Wochen-Vitalitäts-Report
  const wk = MO.weeklyReport(otAlert);
  ok('23. weeklyReport: Ampel-Verteilung + Note + Übertraining', wk && (wk.gruen + wk.gelb + wk.rot) > 0 && typeof wk.note === 'string' && wk.overtraining === 'alert');
  ok('23b. weeklyReport null bei <3 Messungen', MO.weeklyReport([mk('2026-07-18', 55, 60)]) === null);

  console.log(pass ? 'MORNING PASS' : 'MORNING FAIL');
  process.exit(pass ? 0 : 1);
}
run();
