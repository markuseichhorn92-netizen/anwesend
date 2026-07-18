'use strict';
// InBody-Bewertungslogik (lib/inbody.js): alters- + geschlechtsspezifische Bänder
// (Hybrid: Gallagher-Körperfett, EWGSOP2/Perzentil-SMI, InBody-Bänder für Rest),
// Segmentale Mageranalyse, SMI-Ableitung, Symmetrie.
const IB = require('../lib/inbody');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const catOf = (ev, key) => { const r = ev.find((x) => x.key === key); return r ? r.cat : null; };
  const refOf = (ev, key) => { const r = ev.find((x) => x.key === key); return r ? r.ref : ''; };

  // 1. Körperfett Gallagher, gleiche Zahl unterschiedlich je Alter (Mann, 22,5 %)
  const mYoung = IB.sanitize({ sex: 'm', age: 30, pbf: 22.5, weight: 80, height: 180 });
  const mMid = IB.sanitize({ sex: 'm', age: 50, pbf: 22.5, weight: 80, height: 180 });
  const evY = IB.evaluate(mYoung, 'm'); const evM = IB.evaluate(mMid, 'm');
  ok('1. Mann 30J, KFA 22,5 % -> über Ideal (warn)', catOf(evY, 'pbf') === 'warn');
  ok('1b. Ref nennt Männer 20–39', /20–39/.test(refOf(evY, 'pbf')) && /Ideal 8–19/.test(refOf(evY, 'pbf')));
  ok('1c. Mann 50J, KFA 22,5 % -> ebenfalls über Ideal (warn), aber Band 40–59', catOf(evM, 'pbf') === 'warn' && /40–59/.test(refOf(evM, 'pbf')) && /Ideal 11–21/.test(refOf(evM, 'pbf')));

  // 2. Gleicher KFA-Wert, Grenze verschiebt sich mit Alter: 20 % Mann
  const mA = IB.evaluate(IB.sanitize({ sex: 'm', age: 30, pbf: 20 }), 'm');
  const mB = IB.evaluate(IB.sanitize({ sex: 'm', age: 50, pbf: 20 }), 'm');
  ok('2. Mann 30J, 20 % -> über Ideal (Ideal endet 19)', catOf(mA, 'pbf') === 'warn');
  ok('2b. Mann 50J, 20 % -> im Ideal (Ideal bis 21) = good', catOf(mB, 'pbf') === 'good');

  // 3. Geschlechtsunterschied: 25 % Fett
  const woman = IB.evaluate(IB.sanitize({ sex: 'w', age: 30, pbf: 25 }), 'w');
  const man = IB.evaluate(IB.sanitize({ sex: 'm', age: 30, pbf: 25 }), 'm');
  ok('3. Frau 30J, 25 % -> im Ideal (21–33) = good', catOf(woman, 'pbf') === 'good');
  ok('3b. Mann 30J, 25 % -> über Ideal (8–19) = bad (adipös-Grenze 25)', catOf(man, 'pbf') === 'warn' || catOf(man, 'pbf') === 'bad');

  // 4. SMI: Ableitung aus ASM/Größe² + EWGSOP2-Grenze
  const smiM = IB.sanitize({ sex: 'm', age: 40, height: 180, asm: 28 }); // 28/1.8² = 8.64
  ok('4. SMI aus ASM/Größe² abgeleitet ~8,64', Math.abs(IB.deriveSmi(smiM) - 8.64) < 0.05);
  ok('4b. SMI 8,64 (Mann 40) -> gut', catOf(IB.evaluate(smiM, 'm'), 'smi') === 'good');
  const smiLow = IB.sanitize({ sex: 'm', age: 70, height: 180, asm: 22 }); // 6.79 < 7.0
  ok('4c. SMI 6,79 (Mann) -> unter klinischer Grenze = bad', catOf(IB.evaluate(smiLow, 'm'), 'smi') === 'bad');
  const smiW = IB.sanitize({ sex: 'w', age: 35, height: 165, asm: 16 }); // 16/1.65²=5.88 -> good (>=6.4? no) 5.88<6.4 -> warn, >5.5
  ok('4d. Frau SMI 5,88 -> unteres Normal (warn), nicht bad', catOf(IB.evaluate(smiW, 'w'), 'smi') === 'warn');

  // 5. Segmentale Mageranalyse: kg + gedrucktes %
  const seg = IB.sanitize({ sex: 'm', age: 40, weight: 82, height: 180, leanRA: 3.6, leanLA: 3.5, leanTR: 24, leanRL: 9.5, leanLL: 9.2, pctRA: 105, pctLA: 88, pctTR: 100, pctRL: 112, pctLL: 108, pbf: 18 });
  const segs = IB.segments(seg);
  ok('5. Fünf Segmente', segs.length === 5);
  ok('5b. Rechter Arm 105 % -> Normal', segs.find((s) => s.key === 'RA').band === 'Normal');
  ok('5c. Linker Arm 88 % -> Unter (warn)', segs.find((s) => s.key === 'LA').band === 'Unter' && segs.find((s) => s.key === 'LA').cat === 'warn');
  ok('5d. Rechtes Bein 112 % -> Über', segs.find((s) => s.key === 'RL').band === 'Über');

  // 6. Symmetrie
  const sym = IB.symmetry(seg);
  ok('6. Symmetrie: Arme ~2,8 %, kein Flag', sym && sym.arms != null && sym.arms < 10 && !sym.flag);
  const asym = IB.symmetry(IB.sanitize({ leanRA: 4.0, leanLA: 3.2, leanRL: 9, leanLL: 9 }));
  ok('6b. 20 % Armdifferenz -> Flag gesetzt', asym && asym.flag === true);

  // 7. ECW/TBW-Wasserhaushalt
  ok('7. ECW/TBW 0,38 -> gut', catOf(IB.evaluate(IB.sanitize({ pbf: 15, ecwtbw: 0.38 }), 'm'), 'ecwtbw') === 'good');
  ok('7b. ECW/TBW 0,41 -> bad', catOf(IB.evaluate(IB.sanitize({ pbf: 15, ecwtbw: 0.41 }), 'm'), 'ecwtbw') === 'bad');

  // 8. Ohne Alter -> Rückfall auf feste InBody-Bänder (M 10–20), Ref markiert
  const noAge = IB.evaluate(IB.sanitize({ sex: 'm', pbf: 22 }), 'm');
  ok('8. Ohne Alter: Ref enthält „ohne Alter"', /ohne Alter/.test(refOf(noAge, 'pbf')));

  // 9. Prompt-Text enthält Alters-/Geschlechts-Band + SMI
  const txt = IB.toPromptText([seg], 'm');
  ok('9. toPromptText nennt Ideal-Band + SMI', /Ideal 11–21/.test(txt) && /SMI/.test(txt));

  // 10. Trend nimmt SMI mit
  const t = IB.trend([IB.sanitize({ date: '2026-07-10', sex: 'm', height: 180, asm: 29, pbf: 18 }), IB.sanitize({ date: '2026-06-10', sex: 'm', height: 180, asm: 28, pbf: 20 })]);
  ok('10. Trend berechnet SMI-Delta', t && t.sincePrev && typeof t.sincePrev.smi === 'number' && t.sincePrev.smi > 0);

  console.log(pass ? 'INBODY PASS' : 'INBODY FAIL');
  process.exit(pass ? 0 : 1);
}
run();
