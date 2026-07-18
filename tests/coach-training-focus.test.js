'use strict';
// FINN-Wochen-Trainings-Fokus (lib/ai.coachTrainingFocus): erzeugt aus Wochenthema + Ziel + Plan
// einen strukturierten Trainings-Fokus (Headline, Warum, 3 To-dos, Einheitstyp, optionale Übung).
// Macht jede Coaching-Woche zu EINEM Thema für Ernährung UND Training.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AI_MODEL = 'model-standard';
process.env.AI_MODEL_PLAN = 'model-plan';
const path = require('path');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  let nextBody = null; let lastUser = null;
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    lastUser = b.messages && b.messages[0] && b.messages[0].content;
    const text = (nextBody === null)
      ? JSON.stringify({ headline: 'Kraft schützt Muskeln', why: 'Genug Training hält im Defizit deine Muskeln – passend zum Eiweiß-Thema dieser Woche.', todos: ['2 Krafteinheiten diese Woche', 'Grundübungen zuerst', 'Eiweiß nach dem Training'], sessionType: 'Ganzkörper-Kraft', exercise: { name: 'Beinpresse', machine: 'Leg Press Biostrength' } })
      : nextBody;
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: text }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(__dirname, '..', 'lib/ai.js'));

  // 1. Vollständiger Fokus wird sauber geparst
  let r = await AI.coachTrainingFocus({ firstName: 'Max', goal: 'abnehmen', week: 2, lessonTitle: 'Eiweiß zuerst', lessonTheme: 'Makros', level: 'mittel', daysPerWeek: 3, planTitle: 'Ganzkörper Basis', planText: 'Tag A: Beinpresse, Brustdrücken' });
  ok('1. ok + focus-Objekt', r.ok === true && !!r.focus);
  ok('2. headline vorhanden', !!r.focus.headline && r.focus.headline.length <= 80);
  ok('3. genau 3 todos übernommen', Array.isArray(r.focus.todos) && r.focus.todos.length === 3);
  ok('4. sessionType + exercise übernommen', r.focus.sessionType === 'Ganzkörper-Kraft' && r.focus.exercise && r.focus.exercise.name === 'Beinpresse');
  ok('5. Prompt enthält Wochenthema + Ziel + Plan', /Eiweiß zuerst/.test(lastUser) && /abnehmen/.test(lastUser) && /Ganzkörper Basis/.test(lastUser));

  // 6. todos werden auf max 4 begrenzt
  nextBody = JSON.stringify({ headline: 'X', why: 'y', todos: ['a', 'b', 'c', 'd', 'e', 'f'], sessionType: 'Cardio' });
  r = await AI.coachTrainingFocus({ goal: 'aufbau', week: 1, lessonTitle: 'T', lessonTheme: 'Grundlagen' });
  ok('6. todos auf 4 begrenzt', r.ok && r.focus.todos.length === 4);
  ok('6b. fehlende exercise -> null', r.focus.exercise === null);

  // 7. Kaputtes JSON -> parse_failed (kein Absturz)
  nextBody = 'kein json hier';
  r = await AI.coachTrainingFocus({ goal: 'halten', week: 1, lessonTitle: 'T', lessonTheme: 'x' });
  ok('7. defektes JSON -> ok:false parse_failed', r.ok === false && r.error === 'parse_failed');

  // 8. Leerer Fokus (weder headline noch todos) -> empty
  nextBody = JSON.stringify({ why: 'nur begründung', sessionType: '' });
  r = await AI.coachTrainingFocus({ goal: 'halten', week: 1, lessonTitle: 'T', lessonTheme: 'x' });
  ok('8. leerer Fokus -> ok:false empty', r.ok === false && r.error === 'empty');

  console.log(pass ? 'COACH-TRAINING-FOCUS PASS' : 'COACH-TRAINING-FOCUS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
