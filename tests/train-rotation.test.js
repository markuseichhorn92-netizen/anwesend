'use strict';
// Split-Rotation (api/member/training.js): Der heute fällige Plan-Tag rotiert
// A -> B -> C -> wieder A. Abschluss eines Tages setzt den Marker; ein heute
// angefangener/abgeschlossener Tag bleibt stehen; Planwechsel setzt zurück.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const KV = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return KV.has(c[1]) ? KV.get(c[1]) : null;
    if (op === 'SET') { KV.set(c[1], c[2]); return 'OK'; }
    if (op === 'DEL') { KV.delete(c[1]); return 1; }
    return null;
  }),
});
const PLAN = { id: 'p1', title: 'Split', days: [
  { name: 'Tag A', exercises: [{ name: 'A1' }, { name: 'A2' }] },
  { name: 'Tag B', exercises: [{ name: 'B1' }] },
  { name: 'Tag C', exercises: [{ name: 'C1' }] },
] };
inject('lib/members.js', { getSession: async () => ({ id: 'M1' }), bearer: () => 't', readBody: async (req) => req.body || {} });
inject('lib/training.js', {
  resolveActive: async () => ({ plan: Object.assign({ source: 'library' }, PLAN), startedAt: 1 }),
  getLibrary: () => [], trimPlan: (p) => p, tipOfDay: () => '', INSPIRATION: [],
  GOALS: {}, LEVELS: {}, LOCATIONS: {},
});
inject('lib/exercises.js', { publicList: () => [], GROUPS: [], search: () => [] });
inject('lib/ai.js', { hasAI: false });
inject('lib/entitlements.js', { getEntitlement: async () => null, publicTier: () => ({ premium: false }) });
inject('lib/nutriquota.js', { monthOf: () => '2026-07', getUsed: async () => 0, publicQuota: () => ({}) });

const H = require(path.join(ROOT, 'api/member/training.js'));
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(s) { this.body = s; } }; }
async function call(method, body) { const r = res0(); await H({ method, headers: {}, body }, r); return JSON.parse(r.body); }
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Frisch: kein Marker -> Tag A (Index 0)
  let g = await call('GET');
  ok('1. ohne Verlauf ist Tag A dran', g.ok && g.myPlan.todayDay === 0);

  // 2) Tag A nur angefangen -> bleibt Tag A, KEIN Rotations-Marker
  await call('POST', { action: 'session-set', key: 'd0e0', done: true });
  g = await call('GET');
  ok('2. angefangener Tag bleibt stehen', g.myPlan.todayDay === 0 && !KV.has('train:rot:M1'));

  // 3) Tag A komplett -> Marker gesetzt; heute bleibt Tag A (Erfolgsansicht)
  await call('POST', { action: 'session-set', key: 'd0e1', done: true });
  const rot = JSON.parse(KV.get('train:rot:M1') || 'null');
  ok('3. Abschluss setzt Marker (Tag A, heute)', rot && rot.day === 0 && rot.date === today && rot.planId === 'p1');
  g = await call('GET');
  ok('3b. heute abgeschlossen -> Anzeige bleibt Tag A', g.myPlan.todayDay === 0);

  // 4) Nächster Besuch (anderer Tag): Session weg, Marker von gestern -> Tag B
  KV.delete('train:sess:M1:' + today);
  KV.set('train:rot:M1', JSON.stringify({ planId: 'p1', day: 0, date: '2000-01-01' }));
  g = await call('GET');
  ok('4. nach Tag A ist Tag B dran', g.myPlan.todayDay === 1);

  // 5) Wrap-around: nach Tag C ist wieder Tag A dran
  KV.set('train:rot:M1', JSON.stringify({ planId: 'p1', day: 2, date: '2000-01-01' }));
  g = await call('GET');
  ok('5. nach Tag C rotiert es zurück auf Tag A', g.myPlan.todayDay === 0);

  // 6) Planwechsel: Marker eines anderen Plans zählt nicht -> Tag A
  KV.set('train:rot:M1', JSON.stringify({ planId: 'ALT', day: 1, date: '2000-01-01' }));
  g = await call('GET');
  ok('6. Marker eines alten Plans wird ignoriert', g.myPlan.todayDay === 0);

  // 7) Heute Tag B angefangen -> Tag B hat Vorrang vor der Rotation
  KV.set('train:rot:M1', JSON.stringify({ planId: 'p1', day: 2, date: '2000-01-01' }));
  await call('POST', { action: 'session-set', key: 'd1e0', sets: 2 });
  g = await call('GET');
  ok('7. heute angefangener Tag hat Vorrang', g.myPlan.todayDay === 1);

  console.log(pass ? 'TRAIN-ROTATION PASS' : 'TRAIN-ROTATION FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
