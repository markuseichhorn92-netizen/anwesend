'use strict';
// Vital-Check ohne Brustgurt: Gibt es heute KEINE Gurt-Messung, übernehmen die passiven
// Health-Werte (Apple Health / Health Connect) das Tages-Urteil (verdict.dataSource='health',
// inkl. Belastungs-Empfehlung). Eine Gurt-Messung von HEUTE gewinnt immer ('gurt').
// Getestet über den echten API-Handler (api/member/morning.js) mit In-Memory-KV.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── In-Memory-KV als lib/store ──
  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), key = String(c[1] || '');
    if (op === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (op === 'SET') { kv.set(key, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(key); return 1; }
    if (op === 'INCR') { const n = (Number(kv.get(key)) || 0) + 1; kv.set(key, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  // ── lib/members-Mock: Session + Body, kein Magicline ──
  inject('lib/members.js', {
    bearer: () => 't',
    getSession: async () => ({ id: 'u1' }),
    readBody: async () => ({}),
    rateLimit: async () => true,
    getMember: async () => ({ firstName: 'Max' }),
    getContract: async () => null,
    ml: async () => ({ status: 404, json: null }),
  });

  const MO = require(path.resolve(ROOT, 'lib', 'morning.js'));
  const V = require(path.resolve(ROOT, 'lib', 'vitals.js'));
  const handler = require(path.resolve(ROOT, 'api', 'member', 'morning.js'));

  const iso = (d) => d.toISOString().slice(0, 10);
  const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return iso(d); };
  const today = day(0);

  const get = async () => {
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await handler({ method: 'GET', headers: {} }, res);
    return JSON.parse(out);
  };

  // Einwilligung (Vital-Check) aktivieren.
  await MO.setConsent('u1', true);

  // ── A) NUR Health-Werte (Apple Health / Health Connect), NIE Gurt gemessen ──
  // 3 Vortage (Baseline) + heute leicht erhöhter Ruhepuls.
  for (let i = 3; i >= 1; i--) await V.add('u1', { date: day(-i), restingHr: 58, hrv: 45, sleepMin: 440 }, Date.now() - i * 864e5);
  await V.add('u1', { date: today, restingHr: 60, hrv: 44, sleepMin: 430 }, Date.now());
  let st = await get();
  ok('A1. ok + verfügbar', st.ok === true && st.available === true);
  ok('A2. Tages-Urteil kommt aus Health (dataSource=health)', st.verdict && st.verdict.dataSource === 'health');
  ok('A3. Urteil ist eine echte Ampel (nicht Kalibrierung)', st.verdict && ['gruen', 'gelb', 'rot'].indexOf(st.verdict.level) >= 0);
  ok('A4. Belastungs-Empfehlung vorhanden (aus Health-Ampel)', !!st.trainingLoad && st.trainingLoad.key !== 'kalibrierung');
  ok('A5. Health-Block mit Bereitschaft ausgeliefert', !!(st.vitals && st.vitals.readiness && st.vitals.readiness.score != null));
  ok('A6. Vital-Akku nutzt die passive Quelle', !!(st.battery && st.battery.source === 'passiv'));

  // ── B) Gurt-Messung GESTERN, Health-Werte HEUTE -> Health gewinnt (aktueller) ──
  for (let i = 4; i >= 1; i--) await MO.add('u1', { date: day(-i), rhr: 57, hrvRmssd: 48 }, Date.now() - i * 864e5 + 1000);
  st = await get();
  ok('B1. Gurt nur bis gestern -> weiterhin Health', st.verdict && st.verdict.dataSource === 'health');
  ok('B2. Gurt-Verlauf bleibt unangetastet ausgeliefert', Array.isArray(st.list) && st.list.length === 4);

  // ── C) Gurt-Messung HEUTE -> Gurt gewinnt immer ──
  await MO.add('u1', { date: today, rhr: 56, hrvRmssd: 50 }, Date.now());
  st = await get();
  ok('C1. Gurt-Messung von heute -> dataSource=gurt', st.verdict && st.verdict.dataSource === 'gurt');
  ok('C2. Urteil folgt der Gurt-Physiologie', st.verdict && ['gruen', 'gelb', 'rot', 'kalibrierung'].indexOf(st.verdict.level) >= 0);

  console.log(pass ? 'MORNING-HEALTH-FALLBACK PASS' : 'MORNING-HEALTH-FALLBACK FAIL');
  process.exit(pass ? 0 : 1);
}

run().catch((e) => { console.error('ERR', e); process.exit(1); });
