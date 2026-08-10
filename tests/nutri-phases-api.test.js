'use strict';
// Phasenplan Ende-zu-Ende: Team plant Phasen (/api/team/nutrition), sie übersteuern die
// Zielwerte, wechseln AUTOMATISCH mit dem Datum, das Mitglied sieht sie in
// /api/member/nutrition (targets + nutriPhase), sie überleben save-profile auf beiden
// Seiten, haben Vorrang vor targetOverride – und greifen NIE bei unter 18-Jährigen.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const P = require(path.resolve(ROOT, 'lib/nutriPhases.js'));
const TODAY = P.berlinToday();
const ago = (n) => P.addDays(TODAY, -n);

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── In-Memory-KV (Team + Mitglied teilen sich nutri:p:<id>) ──
  const kv = new Map(); const sets = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(k); return 1; }
    if (op === 'MGET') return c.slice(1).map((x) => (kv.has(String(x)) ? kv.get(String(x)) : null));
    if (op === 'SADD') { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(String(c[2])); return 1; }
    if (op === 'SREM') { if (sets.has(k)) sets.get(k).delete(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return sets.has(k) ? Array.from(sets.get(k)) : [];
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  let memberBody = {};
  inject('lib/members.js', { bearer: () => 't', getSession: async () => ({ id: 'm1' }), readBody: async (req) => (req && req.__body) || memberBody, rateLimit: async () => true });
  inject('lib/teamAuth.js', { requireTeam: async () => ({ user: 'trainer@fitinn', name: 'Trainer' }) });
  inject('lib/capabilities.js', { requireCap: () => true });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/ai.js', {});
  inject('lib/inbox.js', {});
  inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', { getEntitlement: async () => null, isPremium: () => false, publicTier: () => ({ premium: false, tier: 'basic', trialing: false, until: null }) });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', {});
  inject('lib/nutriquota.js', { monthOf: (d) => String(d).slice(0, 7), getUsed: async () => 0, publicQuota: () => ({ unlimited: false, limit: 5, used: 0, remaining: 5 }) });
  inject('lib/welcomeGift.js', {});
  inject('lib/social.js', {});
  inject('lib/figurcheck.js', {});
  inject('lib/privacy.js', { recordConsent: async () => {} });

  const teamHandler = require(path.resolve(ROOT, 'api', 'team', 'nutrition.js'));
  const memberHandler = require(path.resolve(ROOT, 'api', 'member', 'nutrition.js'));
  const teamPost = async (body) => { let out = ''; const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } }; await teamHandler({ method: 'POST', url: '/api/team/nutrition', headers: {}, __body: body }, res); return JSON.parse(out); };
  const memberCall = async (method, body) => { memberBody = body || {}; let out = ''; const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } }; await memberHandler({ method, url: '/api/member/nutrition', headers: {} }, res); return JSON.parse(out); };

  const PH = (start, source) => ({
    startDate: start, source: source || 'team',
    phases: [
      { name: 'Aktivierung', kind: 'aktivierung', weeks: 6, kcal: 2400, protein: 160, carbs: 250, fat: 80 },
      { name: 'Reduktion', kind: 'reduktion', weeks: 8, kcal: 2000, protein: 180, carbs: 170, fat: 70 },
      { name: 'Stabilisierung', kind: 'stabilisierung', weeks: 4, kcal: 2200, protein: 170, carbs: 210, fat: 75 },
    ],
  });

  // ── 1) Profil anlegen ──
  let st = await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('1. Profil da, Formelwerte', st.ok === true && st.targets.kcal > 0 && !st.targets.custom);
  const formulaKcal = st.targets.kcal;

  // ── 2) Phasenplan setzen (heute gestartet) -> Phase 1 gilt sofort ──
  st = await teamPost({ action: 'phases-set', id: 'm1', plan: PH(TODAY) });
  ok('2. phases-set ok', st.ok === true, JSON.stringify(st.error || ''));
  ok('3. Team: Phase 1 aktiv, Zielwerte kommen aus der Phase', st.phases.status === 'running' && st.phases.index === 0 && st.targets.kcal === 2400 && st.targets.custom === true, JSON.stringify({ s: st.phases.status, k: st.targets.kcal }));
  ok('4. Team bekommt Rohplan + Vorlagenliste für den Editor', !!st.phasePlan && Array.isArray(st.phaseTemplates) && st.phaseTemplates.length > 0);

  // ── 3) Mitglied sieht Phase + Werte ──
  let ms = await memberCall('GET');
  ok('5. Mitglied: Zielwerte aus Phase 1', ms.ok === true && ms.targets.kcal === 2400 && ms.targets.custom === true);
  ok('6. Mitglied: nutriPhase mit Name/Woche/Nächster', ms.nutriPhase && ms.nutriPhase.name === 'Aktivierung' && ms.nutriPhase.weekInPhase === 1 && ms.nutriPhase.next && ms.nutriPhase.next.name === 'Reduktion', JSON.stringify(ms.nutriPhase && { n: ms.nutriPhase.name, w: ms.nutriPhase.weekInPhase }));
  ok('7. Mitglied bekommt KEINE Team-Daten (setBy/Analyse)', JSON.stringify(ms.nutriPhase).indexOf('trainer@fitinn') < 0 && ms.nutriPhase.setBy === undefined);

  // ── 4) AUTOMATISCHER WECHSEL: Start 43 Tage her -> Phase 2 (Kernversprechen) ──
  st = await teamPost({ action: 'phases-set', id: 'm1', plan: PH(ago(43)) });
  ok('8. Auto-Wechsel: nach 43 Tagen ist Phase 2 aktiv', st.phases.index === 1 && st.targets.kcal === 2000, JSON.stringify({ i: st.phases.index, k: st.targets.kcal }));
  ms = await memberCall('GET');
  ok('9. Mitglied sieht den Wechsel ohne Zutun', ms.targets.kcal === 2000 && ms.nutriPhase.name === 'Reduktion' && ms.nutriPhase.weekInPhase === 1, JSON.stringify({ k: ms.targets.kcal, n: ms.nutriPhase.name, w: ms.nutriPhase.weekInPhase }));
  ok('10. Notiz nennt die Phase verständlich', /Reduktion/.test(ms.targets.note || ''), ms.targets.note);

  // ── 5) Vorrang vor targetOverride (sonst wäre der Wechsel wirkungslos) ──
  st = await teamPost({ action: 'targets-set', id: 'm1', targets: { kcal: 1500, protein: 120, water: 3 }, note: 'alt' });
  ok('11. Phase schlägt statischen Override bei kcal', st.targets.kcal === 2000, 'kcal=' + st.targets.kcal);
  ok('12. Wasser kommt weiterhin aus dem Override', st.targets.water === 3, 'water=' + st.targets.water);

  // ── 6) Plan überlebt Neuberechnung auf BEIDEN Seiten (die fragile Zeile) ──
  st = await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 68, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('13. Team-Neuberechnung: Plan überlebt', !!st.phasePlan && st.targets.kcal === 2000);
  ms = await memberCall('POST', { action: 'save-profile', profile: { goal: 'halten', sex: 'w', height: 168, weight: 69, age: 30, activity: 'aktiv', diet: 'omnivor' }, consent: true });
  ok('14. Mitglied-Neuberechnung: Plan überlebt', ms.nutriPhase && ms.targets.kcal === 2000, JSON.stringify({ k: ms.targets.kcal, p: !!ms.nutriPhase }));

  // ── 7) Planende: Team-Plan hält die letzte (Stabilisierungs-)Phase ──
  st = await teamPost({ action: 'phases-set', id: 'm1', plan: PH(ago(200), 'team') });
  ok('15. Team-Plan abgelaufen -> letzte Phase gilt weiter', st.phases.status === 'finished' && st.phases.holdLast === true && st.targets.kcal === 2200, JSON.stringify({ s: st.phases.status, k: st.targets.kcal }));

  // ── 8) Planende: Analyse-Plan läuft aus -> zurück zur Formel ──
  st = await teamPost({ action: 'phases-set', id: 'm1', plan: PH(ago(200), 'analysis') });
  ok('16. Analyse-Plan abgelaufen -> Formel greift wieder', st.phases.expired === true && st.phases.holdLast === false && st.targets.kcal !== 2200, JSON.stringify({ e: st.phases.expired, k: st.targets.kcal }));
  ms = await memberCall('GET');
  ok('17. Mitglied: abgelaufener Analyse-Plan zeigt keine aktiven Werte', ms.targets.kcal !== 2200 && ms.nutriPhase && ms.nutriPhase.expired === true);

  // ── 9) Vorlage: Gesamtdauer vorgeben, nichts wird gespeichert ──
  const tpl = await teamPost({ action: 'phases-template', id: 'm1', template: 'aktivierung-reduktion', totalWeeks: 15, startDate: TODAY });
  const tplSum = tpl.ok ? tpl.proposal.phases.reduce((a, p) => a + p.weeks, 0) : -1;
  ok('18. Vorlage liefert Vorschlag über genau 15 Wochen', tpl.ok === true && tplSum === 15, JSON.stringify({ ok: tpl.ok, sum: tplSum }));
  ok('19. Vorlage endet mit Stabilisierung', tpl.ok && tpl.proposal.phases[tpl.proposal.phases.length - 1].kind === 'stabilisierung');

  // ── 10) Löschen -> zurück auf Override/Formel ──
  st = await teamPost({ action: 'phases-clear', id: 'm1' });
  ok('20. phases-clear entfernt den Plan', st.phasePlan === null && st.phases.status === 'none');
  ms = await memberCall('GET');
  ok('21. Mitglied: kein Plan mehr -> nutriPhase null, Override greift wieder', ms.nutriPhase === null && ms.targets.kcal === 1500, JSON.stringify({ p: ms.nutriPhase, k: ms.targets.kcal }));

  // ── 11) Minderjährigenschutz (darf nie umgangen werden) ──
  await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 165, weight: 58, age: 16, activity: 'moderat', diet: 'omnivor' } });
  const minor = await teamPost({ action: 'phases-set', id: 'm1', plan: PH(TODAY) });
  ok('22. unter 18: phases-set wird abgelehnt', minor.ok === false && minor.error === 'under18', JSON.stringify(minor));

  // Bestehender Plan + nachträglich Alter < 18 -> Schutz greift sofort, Plan bleibt gespeichert
  await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });
  await teamPost({ action: 'phases-set', id: 'm1', plan: PH(TODAY) });
  st = await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 165, weight: 58, age: 16, activity: 'moderat', diet: 'omnivor' } });
  ok('23. unter 18: Phase übersteuert NICHT mehr', st.targets.custom !== true && st.targets.kcal !== 2400, JSON.stringify({ c: st.targets.custom, k: st.targets.kcal }));
  ok('24. unter 18: Plan bleibt gespeichert (kein Datenverlust)', !!st.phasePlan && st.phasesBlocked === true);
  ms = await memberCall('GET');
  ok('25. unter 18: Mitglied sieht keine Phasenkarte', ms.nutriPhase === null && ms.targets.custom !== true);

  console.log(pass ? 'NUTRI-PHASES-API PASS' : 'NUTRI-PHASES-API FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
