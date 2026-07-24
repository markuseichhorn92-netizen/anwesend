'use strict';
// Individuelle Zielwerte (z. B. aus einer Stoffwechselanalyse): Das Team setzt sie
// über /api/team/nutrition (action targets-set), sie übersteuern die Formel feldweise
// (nicht gesetzte KH werden nachgezogen), das Mitglied sieht sie in /api/member/nutrition
// (targets.custom + note), sie überleben save-profile auf beiden Seiten, lassen sich
// aufs Formel-Ergebnis zurücksetzen und gelten NIE für unter 18-Jährige.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── In-Memory-KV als lib/store (Team und Mitglied teilen sich nutri:p:<id>) ──
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

  // ── Mocks: nur was die beiden Handler auf den getesteten Pfaden brauchen ──
  let memberBody = {};
  inject('lib/members.js', {
    bearer: () => 't',
    getSession: async () => ({ id: 'm1' }),
    readBody: async (req) => (req && req.__body) || memberBody,
    rateLimit: async () => true,
  });
  inject('lib/teamAuth.js', { requireTeam: async () => ({ user: 'trainer@fitinn', name: 'Trainer' }) });
  inject('lib/capabilities.js', { requireCap: () => true });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/ai.js', {});
  inject('lib/inbox.js', {});
  inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', {
    getEntitlement: async () => null,
    isPremium: () => false,
    publicTier: () => ({ premium: false, tier: 'basic', trialing: false, until: null }),
  });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', {});
  inject('lib/nutriquota.js', {
    monthOf: (d) => String(d).slice(0, 7),
    getUsed: async () => 0,
    publicQuota: () => ({ unlimited: false, limit: 5, used: 0, remaining: 5 }),
  });
  inject('lib/welcomeGift.js', {});
  inject('lib/social.js', {});
  inject('lib/figurcheck.js', {});
  inject('lib/privacy.js', { recordConsent: async () => {} });

  const teamHandler = require(path.resolve(ROOT, 'api', 'team', 'nutrition.js'));
  const memberHandler = require(path.resolve(ROOT, 'api', 'member', 'nutrition.js'));

  const teamPost = async (body) => {
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await teamHandler({ method: 'POST', url: '/api/team/nutrition', headers: {}, __body: body }, res);
    return JSON.parse(out);
  };
  const memberCall = async (method, body) => {
    memberBody = body || {};
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await memberHandler({ method, url: '/api/member/nutrition', headers: {} }, res);
    return JSON.parse(out);
  };

  // ── 1) Basis: Team legt Körperdaten an -> Formel-Zielwerte, keine Übersteuerung ──
  let st = await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 70, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('1. save-profile ok, Formelwerte da', st.ok === true && st.targets && st.targets.kcal > 0);
  ok('2. keine Übersteuerung aktiv', !st.targets.custom && st.targetOverride == null);
  const formulaKcal = st.targets.kcal, formulaFat = st.targets.fat;

  // ── 2) Team setzt Stoffwechselanalyse-Werte (nur kcal + Eiweiß; KH werden nachgezogen) ──
  st = await teamPost({ action: 'targets-set', id: 'm1', targets: { kcal: 1750, protein: 110 }, note: 'Nach deiner Stoffwechselanalyse vom 15.07.' });
  ok('3. targets-set ok', st.ok === true);
  ok('4. kcal/Eiweiß übersteuert', st.targets.kcal === 1750 && st.targets.protein === 110);
  ok('5. custom-Flag gesetzt + Override ausgeliefert', st.targets.custom === true && st.targetOverride && st.targetOverride.kcal === 1750);
  ok('6. Fett bleibt Formelwert', st.targets.fat === formulaFat);
  const expCarbs = Math.max(0, Math.round((1750 - 110 * 4 - formulaFat * 9) / 4));
  ok('7. KH aus Rest nachgezogen (kcal - E - F)', st.targets.carbs === expCarbs);
  ok('8. setBy vermerkt', st.targetOverride.setBy === 'trainer@fitinn');

  // ── 3) Mitglied sieht dieselben Werte inkl. Hinweis ──
  let ms = await memberCall('GET');
  ok('9. Mitglied: kcal=1750, custom + Notiz sichtbar', ms.ok === true && ms.targets.kcal === 1750 && ms.targets.custom === true && /Stoffwechselanalyse vom 15\.07\./.test(ms.targets.note || ''));

  // ── 4) Mitglied rechnet Ziel neu -> Übersteuerung bleibt bestehen ──
  ms = await memberCall('POST', { action: 'save-profile', profile: { goal: 'halten', sex: 'w', height: 168, weight: 69, age: 30, activity: 'aktiv', diet: 'omnivor' }, consent: true });
  ok('10. Mitglied-Neuberechnung: Override überlebt', ms.ok === true && ms.targets.kcal === 1750 && ms.targets.custom === true);

  // ── 5) Team ändert Körperdaten -> Übersteuerung bleibt ebenfalls ──
  st = await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'abnehmen', sex: 'w', height: 168, weight: 68, age: 30, activity: 'moderat', diet: 'omnivor' } });
  ok('11. Team-Neuberechnung: Override überlebt', st.targets.kcal === 1750 && st.targetOverride != null);

  // ── 6) Grenzen: absurde Werte werden geklammert ──
  st = await teamPost({ action: 'targets-set', id: 'm1', targets: { kcal: 200, protein: 9999, water: '9' }, note: '' });
  ok('12. kcal-Untergrenze 1000 / Eiweiß-Deckel 300 / Wasser-Deckel 5 l', st.targets.kcal === 1000 && st.targets.protein === 300 && st.targets.water === 5);

  // ── 7) Zurücksetzen: leere Felder entfernen die Übersteuerung komplett ──
  st = await teamPost({ action: 'targets-set', id: 'm1', targets: {}, note: '' });
  ok('13. Reset -> wieder Formelwerte, kein custom', !st.targets.custom && st.targetOverride == null && st.targets.kcal > 1000);
  ms = await memberCall('GET');
  ok('14. Mitglied nach Reset ohne custom', !ms.targets.custom);

  // ── 8) Unter 18: Übersteuerung wird abgelehnt und nie angewendet ──
  await teamPost({ action: 'save-profile', id: 'm1', profile: { goal: 'halten', sex: 'w', height: 168, weight: 60, age: 16, activity: 'moderat', diet: 'omnivor' } });
  st = await teamPost({ action: 'targets-set', id: 'm1', targets: { kcal: 1200 }, note: '' });
  ok('15. unter 18 -> targets-set abgelehnt', st.ok === false && st.error === 'under18');
  ms = await memberCall('GET');
  ok('16. unter 18 -> Mitglied behält Schutz-Richtwerte', !ms.targets.custom);

  console.log(pass ? 'TARGET-OVERRIDE PASS' : 'TARGET-OVERRIDE FAIL');
  if (!pass) process.exit(1);
}

run().catch((e) => { console.error('ERR', e); process.exit(1); });
