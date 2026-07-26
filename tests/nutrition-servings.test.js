'use strict';
// Eigene Standard-Portionen je Favorit („1 Scheibe = 45 g"): serverseitig validiert,
// beim Loggen exakt über die Grammbasis skaliert, Portionsname bleibt im Eintrag lesbar.
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
  await call({ action: 'save-profile', consent: true, profile: { goal: 'halten', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });

  // Vollkornbrot je 100 g mit zwei Standard-Portionen
  let r = await call({ action: 'fav-save', name: 'Vollkornbrot', portion: '100 g', kcal: 220, p: 8, c: 40, f: 2, gramsBase: 100, custom: true,
    servings: [{ label: '1 Scheibe', grams: 45 }, { label: '1 TL', grams: 5 }, { label: '', grams: 30 }, { label: 'Zuviel', grams: 9999 }] });
  const fav = r.favorites[0];
  ok('1. Gültige Portionen gespeichert', Array.isArray(fav.servings) && fav.servings.length === 2);
  ok('2. Ohne Namen oder mit absurder Menge verworfen', fav.servings.map((s) => s.label).join(',') === '1 Scheibe,1 TL');

  // Portion loggen -> exakt skaliert (45 g von 100 g = 45 %)
  let st = await call({ action: 'fav-log', id: fav.id, serving: '1 Scheibe' });
  const e = st.today.entries[st.today.entries.length - 1];
  ok('3. Werte exakt auf 45 g skaliert', e.kcal === 99 && e.c === 18);
  ok('4. Portionsname bleibt lesbar', e.portion === '1 Scheibe (45 g)');

  // Unbekannte Portion -> Fallback auf die normale Portion, nichts Erfundenes
  st = await call({ action: 'fav-log', id: fav.id, serving: 'Gibt es nicht' });
  const e2 = st.today.entries[st.today.entries.length - 1];
  ok('5. Unbekannte Portion fällt sauber zurück', e2.kcal === 220 && e2.portion === '100 g');

  // Grenzen: maximal 5 Portionen
  r = await call({ action: 'fav-save', name: 'Vielportion', portion: '100 g', kcal: 100, p: 1, c: 1, f: 1, gramsBase: 100, custom: true,
    servings: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: 'P' + n, grams: n * 10 })) });
  const fav2 = r.favorites.filter((x) => x.name === 'Vielportion')[0];
  ok('6. Höchstens 5 Portionen je Lebensmittel', fav2.servings.length === 5);

  // Client zeigt Chips + Anlegen
  const html = fs.readFileSync(path.resolve(ROOT, 'mitglieder.html'), 'utf8');
  ok('7. Portions-Chips im Favoriten-Manager', /ernFavServRow/.test(html) && /ernFavServLog/.test(html));
  ok('8. Portion anlegen und zurücksetzen möglich', /ernFavServAdd/.test(html) && /ernFavServClear/.test(html));

  console.log(pass ? 'NUTRITION-SERVINGS PASS' : 'NUTRITION-SERVINGS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
