'use strict';
// Marke + Einkaufsort (Supermarkt) an Ernährungs-Einträgen/Favoriten und die
// Markt-basierte Einkaufsliste: store-Whitelist am Eintrag, entry-update-Patch,
// fav-Roundtrip, Markt-Präferenz im Profil (save-profile-Erhalt + store-set +
// buildState-Echo) und shopping-store-suggest (KI + GLOBALER 30-Tage-Cache,
// gecachte Antworten kosten kein Kontingent).
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
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') { const k = String(c[1]); return kv.has(k) ? kv.get(k) : null; }
    if (op === 'SET') { kv.set(String(c[1]), c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(String(c[1])); return 1; }
    if (op === 'MGET') return c.slice(1).map((k) => (kv.has(String(k)) ? kv.get(String(k)) : null));
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  // ── Mocks (nur was die getesteten Pfade brauchen) ──
  let memberBody = {};
  inject('lib/members.js', {
    bearer: () => 't',
    getSession: async () => ({ id: 'm1' }),
    readBody: async () => memberBody,
    rateLimit: async () => true,
  });
  let aiCalls = 0; let lastAiCtx = null; let aiResult = null;
  inject('lib/ai.js', {
    hasAI: true,
    nutritionStoreSuggest: async (ctx) => { aiCalls++; lastAiCtx = ctx; return aiResult(ctx); },
  });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/inbox.js', {});
  inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', {
    getEntitlement: async () => null,
    isPremium: () => false,
    publicTier: () => ({ premium: false, tier: 'basic', trialing: false, until: null }),
  });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', { exportState: async () => ({}) });
  let quotaLeft = true; let charged = 0;
  inject('lib/nutriquota.js', {
    monthOf: (d) => String(d).slice(0, 7),
    getUsed: async () => 0,
    canUse: async () => quotaLeft,
    incr: async () => { charged++; return charged; },
    publicQuota: () => ({ unlimited: false, limit: 5, used: charged, remaining: Math.max(0, 5 - charged) }),
  });
  inject('lib/welcomeGift.js', {});
  inject('lib/social.js', { socialExport: async () => null });
  inject('lib/figurcheck.js', { getRec: async () => null, exportState: async () => ({}) });
  inject('lib/privacy.js', { recordConsent: async () => {} });
  inject('lib/handled.js', { record: async () => {} });

  const handler = require(path.resolve(ROOT, 'api', 'member', 'nutrition.js'));
  const call = async (method, body) => {
    memberBody = body || {};
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await handler({ method, url: '/api/member/nutrition', headers: {} }, res);
    return JSON.parse(out);
  };

  // ── 0) Profil anlegen ──
  let st = await call('POST', { action: 'save-profile', consent: true, profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('0. Profil angelegt, store leer', st.ok === true && st.profile && st.profile.store === '');

  // ── 1) confirm-log: brand/store whitelisted, Junk verworfen ──
  const longBrand = 'X'.repeat(80);
  st = await call('POST', { action: 'confirm-log', items: [
    { name: 'Skyr', kcal: 90, p: 10, c: 5, f: 0, meal: 'snack', brand: longBrand, store: 'lidl', evilField: 'hack' },
    { name: 'Riegel', kcal: 200, p: 5, c: 20, f: 8, meal: 'snack', store: 'evilmarkt' },
  ] });
  const ents = st.today.entries;
  ok('1. brand gespeichert und auf 60 Zeichen gekürzt', ents[0].brand === 'X'.repeat(60));
  ok('2. store aus Whitelist übernommen', ents[0].store === 'lidl');
  ok('3. unbekanntes Feld verworfen', !('evilField' in ents[0]));
  ok('4. ungültiger store verworfen', !('store' in ents[1]));

  // ── 2) entry-update: brand/store patchbar, bleiben ohne Patch erhalten ──
  const eid = ents[0].id;
  st = await call('POST', { action: 'entry-update', id: eid, patch: { name: 'Skyr Vanille' } });
  let e0 = st.today.entries.filter((x) => x.id === eid)[0];
  ok('5. ohne Patch bleiben brand/store erhalten', e0.brand === 'X'.repeat(60) && e0.store === 'lidl');
  st = await call('POST', { action: 'entry-update', id: eid, patch: { brand: 'Milbona', store: 'aldi' } });
  e0 = st.today.entries.filter((x) => x.id === eid)[0];
  ok('6. brand/store per Patch geändert', e0.brand === 'Milbona' && e0.store === 'aldi');

  // ── 3) Favoriten-Roundtrip: fav-save trägt brand/store, fav-log schreibt sie zurück ──
  st = await call('POST', { action: 'fav-save', name: 'Protein-Pudding', kcal: 150, p: 20, c: 9, f: 3, brand: 'MILSANI', store: 'aldi', custom: true });
  const fav = st.favorites[0];
  ok('7. Favorit mit brand/store gespeichert', st.ok === true && fav.brand === 'MILSANI' && fav.store === 'aldi');
  st = await call('POST', { action: 'fav-log', id: fav.id, factor: 1 });
  const logged = st.today.entries[st.today.entries.length - 1];
  ok('8. fav-log überträgt brand/store auf den Eintrag', logged.brand === 'MILSANI' && logged.store === 'aldi');

  // ── 4) Markt-Präferenz: store-set + buildState-Echo + save-profile-Erhalt ──
  st = await call('POST', { action: 'store-set', store: 'aldi' });
  ok('9. store-set setzt den Markt', st.ok === true && st.profile.store === 'aldi');
  st = await call('POST', { action: 'store-set', store: 'evilmarkt' });
  ok('10. ungültiger Markt -> zurück auf egal', st.profile.store === '');
  await call('POST', { action: 'store-set', store: 'aldi' });
  st = await call('POST', { action: 'save-profile', consent: true, profile: { goal: 'halten', sex: 'w', height: 168, weight: 69, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('11. Neuberechnung ohne store-Feld: Markt bleibt erhalten', st.profile.store === 'aldi');

  // ── 5) shopping-store-suggest: Koch-Plan -> Liste -> KI + globaler Cache ──
  kv.set('nutri:cook:m1', JSON.stringify({ items: [{ id: 'c1', title: 'Quark-Bowl', servings: 1, baseServings: 1, done: false,
    ingredients: [{ text: '150 g Magerquark', grams: 150 }, { text: 'Banane', grams: 0 }] }], checked: {} }));
  aiResult = (ctx) => ({ ok: true, items: ctx.items.map((it) => ({ key: it.key, product: 'MILSANI ' + it.name, note: '' })).concat([{ key: 'erfunden', product: 'Fake', note: '' }]) });
  st = await call('POST', { action: 'shopping-store-suggest', store: '' });
  ok('12. ohne Markt (Profil egal? nein: aldi gesetzt) -> nutzt Profil-Markt', st.ok === true && st.store === 'aldi');
  ok('13. 1. Aufruf: genau 1 KI-Call + Kontingent belastet', aiCalls === 1 && charged === 1);
  ok('14. Vorschläge je Position, erfundene Keys gefiltert', !!st.suggestions.magerquark && !!st.suggestions.banane && !st.suggestions.erfunden);
  ok('15. Grounding: Eigenmarken + diet im KI-Kontext', Array.isArray(lastAiCtx.brands) && lastAiCtx.brands.length > 0 && lastAiCtx.storeLabel === 'ALDI Süd' && lastAiCtx.diet === 'omnivor');
  const cacheKeys = Array.from(kv.keys()).filter((k) => k.indexOf('nutri:storesuggest:aldi:') === 0);
  ok('16. Ergebnisse global gecacht (je Position ein Key)', cacheKeys.length === 2);
  // 2. Aufruf: komplett aus dem Cache, auch OHNE Kontingent, ohne weiteren KI-Call.
  quotaLeft = false;
  st = await call('POST', { action: 'shopping-store-suggest' });
  ok('17. 2. Aufruf: 0 neue KI-Calls, keine neue Belastung', st.ok === true && aiCalls === 1 && charged === 1);
  ok('18. gecachte Vorschläge vollständig', !!st.suggestions.magerquark && st.cachedCount === 2);
  // Anderer Markt = andere Cache-Keys -> KI nötig -> ohne Kontingent premium_required.
  st = await call('POST', { action: 'shopping-store-suggest', store: 'rewe' });
  ok('19. Cache-Miss ohne Kontingent -> premium_required', st.ok === false && st.error === 'premium_required' && aiCalls === 1);
  quotaLeft = true;
  st = await call('POST', { action: 'shopping-store-suggest', store: 'rewe' });
  ok('20. mit Kontingent: neuer Markt löst KI aus', st.ok === true && aiCalls === 2 && st.store === 'rewe');
  // Ohne Markt-Präferenz und ohne body.store -> no_store.
  await call('POST', { action: 'store-set', store: '' });
  st = await call('POST', { action: 'shopping-store-suggest' });
  ok('21. ohne Markt -> no_store', st.ok === false && st.error === 'no_store');
  // Leere Liste -> empty_list.
  kv.set('nutri:cook:m1', JSON.stringify({ items: [], checked: {} }));
  st = await call('POST', { action: 'shopping-store-suggest', store: 'aldi' });
  ok('22. leere Einkaufsliste -> empty_list', st.ok === false && st.error === 'empty_list');

  // ── 6) DSGVO: Export enthält brand/store (Rohdaten) ──
  const ex = await call('POST', { action: 'export' });
  const exStr = JSON.stringify(ex);
  ok('23. Export enthält Marke/Markt der Einträge', exStr.indexOf('Milbona') >= 0 && exStr.indexOf('"store":"aldi"') >= 0);

  console.log(pass ? 'NUTRITION-STORE PASS' : 'NUTRITION-STORE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
