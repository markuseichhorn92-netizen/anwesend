'use strict';
// Per-Call-Modell-Routing (lib/ai.js): Alltags-Aufrufe nutzen AI_MODEL (Haiku),
// Plan-Generierung nutzt AI_MODEL_PLAN, Auswertungen AI_MODEL_ANALYSIS – jeweils
// mit Rückfall auf AI_MODEL, wenn die Env-Variable fehlt.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AI_MODEL = 'model-standard';
process.env.AI_MODEL_PLAN = 'model-plan';
process.env.AI_MODEL_ANALYSIS = 'model-analysis';
const path = require('path');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  let lastModel = null;
  global.fetch = async (url, opts) => {
    lastModel = JSON.parse(opts.body).model;
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(__dirname, '..', 'lib/ai.js'));

  ok('0. Konstanten korrekt aufgelöst', AI.MODEL === 'model-standard' && AI.MODEL_PLAN === 'model-plan' && AI.MODEL_ANALYSIS === 'model-analysis');

  // Alltag: Hilfe-Q&A -> Standard-Modell
  await AI.askHelp('Wann offen?', [{ t: 'Öffnungszeiten', body: 'Mo–Fr 6–23 Uhr.' }]);
  ok('1. askHelp nutzt Standard-Modell', lastModel === 'model-standard');

  // FINN-Chat -> Standard
  await AI.coachReply({ firstName: 'Max' }, [], 'Hi', [{ t: 'A', body: 'x' }]);
  ok('2. coachReply nutzt Standard-Modell', lastModel === 'model-standard');

  // Plan-Generierung -> PLAN
  await AI.trainingPlan({ goal: 'aufbau', level: 'anfaenger', daysPerWeek: 3 });
  ok('3. trainingPlan nutzt Plan-Modell', lastModel === 'model-plan');
  await AI.nutritionWeekPlan({ goal: 'abnehmen', kcalTarget: 1900, protein: 130, diet: 'omnivor' });
  ok('4. nutritionWeekPlan nutzt Plan-Modell', lastModel === 'model-plan');

  // Auswertungen -> ANALYSIS
  await AI.figurReview({ goal: 'abnehmen', count: 3, spanDays: 30, lines: ['Gewicht 82 -> 80'] });
  ok('5. figurReview nutzt Analyse-Modell', lastModel === 'model-analysis');
  await AI.nutritionMealReview({ items: [{ name: 'Quark', kcal: 170, p: 30 }] });
  ok('6. nutritionMealReview nutzt Analyse-Modell', lastModel === 'model-analysis');
  await AI.nutritionWeekReview({ inGoal: 5, avgKcal: 1900, proteinDays: 4, tracked: 6 });
  ok('7. nutritionWeekReview nutzt Analyse-Modell', lastModel === 'model-analysis');

  console.log(pass ? 'AI-MODEL PASS' : 'AI-MODEL FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
