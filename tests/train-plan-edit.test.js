'use strict';
// Mitglied bearbeitet den eigenen aktiven Trainingsplan (api/member/training.js
// action 'plan-edit'): Sätze ändern, Übung entfernen/hinzufügen. Prüft: persönliche
// Kopie (source 'finn'), Plan-id + startedAt erhalten, Werte normalisiert/geklammert,
// heutige Session zurückgesetzt. Nutzt das ECHTE lib/training.js (Round-Trip).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const KV = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return KV.has(c[1]) ? KV.get(c[1]) : null;
    if (op === 'SET') { KV.set(c[1], c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.has(c[1]); KV.delete(c[1]); return had ? 1 : 0; }
    return null;
  }),
});
// members/ai/entitlements/quota gemockt; lib/training.js + lib/exercises.js ECHT.
inject('lib/members.js', { getSession: async () => ({ id: 'M1' }), bearer: () => 't', readBody: async (req) => req.body || {} });
inject('lib/ai.js', { hasAI: false });
inject('lib/entitlements.js', { getEntitlement: async () => null, isPremium: () => false, publicTier: () => ({ premium: false }) });
inject('lib/nutriquota.js', { monthOf: () => '2026-07', getUsed: async () => 0, publicQuota: () => ({}) });

const H = require(path.join(ROOT, 'api/member/training.js'));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function call(method, body) { const r = res0(); await H({ method, headers: {}, body }, r); return JSON.parse(r.body); }

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // Aktiven persönlichen Plan + heutige Session seeden.
  const PLAN = { id: 'p1', title: 'Mein Plan', goal: 'muskelaufbau', level: 'mittel', location: 'studio', weeks: 8, days: [
    { name: 'Tag A', exercises: [{ name: 'Bankdrücken', machine: 'Flachbank', group: 'brust', sets: 3, reps: '8–12', rest: '90 s' }, { name: 'Butterfly', group: 'brust', sets: 3, reps: '12', rest: '60 s' }] },
    { name: 'Tag B', exercises: [{ name: 'Kniebeuge', group: 'beine', sets: 4, reps: '6–8', rest: '120 s' }] },
  ] };
  KV.set('train:active:M1', JSON.stringify({ source: 'finn', plan: PLAN, startedAt: 111 }));
  KV.set('train:sess:M1:' + today, JSON.stringify({ planId: 'p1', items: { d0e0: { done: true } } }));

  // Edit: Tag A Übung 0 Sätze 5/„5–8"; Tag A Übung 1 entfernen; Tag B eine Übung ergänzen.
  const edited = JSON.parse(JSON.stringify(PLAN));
  edited.days[0].exercises[0].sets = '5';        // wie aus einem Text-Input
  edited.days[0].exercises[0].reps = '5–8';
  edited.days[0].exercises.splice(1, 1);         // Butterfly entfernt
  edited.days[1].exercises.push({ name: 'Beinpresse', group: 'beine', sets: 3, reps: '8–12', rest: '60–90 s' });

  const r = await call('POST', { action: 'plan-edit', plan: edited });
  ok('1. plan-edit ok + frischer Plan zurück', r.ok === true && r.myPlan && r.myPlan.plan, JSON.stringify(r).slice(0, 200));

  const stored = JSON.parse(KV.get('train:active:M1') || 'null');
  ok('2. persönliche Kopie (source finn)', stored && stored.source === 'finn');
  ok('3. Plan-id + startedAt erhalten', stored && stored.plan.id === 'p1' && stored.startedAt === 111, JSON.stringify(stored && { id: stored.plan.id, s: stored.startedAt }));
  ok('4. Tag A: Übung entfernt (1 statt 2)', stored && stored.plan.days[0].exercises.length === 1);
  ok('5. Sätze geändert + numerisch normalisiert', stored && stored.plan.days[0].exercises[0].sets === 5 && stored.plan.days[0].exercises[0].reps === '5–8', JSON.stringify(stored && stored.plan.days[0].exercises[0]));
  ok('6. Tag B: Übung hinzugefügt (2 statt 1)', stored && stored.plan.days[1].exercises.length === 2 && stored.plan.days[1].exercises[1].name === 'Beinpresse');
  ok('7. heutige Session zurückgesetzt', !KV.has('train:sess:M1:' + today));

  // Ungültig: leere Tage -> invalid_plan, aktiver Plan unverändert.
  const before = KV.get('train:active:M1');
  const bad = await call('POST', { action: 'plan-edit', plan: { id: 'p1', days: [] } });
  ok('8. leerer Plan -> invalid_plan', bad.ok === false && bad.error === 'invalid_plan');
  ok('9. aktiver Plan bei Fehler unverändert', KV.get('train:active:M1') === before);

  // Kein aktiver Plan -> no_active.
  KV.delete('train:active:M1');
  const none = await call('POST', { action: 'plan-edit', plan: edited });
  ok('10. ohne aktiven Plan -> no_active', none.ok === false && none.error === 'no_active');

  console.log(pass ? 'TRAIN-PLAN-EDIT PASS' : 'TRAIN-PLAN-EDIT FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
