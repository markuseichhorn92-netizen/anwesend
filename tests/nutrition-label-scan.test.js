'use strict';
// Server-Aktion 'label-scan' (api/member/nutrition.js): Foto der Nährwerttabelle -> Felder
// fürs eigene Lebensmittel. Wichtig: speichert NICHTS, kostet Kontingent nur bei Erfolg,
// prüft Bildgröße und meldet unsichere Erkennung als Hinweis.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

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

  let memberBody = {}; let rateOk = true;
  inject('lib/members.js', {
    bearer: () => 't', getSession: async () => ({ id: 'm1' }),
    readBody: async () => memberBody, rateLimit: async () => rateOk,
  });
  let aiCalls = 0; let aiResult = null;
  inject('lib/ai.js', { hasAI: true, nutritionLabelScan: async () => { aiCalls++; return aiResult; } });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/inbox.js', {}); inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', { getEntitlement: async () => null, isPremium: () => false, publicTier: () => ({ premium: false, tier: 'basic', trialing: false, until: null }) });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', { exportState: async () => ({}) });
  let quotaLeft = true; let charged = 0;
  inject('lib/nutriquota.js', {
    monthOf: (d) => String(d).slice(0, 7), getUsed: async () => 0,
    canUse: async () => quotaLeft, incr: async () => { charged++; return charged; },
    publicQuota: () => ({ unlimited: false, limit: 5, used: charged, remaining: Math.max(0, 5 - charged) }),
  });
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
  const IMG = 'x'.repeat(500);
  const GOOD = { ok: true, name: 'Magerquark', brand: 'MILSANI', basis: '100g',
    per100: { kcal: 67, protein: 12, carbs: 4, fat: 0.3, fiber: null, sugar: 4, satFat: 0.2, salt: 0.05 }, confidence: 0.9, warn: '' };

  await call({ action: 'save-profile', consent: true, profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });

  // ── Erfolgsfall ──
  aiResult = GOOD;
  let r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('1. Werte werden zurückgegeben', r.ok === true && r.per100.kcal === 67 && r.name === 'Magerquark' && r.basis === '100g');
  ok('2. Kontingent nur bei Erfolg belastet', aiCalls === 1 && charged === 1 && r.quota && r.quota.used === 1);
  ok('3. Kein Hinweis bei sicherer Erkennung', r.hint === '');
  // Nichts gespeichert: der Tag bleibt leer.
  const st = await call({ action: 'log-manual', name: 'Platzhalter', kcal: 1, meal: 'snack' });
  ok('4. label-scan hat NICHTS ins Tagebuch geschrieben', st.today.entries.length === 1 && st.today.entries[0].name === 'Platzhalter');

  // ── Unsichere Erkennung / Unstimmigkeit -> Hinweis zum Gegenprüfen ──
  aiResult = Object.assign({}, GOOD, { confidence: 0.3 });
  r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('5. Niedrige Confidence erzeugt Prüf-Hinweis', r.ok === true && /prüf/i.test(r.hint));
  aiResult = Object.assign({}, GOOD, { warn: 'mismatch' });
  r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('6. Unstimmige Werte erzeugen Warnhinweis', /gegenprüfen/i.test(r.hint));

  // ── Fehlerfälle ──
  r = await call({ action: 'label-scan', base64: 'kurz', mediaType: 'image/jpeg' });
  ok('7. Zu kleines Bild -> bad_photo, kein KI-Aufruf', r.ok === false && r.error === 'bad_photo' && aiCalls === 3);
  r = await call({ action: 'label-scan', base64: 'y'.repeat(8000001), mediaType: 'image/jpeg' });
  ok('8. Zu großes Bild -> bad_photo', r.ok === false && r.error === 'bad_photo');
  aiResult = { ok: false, error: 'no_label' };
  r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('9. Keine Tabelle erkennbar -> klare Meldung, keine Belastung', r.ok === false && r.error === 'no_label' && /Nährwerttabelle/.test(r.message) && charged === 3);
  rateOk = false;
  r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('10. Rate-Limit greift', r.ok === false && r.error === 'rate_limited');
  rateOk = true;
  quotaLeft = false;
  r = await call({ action: 'label-scan', base64: IMG, mediaType: 'image/jpeg' });
  ok('11. Ohne Kontingent -> premium_required (kein KI-Aufruf)', r.ok === false && r.error === 'premium_required' && aiCalls === 4);

  console.log(pass ? 'NUTRITION-LABEL-SCAN PASS' : 'NUTRITION-LABEL-SCAN FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
