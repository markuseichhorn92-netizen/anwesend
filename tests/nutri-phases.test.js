'use strict';
// Ernährungs-Phasenplan (lib/nutriPhases.js): Auflösung der heute gültigen Phase,
// Grenztage, quellenabhängiges Planende (Analyse läuft aus / Team-Plan hält),
// Kappung der Zielwerte und Vorlagen-Verteilung auf eine Gesamtdauer.
// Reine Logik – kein KV, keine Mocks nötig.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'lib/nutriPhases.js'));

// Fester Bezugstag, damit die Tests unabhängig vom echten Datum laufen.
const T0 = '2026-08-10';
const dayAfter = (n) => P.addDays(T0, n);

function planOf(source, weeks) {
  return {
    v: 1, startDate: T0, source: source, repeat: false,
    phases: [
      { key: 'aaa1', name: 'Aktivierung', kind: 'aktivierung', weeks: weeks[0], kcal: 2400, protein: 160, carbs: 250, fat: 80, note: '' },
      { key: 'bbb2', name: 'Reduktion', kind: 'reduktion', weeks: weeks[1], kcal: 2000, protein: 180, carbs: 170, fat: 70, note: '' },
      { key: 'ccc3', name: 'Stabilisierung', kind: 'stabilisierung', weeks: weeks[2], kcal: 2200, protein: 170, carbs: 210, fat: 75, note: '' },
    ],
  };
}

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  const plan = planOf('team', [6, 8, 4]);   // 18 Wochen = 126 Tage

  // ── 1. Aktive Phase über die Zeit ──
  let r = P.resolve(plan, T0);
  ok('1. Tag 0 -> Phase 1', r.status === 'running' && r.index === 0 && r.current.name === 'Aktivierung' && r.weekInPhase === 1, JSON.stringify({ i: r.index, w: r.weekInPhase }));
  r = P.resolve(plan, dayAfter(20));
  ok('2. Tag 20 -> weiterhin Phase 1, Woche 3', r.index === 0 && r.weekInPhase === 3, JSON.stringify({ i: r.index, w: r.weekInPhase }));

  // ── 2. Grenztage (die klassische Off-by-one-Falle) ──
  r = P.resolve(plan, dayAfter(41));   // letzter Tag Phase 1 (6*7=42 Tage: 0..41)
  ok('3. Tag 41 (letzter Tag Phase 1) -> noch Phase 1', r.index === 0, 'index=' + r.index);
  r = P.resolve(plan, dayAfter(42));   // erster Tag Phase 2
  ok('4. Tag 42 (Wechseltag) -> Phase 2', r.index === 1 && r.current.name === 'Reduktion' && r.weekInPhase === 1, JSON.stringify({ i: r.index, w: r.weekInPhase }));
  r = P.resolve(plan, dayAfter(97));   // letzter Tag Phase 2 (42+56-1)
  ok('5. Tag 97 -> noch Phase 2', r.index === 1, 'index=' + r.index);
  r = P.resolve(plan, dayAfter(98));
  ok('6. Tag 98 -> Phase 3 (Stabilisierung)', r.index === 2, 'index=' + r.index);

  // ── 3. next + Timeline-Zustände ──
  r = P.resolve(plan, dayAfter(42));
  ok('7. next zeigt die Folgephase mit Startdatum', r.next && r.next.name === 'Stabilisierung' && r.next.startDate === dayAfter(98), JSON.stringify(r.next && { n: r.next.name, s: r.next.startDate }));
  ok('8. Timeline-Zustände past/current/future', r.phases[0].state === 'past' && r.phases[1].state === 'current' && r.phases[2].state === 'future', r.phases.map((p) => p.state).join(','));
  ok('9. Zeiträume lückenlos', r.phases[0].endDate === dayAfter(41) && r.phases[1].startDate === dayAfter(42), r.phases[0].endDate + '|' + r.phases[1].startDate);

  // ── 4. Planende – quellenabhängig (die Kernentscheidung) ──
  const afterEnd = dayAfter(126);   // exakt hinter der letzten Phase
  const teamEnd = P.resolve(planOf('team', [6, 8, 4]), afterEnd);
  ok('10. Team-Plan am Ende: letzte Phase läuft weiter', teamEnd.status === 'finished' && teamEnd.expired === true && teamEnd.holdLast === true && teamEnd.current && teamEnd.current.name === 'Stabilisierung', JSON.stringify({ s: teamEnd.status, h: teamEnd.holdLast, c: teamEnd.current && teamEnd.current.name }));
  ok('11. Team-Plan am Ende: Zielwerte gelten weiter', !!P.activeOverride(planOf('team', [6, 8, 4]), afterEnd));

  const anaEnd = P.resolve(planOf('analysis', [6, 8, 4]), afterEnd);
  ok('12. Analyse-Plan am Ende: läuft aus (keine aktive Phase)', anaEnd.status === 'finished' && anaEnd.expired === true && anaEnd.holdLast === false && anaEnd.current === null, JSON.stringify({ s: anaEnd.status, h: anaEnd.holdLast, c: anaEnd.current }));
  ok('13. Analyse-Plan am Ende: KEIN Override -> Formel greift', P.activeOverride(planOf('analysis', [6, 8, 4]), afterEnd) === null);

  // ── 5. Noch nicht gestartet ──
  const future = Object.assign({}, planOf('team', [6, 8, 4]), { startDate: dayAfter(10) });
  r = P.resolve(future, T0);
  ok('14. Startdatum in der Zukunft -> pending, kein Override', r.status === 'pending' && r.daysUntilStart === 10 && P.activeOverride(future, T0) === null, JSON.stringify({ s: r.status, d: r.daysUntilStart }));

  // ── 6. Kein/kaputter Plan -> sauber statt Absturz ──
  ok('15. null-Plan -> status none', P.resolve(null, T0).status === 'none');
  ok('16. leere Phasenliste -> status none', P.resolve({ startDate: T0, phases: [] }, T0).status === 'none');
  ok('17. activeOverride ohne Plan -> null', P.activeOverride(null, T0) === null);

  // ── 7. normalize: kappen & ablehnen ──
  const n1 = P.normalize({ startDate: T0, phases: [{ name: 'X', weeks: 99, kcal: 99999, protein: 9999, fat: 1, carbs: 99999 }] }, { today: T0 });
  ok('18. normalize kappt Ausreißer', n1.ok && n1.plan.phases[0].weeks === 26 && n1.plan.phases[0].kcal === 4500 && n1.plan.phases[0].protein === 300 && n1.plan.phases[0].fat === 20, JSON.stringify(n1.ok && n1.plan.phases[0]));
  const n2 = P.normalize({ phases: [] }, { today: T0 });
  ok('19. normalize lehnt leere Phasen ab', !n2.ok && n2.error === 'no_phases', JSON.stringify(n2));
  const n3 = P.normalize(null, { today: T0 });
  ok('20. normalize lehnt Müll ab', !n3.ok && n3.error === 'plan_invalid');
  const n4 = P.normalize({ startDate: T0, phases: [{ name: 'Ohne Werte', weeks: 3 }] }, { today: T0 });
  ok('21. Phase ohne jeden Zielwert wird verworfen', !n4.ok && n4.error === 'no_phases');
  const n5 = P.normalize({ startDate: T0, phases: Array.from({ length: 12 }, () => ({ name: 'P', weeks: 2, kcal: 2000 })) }, { today: T0 });
  ok('22. maximal 8 Phasen', n5.ok && n5.plan.phases.length === P.MAX_PHASES, n5.ok && String(n5.plan.phases.length));
  ok('23. normalize merkt sich die laufende Phase (kein Fehl-Push)', n1.ok && n1.plan.lastPhaseKey === n1.plan.phases[0].key);

  // ── 8. Vorlagen: Gesamtdauer wird exakt getroffen ──
  [8, 12, 18, 24, 30].forEach(function (tw) {
    const prop = P.applyTemplate('aktivierung-reduktion', tw, { kcal: 2200 }, { weight: 80, startDate: T0 });
    const sum = prop.phases.reduce(function (a, p) { return a + p.weeks; }, 0);
    const minOk = prop.phases.every(function (p) { return p.weeks >= 1; });
    ok('24. Vorlage trifft ' + tw + ' Wochen exakt (jede Phase >= 1)', sum === tw && minOk, 'sum=' + sum + ' weeks=' + prop.phases.map(function (p) { return p.weeks; }).join('/'));
  });
  const tpl = P.applyTemplate('aktivierung-reduktion', 18, { kcal: 2200 }, { weight: 80, startDate: T0 });
  ok('25. Vorlage endet mit Stabilisierung', tpl.phases[tpl.phases.length - 1].kind === 'stabilisierung');
  ok('26. Reduktionsphase liegt unter dem Erhaltungsbedarf', tpl.phases[1].kcal < 2200 && tpl.phases[0].kcal >= 2100, JSON.stringify(tpl.phases.map(function (p) { return p.kcal; })));
  ok('27. Vorlage ist normalize-tauglich', P.normalize(tpl, { today: T0 }).ok === true);
  ok('28. Unbekannte Vorlage -> null', P.applyTemplate('gibtsnicht', 12, { kcal: 2000 }, {}) === null);

  // ── 9. memberView ist datensparsam ──
  const full = P.normalize(Object.assign(planOf('team', [6, 8, 4]), { setBy: 'trainer@fitinn', analysis: { bmr: 1700 } }), { today: T0, setBy: 'trainer@fitinn' });
  const mv = P.memberView(full.plan, dayAfter(45));
  ok('29. memberView zeigt aktuelle Phase + nächste', mv && mv.name === 'Reduktion' && mv.next && mv.next.name === 'Stabilisierung', JSON.stringify(mv && { n: mv.name, x: mv.next && mv.next.name }));
  ok('30. memberView enthält KEINE Team-/Analysedaten', mv && mv.setBy === undefined && mv.analysis === undefined && JSON.stringify(mv).indexOf('trainer@fitinn') < 0);

  // ── 10. Wiederholung ──
  const rep = Object.assign(planOf('team', [6, 8, 4]), { repeat: true });
  r = P.resolve(rep, dayAfter(127));
  ok('31. repeat -> nach Planende wieder Phase 1', r.status === 'running' && r.index === 0, JSON.stringify({ s: r.status, i: r.index }));

  console.log(pass ? 'NUTRI-PHASES PASS' : 'NUTRI-PHASES FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
