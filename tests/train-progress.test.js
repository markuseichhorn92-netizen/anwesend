'use strict';
process.env.FEATURE_ABO = '1';   // Dieser Test prueft das seit 10.9.2026 abgeschaltete Abo-Modell - ohne Schalter waere alles inklusive.
// FINN-Auto-Progression (Coach Premium): api/member/training.js action 'progress'.
//   1. ohne aktiven Plan            -> no_plan
//   2. mit Plan aber ohne Verlauf   -> no_history
//   3. ohne Premium + Kontingent 0  -> premium_required
//   4. mit Premium + Verlauf        -> ok + Plan; Plan & Protokoll gehen an FINN
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fresh = (rel) => { const p = path.resolve(ROOT, rel); delete require.cache[p]; return require(p); };
function res0() { return { statusCode: 0, headers: {}, setHeader() {}, body: null, end(s) { this.body = s; } }; }
function reqFor(body) { return { method: 'POST', headers: { authorization: 'Bearer t' }, on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb(); } }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  const kv = new Map(); const lists = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1] || '');
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(k); lists.delete(k); return 1; }
    if (op === 'INCR') { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'LPUSH') { const a = lists.get(k) || []; a.unshift(c[2]); lists.set(k, a); return a.length; }
    if (op === 'LTRIM') { const a = lists.get(k) || []; lists.set(k, a.slice(Number(c[2]), Number(c[3]) + 1)); return 'OK'; }
    if (op === 'LRANGE') { const a = lists.get(k) || []; const e = Number(c[3]); return a.slice(Number(c[2]), e < 0 ? undefined : e + 1); }
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });
  inject('lib/members.js', { getSession: async () => ({ id: 'M1', firstName: 'Max' }), bearer: () => 't', readBody: (req) => new Promise((rs) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { rs(JSON.parse(b || '{}')); } catch (e) { rs({}); } }); }) });
  inject('lib/exercises.js', { publicList: () => [], GROUPS: [], search: () => [] });
  let aiCtx = null;
  inject('lib/ai.js', { hasAI: true, trainingPlan: async (ctx) => { aiCtx = ctx; return { ok: true, plan: { title: 'Prog', days: [{ name: 'A', exercises: [{ name: 'Kniebeuge', sets: 3, reps: '10' }] }] } }; } });
  const activePlan = { id: 'p1', title: 'Ganzkörper', goal: 'aufbau', level: 'mittel', location: 'studio', equipment: [], days: [{ name: 'A', exercises: [{ name: 'Kniebeuge', sets: 3, reps: '10' }] }] };
  let active = { plan: activePlan, startedAt: 1 };
  inject('lib/training.js', { resolveActive: async () => active, normalizePlan: (p) => (p && p.days && p.days.length) ? p : null, STUDIO_EQUIPMENT: 'Geräte', GOALS: { aufbau: 1, ganzkoerper: 1 }, LEVELS: { mittel: 1 }, LOCATIONS: { studio: 1 }, getLibrary: () => [], trimPlan: (p) => p, tipOfDay: () => '', INSPIRATION: [] });
  let quotaOk = true;
  inject('lib/nutriquota.js', { monthOf: () => '2026-07', getUsed: async () => 0, canUse: async () => quotaOk, incr: async () => 1, publicQuota: () => ({ remaining: 4, limit: 5 }) });
  const Ent = fresh('lib/entitlements.js');
  const handler = fresh('api/member/training.js');

  // 1. ohne aktiven Plan
  active = null;
  let r = res0(); await handler(reqFor({ action: 'progress' }), r); let j = JSON.parse(r.body);
  ok('1. ohne Plan -> no_plan', j.ok === false && j.error === 'no_plan');
  active = { plan: activePlan, startedAt: 1 };

  // 2. Plan aber kein Verlauf
  r = res0(); await handler(reqFor({ action: 'progress' }), r); j = JSON.parse(r.body);
  ok('2. kein Verlauf -> no_history', j.ok === false && j.error === 'no_history');

  // Verlauf: 2 abgeschlossene Einheiten
  lists.set('train:hist:M1', [JSON.stringify({ t: '2026-07-16', title: 'A', ex: [{ n: 'Kniebeuge', s: 3 }] }), JSON.stringify({ t: '2026-07-14', title: 'A', ex: [{ n: 'Kniebeuge', s: 3 }] })]);

  // 3. kein Premium + Kontingent 0
  quotaOk = false;
  r = res0(); await handler(reqFor({ action: 'progress' }), r); j = JSON.parse(r.body);
  ok('3. kein Premium + Kontingent 0 -> premium_required', j.ok === false && j.error === 'premium_required');

  // 4. Premium -> ok, Plan, Progression-Kontext an FINN
  await Ent.setEntitlement('M1', { tier: 'premium', status: 'active', source: 'magicline', updatedAt: Date.now() });
  r = res0(); await handler(reqFor({ action: 'progress' }), r); j = JSON.parse(r.body);
  ok('4. Premium -> ok, Plan, progression-Flag', j.ok === true && !!j.plan && j.progression === true);
  ok('4b. Plan + Protokoll gehen an FINN (progression-Kontext)', !!(aiCtx && aiCtx.progression && aiCtx.progression.planText && aiCtx.progression.historyText));

  console.log(pass ? 'TRAIN-PROGRESS PASS' : 'TRAIN-PROGRESS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
