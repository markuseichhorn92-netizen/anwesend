'use strict';
// „Gemeinsam kochen": ein Topf, zwei Personen, prozentualer Anteil je eigenem
// Tagebuch. Testet lib/cookpot.js über die Endpunkt-Aktionen (pot-create/get/join/
// set-pct/log) end-to-end mit In-Memory-KV (inkl. SET NX für die Code-Reservierung).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── In-Memory-KV als lib/store (unterstützt SET NX + EX-Ignorieren) ──
  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    const k = String(c[1]);
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') {
      const opts = c.slice(3).map((x) => String(x).toUpperCase());
      if (opts.indexOf('NX') >= 0 && kv.has(k)) return null;
      kv.set(k, typeof c[2] === 'string' ? c[2] : String(c[2]));
      return 'OK';
    }
    if (op === 'DEL') { const had = kv.has(k); kv.delete(k); return had ? 1 : 0; }
    if (op === 'MGET') return c.slice(1).map((x) => (kv.has(String(x)) ? kv.get(String(x)) : null));
    if (op === 'INCR') { const n = (parseInt(kv.get(k), 10) || 0) + 1; kv.set(k, String(n)); return n; }
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  // ── Zwei Mitglieder: currentUser steuert die Session ──
  let currentUser = 'cassandra';
  const NAMES = { cassandra: { firstName: 'Cassandra', lastName: 'Meyer', dateOfBirth: '1994-05-02' }, florian: { firstName: 'Florian', lastName: 'Klein', dateOfBirth: '1992-09-14' } };
  let memberBody = {};
  inject('lib/members.js', {
    bearer: () => 't',
    getSession: async () => ({ id: currentUser }),
    getMember: async (id) => NAMES[id] || null,
    readBody: async () => memberBody,
    rateLimit: async () => true,
  });
  inject('lib/ai.js', { hasAI: true });
  inject('lib/recipes.js', { searchLibrary: async () => [], getLibrary: async () => [], seedOnce: async () => {} });
  inject('lib/inbox.js', {});
  inject('lib/studioReply.js', {});
  inject('lib/entitlements.js', { getEntitlement: async () => null, isPremium: () => false, publicTier: () => ({ premium: false, tier: 'basic' }) });
  inject('lib/mlPremium.js', { reconcile: async () => {}, configured: () => false });
  inject('lib/coaching.js', { exportState: async () => ({}) });
  inject('lib/nutriquota.js', { monthOf: (d) => String(d).slice(0, 7), getUsed: async () => 0, canUse: async () => true, incr: async () => 1, publicQuota: () => ({ unlimited: false, limit: 5, used: 0, remaining: 5 }) });
  inject('lib/welcomeGift.js', {});
  inject('lib/social.js', { socialExport: async () => null });
  inject('lib/figurcheck.js', { getRec: async () => null, exportState: async () => ({}) });
  inject('lib/privacy.js', { recordConsent: async () => {} });
  inject('lib/handled.js', { record: async () => {} });

  const handler = require(path.resolve(ROOT, 'api', 'member', 'nutrition.js'));
  const call = async (user, body) => {
    currentUser = user; memberBody = body || {};
    let out = '';
    const res = { statusCode: 200, setHeader: () => {}, end: (s) => { out = s; } };
    await handler({ method: 'POST', url: '/api/member/nutrition', headers: { host: 'mitglieder.fit-inn-trier.de' } }, res);
    return JSON.parse(out);
  };

  // Beide Profile anlegen (Onboarding – Voraussetzung für Topf-Teilnahme).
  const prof = { action: 'save-profile', consent: true, profile: { goal: 'halten', sex: 'w', height: 168, weight: 68, age: 31, activity: 'moderat', diet: 'omnivor' } };
  await call('cassandra', prof);
  await call('florian', prof);

  // ── 1) Cassandra erstellt den Topf aus einer FINN-Schätzung (items summieren) ──
  let r = await call('cassandra', { action: 'pot-create', title: 'Chili con Carne (ganzer Topf)', items: [
    { name: 'Hackfleisch', kcal: 600, p: 60, c: 0, f: 40, grams: 500 },
    { name: 'Kidneybohnen + Reis', kcal: 400, p: 40, c: 100, f: 0, grams: 600 },
  ] });
  ok('1. Topf erstellt, Code + Teilen-Link', r.ok === true && /^[A-HJ-NP-Z2-9]{6}$/.test(r.code) && /\/mitglieder\?kochen=/.test(r.shareUrl), JSON.stringify(r));
  const code = r.code;
  ok('2. Gesamt-Nährwerte summiert (1000 kcal)', r.pot.total.kcal === 1000 && r.pot.total.p === 100 && r.pot.total.c === 100 && r.pot.total.f === 40, JSON.stringify(r.pot.total));
  ok('3. Erstellerin ist erste Teilnehmerin (me), 0 %', r.pot.participants.length === 1 && r.pot.participants[0].me === true && r.pot.participants[0].pct === 0 && r.pot.participants[0].name === 'Cassandra M.');

  // ── 2) Cassandra setzt ihren Anteil auf 60 % ──
  r = await call('cassandra', { action: 'pot-set-pct', code: code, pct: 60 });
  ok('4. Cassandra 60 % -> Anteil 600 kcal', r.ok === true && r.pot.participants[0].pct === 60 && r.pot.participants[0].share.kcal === 600 && r.pot.participants[0].share.p === 60);

  // ── 3) Florian tritt über den Code bei und setzt 40 % ──
  r = await call('florian', { action: 'pot-join', code: code });
  ok('5. Florian beigetreten, sieht 2 Teilnehmer', r.ok === true && r.pot.participants.length === 2);
  r = await call('florian', { action: 'pot-set-pct', code: code, pct: 40 });
  const flo = r.pot.participants.filter((p) => p.me)[0];
  ok('6. Florian 40 % -> Anteil 400 kcal, Summe 100 %', flo.pct === 40 && flo.share.kcal === 400 && r.pot.sumPct === 100);

  // ── 4) Jede:r übernimmt seinen Anteil ins EIGENE Tagebuch ──
  r = await call('cassandra', { action: 'pot-log', code: code });
  let entry = r.today.entries[r.today.entries.length - 1];
  ok('7. Cassandra: Anteil im eigenen Tagebuch (600 kcal)', entry && entry.kcal === 600 && /Anteil 60 %/.test(entry.portion) && /Chili con Carne/.test(entry.name), JSON.stringify(entry));
  ok('8. pot-log meldet added + frischen Topf', Array.isArray(r.added) && r.added[0].kcal === 600 && r.pot && r.pot.participants.filter((p) => p.me)[0].logged === true);

  r = await call('florian', { action: 'pot-log', code: code });
  entry = r.today.entries[r.today.entries.length - 1];
  ok('9. Florian: eigener Anteil (400 kcal), Cassandras Tagebuch unberührt', entry && entry.kcal === 400 && r.today.entries.length === 1, JSON.stringify(r.today.entries.map((e) => e.kcal)));

  // ── 5) pot-get: client-sichere Sicht, KEINE Mitglieds-IDs ──
  r = await call('florian', { action: 'pot-get', code: code });
  ok('10. pot-get liefert Topf ohne IDs', r.ok === true && JSON.stringify(r.pot).indexOf('cassandra') < 0 && JSON.stringify(r.pot).indexOf('florian') < 0);
  ok('11. me-Flag korrekt für Abrufer', r.pot.participants.filter((p) => p.me).length === 1 && r.pot.participants.filter((p) => p.me)[0].name === 'Florian K.');

  // ── 6) Unbekannter Code -> not_found ──
  r = await call('cassandra', { action: 'pot-get', code: 'ZZZZZZ' });
  ok('12. unbekannter Code -> not_found', r.ok === false && r.error === 'not_found');

  // ── 7) manueller Topf (ohne items, direkte Gesamtwerte) ──
  r = await call('cassandra', { action: 'pot-create', title: 'Suppe', total: { kcal: 800, p: 40, c: 90, f: 20 } });
  ok('13. manueller Topf aus Gesamtwerten', r.ok === true && r.pot.total.kcal === 800);

  // ── 8) leerer Topf abgelehnt ──
  r = await call('cassandra', { action: 'pot-create', title: 'Nichts', total: { kcal: 0, p: 0, c: 0, f: 0 } });
  ok('14. Topf ohne Nährwerte abgelehnt', r.ok === false && r.error === 'empty');

  // ── 9) Ersteller verlässt -> Topf gelöscht ──
  r = await call('cassandra', { action: 'pot-leave', code: code });
  ok('15. Ersteller verlässt -> Topf gelöscht', r.ok === true && r.deleted === true);
  r = await call('florian', { action: 'pot-get', code: code });
  ok('16. danach nicht mehr auffindbar', r.ok === false && r.error === 'not_found');

  console.log(pass ? 'COOKPOT PASS' : 'COOKPOT FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
