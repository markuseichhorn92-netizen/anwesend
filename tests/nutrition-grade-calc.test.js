'use strict';
// Geschätzter Nutri-Score für Einträge ohne offizielle Note (KI-Schätzung, manueller
// Eintrag, Rezept). Wichtig: nur bei ablesbarer Grammmenge, immer als Schätzung markiert,
// offizielle Noten bleiben unangetastet, und die Mahlzeiten-Ampel behält ihre 50-%-Regel.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') { const k = String(c[1]); return kv.has(k) ? kv.get(k) : null; }
    if (op === 'SET') { kv.set(String(c[1]), c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(String(c[1])); return 1; }
    if (op === 'MGET') return c.slice(1).map((k) => (kv.has(String(k)) ? kv.get(String(k)) : null));
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });
  let memberBody = {};
  inject('lib/members.js', { bearer: () => 't', getSession: async () => ({ id: 'm1' }), readBody: async () => memberBody, rateLimit: async () => true });
  inject('lib/ai.js', { hasAI: false });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/inbox.js', {}); inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', { getEntitlement: async () => null, isPremium: () => true, publicTier: () => ({ premium: true, tier: 'premium', trialing: false, until: null }) });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', { exportState: async () => ({}) });
  inject('lib/nutriquota.js', { monthOf: (d) => String(d).slice(0, 7), getUsed: async () => 0, canUse: async () => true, incr: async () => 1, publicQuota: () => ({ unlimited: true }) });
  inject('lib/welcomeGift.js', {}); inject('lib/social.js', { socialExport: async () => null });
  inject('lib/figurcheck.js', { getRec: async () => null }); inject('lib/privacy.js', { recordConsent: async () => {} });
  inject('lib/handled.js', { record: async () => {} });

  const handler = require(path.resolve(ROOT, 'api', 'member', 'nutrition.js'));
  const call = async (body) => {
    memberBody = body || {};
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await handler({ method: 'POST', url: '/api/member/nutrition', headers: {} }, res);
    return JSON.parse(out);
  };
  const find = (st, name) => st.today.entries.filter((e) => e.name === name)[0];

  await call({ action: 'save-profile', consent: true, profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });

  // 1) KI-/manueller Eintrag MIT Grammangabe -> geschätzte Note
  let st = await call({ action: 'confirm-log', items: [
    { name: 'Magerquark', portion: '250 g', kcal: 168, p: 30, c: 10, f: 0.8, meal: 'fruehstueck', estimated: true },
    { name: 'Schokoriegel', portion: '50 g', kcal: 260, p: 3, c: 30, f: 14, sugar: 28, satFat: 8, salt: 0.2, meal: 'snack', estimated: true },
    { name: 'Restaurantteller', portion: '1 Portion', kcal: 700, p: 30, c: 60, f: 30, meal: 'mittag', estimated: true },
  ] });
  const quark = find(st, 'Magerquark'), riegel = find(st, 'Schokoriegel'), teller = find(st, 'Restaurantteller');
  ok('1. Eintrag mit Grammangabe bekommt eine Note', !!quark.grade && quark.gradeCalc === true);
  ok('2. Magerquark schneidet gut ab (A/B)', quark.grade === 'A' || quark.grade === 'B');
  ok('3. Schokoriegel schneidet schlecht ab (D/E)', riegel.grade === 'D' || riegel.grade === 'E');
  ok('4. Ohne Grammangabe wird NICHT geraten', !teller.grade && !teller.gradeCalc);

  // 2) Offizielle Note (Barcode-Produkt) bleibt unangetastet
  st = await call({ action: 'confirm-log', items: [
    { name: 'Skyr', portion: '150 g', kcal: 95, p: 17, c: 6, f: 0.2, meal: 'snack', source: 'openfoodfacts', grade: 'C' },
  ] });
  const skyr = find(st, 'Skyr');
  ok('5. Offizielle Note wird nicht überschrieben', skyr.grade === 'C' && !skyr.gradeCalc);

  // 3) Nach dem Bearbeiten wird die Schätzung neu gerechnet, die offizielle bleibt
  st = await call({ action: 'entry-update', id: riegel.id, patch: { portion: '20 g', kcal: 104, p: 1, c: 12, f: 6, sugar: 11, satFat: 3 } });
  const riegel2 = st.today.entries.filter((e) => e.id === riegel.id)[0];
  ok('6. Geschätzte Note wird nach Änderung neu bestimmt', riegel2.gradeCalc === true && /^[A-E]$/.test(riegel2.grade));
  st = await call({ action: 'entry-update', id: skyr.id, patch: { portion: '200 g' } });
  const skyr2 = st.today.entries.filter((e) => e.id === skyr.id)[0];
  ok('7. Offizielle Note überlebt das Bearbeiten', skyr2.grade === 'C' && !skyr2.gradeCalc);

  // 4) Einheiten: kg/l werden korrekt umgerechnet
  st = await call({ action: 'log-manual', name: 'Saft', portion: '0,5 l', kcal: 225, p: 1, c: 54, f: 0, sugar: 50, meal: 'snack' });
  const saft = find(st, 'Saft');
  ok('8. Liter-Angabe wird als 500 g gelesen', !!saft.grade && saft.gradeCalc === true);

  // 5) Die 50-%-Regel der Mahlzeiten-Ampel bleibt im Client unverändert
  const html = fs.readFileSync(path.resolve(ROOT, 'mitglieder.html'), 'utf8');
  ok('9. Ampel-Schutzregel (>=50 % bewertet) unverändert', html.indexOf('if(!wsum||!total||wsum<total*0.5) return null;') >= 0);
  ok('10. Schätzung wird in der Ampel kenntlich gemacht', /nutriChip\(it\.grade,20,it\.gradeCalc\)/.test(html) && /geschätzt/.test(html));

  console.log(pass ? 'NUTRITION-GRADE-CALC PASS' : 'NUTRITION-GRADE-CALC FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
