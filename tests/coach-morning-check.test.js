'use strict';
// FINN-Morgen-Check (lib/ai.coachMorningCheck): wertet Ruhepuls/HRV gegen die
// persönliche Baseline aus und liefert eine Bereitschafts-Ampel + To-dos +
// Trainings-Empfehlung. Wellness-Signal, keine Diagnose.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AI_MODEL = 'model-standard';
process.env.AI_MODEL_ANALYSIS = 'model-analysis';
const path = require('path');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  let nextBody = null; let lastUser = null; let lastModel = null;
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    lastUser = b.messages && b.messages[0] && b.messages[0].content;
    lastModel = b.model;
    const text = (nextBody === null)
      ? JSON.stringify({ readiness: { level: 'gruen', headline: 'Bereit für Vollgas', why: 'Dein Ruhepuls liegt auf deiner Baseline und die HRV ist gut.' }, todos: ['Kraftfokus heute', 'Genug trinken'], trainingAdvice: 'Heute Vollgas – dein Körper ist erholt.', wellnessNote: '' })
      : nextBody;
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: text }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(__dirname, '..', 'lib/ai.js'));

  // 1. Vollständiger Check wird sauber geparst
  let r = await AI.coachMorningCheck({ firstName: 'Max', goal: 'aufbau', rhr: 55, rhrBaseline: 55, hrv: 62, hrvBaseline: 60, plannedTraining: 'Beintag' });
  ok('1. ok + check-Objekt', r.ok === true && !!r.check);
  ok('2. readiness.level grün + headline', r.check.readiness.level === 'gruen' && !!r.check.readiness.headline);
  ok('3. todos übernommen', Array.isArray(r.check.todos) && r.check.todos.length === 2);
  ok('4. trainingAdvice vorhanden', /Vollgas/.test(r.check.trainingAdvice));
  ok('5. Prompt enthält Ruhepuls + Baseline + Ziel + geplantes Training', /Ruhepuls heute: 55 bpm/.test(lastUser) && /Baseline 55/.test(lastUser) && /aufbau/.test(lastUser) && /Beintag/.test(lastUser));
  ok('6. nutzt MODEL_ANALYSIS', lastModel === 'model-analysis');

  // 7. Ungültiges level -> leerer String (nicht durchgereicht)
  nextBody = JSON.stringify({ readiness: { level: 'blau', headline: 'X', why: 'y' }, todos: ['a'], trainingAdvice: 'moderat' });
  r = await AI.coachMorningCheck({ rhr: 60, rhrBaseline: 55 });
  ok('7. ungültiges level wird verworfen', r.ok && r.check.readiness.level === '');

  // 8. todos auf max 4 begrenzt
  nextBody = JSON.stringify({ readiness: { level: 'gelb', headline: 'Moderat', why: 'y' }, todos: ['a', 'b', 'c', 'd', 'e'], trainingAdvice: 'moderat' });
  r = await AI.coachMorningCheck({ rhr: 60, rhrBaseline: 55 });
  ok('8. todos auf 4 begrenzt', r.ok && r.check.todos.length === 4);

  // 9. Kaputtes JSON -> parse_failed (kein Absturz)
  nextBody = 'kein json';
  r = await AI.coachMorningCheck({ rhr: 60, rhrBaseline: 55 });
  ok('9. defektes JSON -> ok:false parse_failed', r.ok === false && r.error === 'parse_failed');

  // 10. Leerer Check (nichts Verwertbares) -> empty
  nextBody = JSON.stringify({ readiness: { level: '', headline: '', why: '' }, todos: [], trainingAdvice: '' });
  r = await AI.coachMorningCheck({ rhr: 60, rhrBaseline: 55 });
  ok('10. leerer Check -> ok:false empty', r.ok === false && r.error === 'empty');

  // 11. Kalibrierungs-Hinweis fließt in den System-Prompt
  nextBody = null;
  r = await AI.coachMorningCheck({ rhr: 58, calibrating: true });
  ok('11. Check läuft auch ohne Baseline (Kalibrierung)', r.ok === true);

  console.log(pass ? 'COACH-MORNING-CHECK PASS' : 'COACH-MORNING-CHECK FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
