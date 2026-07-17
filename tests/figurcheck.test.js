'use strict';
// Figur-Check: lib/figurcheck.js (Validierung/Verlauf/Vergleich) + api/member/figurcheck.js.
//   Teil A — lib: buildEntry klemmt & verlangt ≥1 Messwert; appendEntry ersetzt Tag & sortiert;
//            summary liefert Start/Aktuell/Delta + Serie.
//   Teil B — endpoint: GET-Snapshot, save (persistiert), bad_input, delete,
//            review-Gating (no_data < 2, premium_required ohne Premium+Kontingent, ok mit Premium).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fresh = (rel) => { const p = path.resolve(ROOT, rel); delete require.cache[p]; return require(p); };
function res0() { return { statusCode: 0, headers: {}, setHeader() {}, body: null, end(s) { this.body = s; } }; }
function reqFor(method, body) { return { method: method, headers: { authorization: 'Bearer t' }, on(ev, cb) { if (ev === 'data' && body != null) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb(); } }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // Fake-KV (nur GET/SET/DEL nötig; rateLimit ist im members-Mock)
  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1] || '');
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(k); return 1; }
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  // ── Teil A: lib direkt ──
  const F = fresh('lib/figurcheck.js');
  const today = '2026-07-17';

  ok('A1. buildEntry ohne Messwert -> null', F.buildEntry({ note: 'nix' }, today) === null);
  const e1 = F.buildEntry({ weight: 999, waist: 80, foo: 1 }, today);
  ok('A2. Gewicht wird geklemmt (999 -> 250)', e1 && e1.values.weight === 250);
  ok('A3. nur bekannte Messgrößen übernommen', e1 && e1.values.waist === 80 && e1.values.foo === undefined);
  ok('A4. Datum gesetzt', e1 && e1.date === today);

  let rec = F.appendEntry(null, F.buildEntry({ weight: 90, waist: 95 }, '2026-06-01'));
  rec = F.appendEntry(rec, F.buildEntry({ weight: 88, waist: 93 }, '2026-06-15'));
  rec = F.appendEntry(rec, F.buildEntry({ weight: 87 }, '2026-06-15')); // gleicher Tag ersetzt
  rec = F.appendEntry(rec, F.buildEntry({ weight: 85, waist: 90 }, '2026-06-08')); // aus der Reihe
  ok('A5. gleicher Tag ersetzt (3 Tage, nicht 4)', rec.list.length === 3);
  ok('A6. chronologisch sortiert', rec.list[0].date === '2026-06-01' && rec.list[2].date === '2026-06-15');
  ok('A7. Ersatz-Eintrag hat neuen Wert (87, waist entfernt)', rec.list[2].values.weight === 87 && rec.list[2].values.waist === undefined);

  const sum = F.summary(rec);
  const wm = sum.metrics.find((m) => m.key === 'weight');
  ok('A8. summary Gewicht Start 90 -> aktuell 87', wm && wm.start === 90 && wm.latest === 87);
  ok('A9. summary Delta -3', wm && wm.delta === -3);
  ok('A10. summary Serie 3 Punkte', wm && wm.series.length === 3);
  ok('A11. spanDays 44 (01.06->15.07? nein 01->15.06=14)', sum.spanDays === 14 && sum.count === 3);
  const waistM = sum.metrics.find((m) => m.key === 'waist');
  ok('A12. Taille-Serie nur mit Werten (2 Punkte)', waistM && waistM.series.length === 2);

  // ── Teil B: endpoint ──
  kv.clear();
  inject('lib/members.js', { getSession: async () => ({ id: 'M1', firstName: 'Max' }), bearer: () => 't', rateLimit: async () => true, readBody: (req) => new Promise((rs) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { rs(JSON.parse(b || '{}')); } catch (e) { rs({}); } }); }) });
  let premium = false;
  inject('lib/entitlements.js', { getEntitlement: async () => ({}), isPremium: () => premium, publicTier: () => ({ premium: premium, tier: premium ? 'premium' : 'free', trialing: false, until: null }) });
  let quotaOk = true; let incrs = 0;
  inject('lib/nutriquota.js', { monthOf: () => '2026-07', getUsed: async () => 0, canUse: async () => quotaOk, incr: async () => (++incrs), publicQuota: () => ({ remaining: 4, limit: 5 }) });
  let reviewCalls = 0;
  inject('lib/ai.js', { hasAI: true, figurReview: async () => { reviewCalls++; return { ok: true, summary: 'gut', insights: [{ title: 'x', text: 'y' }], tip: 'weiter so' }; } });
  const H = fresh('api/member/figurcheck.js');

  // GET-Snapshot (leer)
  let r = res0(); await H(reqFor('GET'), r); let j = JSON.parse(r.body);
  ok('B1. GET available + Metrik-Defs', j.ok === true && j.available === true && Array.isArray(j.metrics) && j.metrics.some((m) => m.key === 'waist'));
  ok('B2. GET leerer Verlauf', Array.isArray(j.history) && j.history.length === 0 && j.summary.count === 0);

  // save
  r = res0(); await H(reqFor('POST', { action: 'save', weight: 90, waist: 95, note: 'Start' }), r); j = JSON.parse(r.body);
  ok('B3. save persistiert (count 1, Gewicht 90)', j.ok === true && j.saved === true && j.summary.count === 1 && j.summary.metrics.find((m) => m.key === 'weight').latest === 90);

  // save bad_input
  r = res0(); await H(reqFor('POST', { action: 'save', note: 'ohne werte' }), r); j = JSON.parse(r.body);
  ok('B4. save ohne Messwert -> bad_input', j.ok === false && j.error === 'bad_input');

  // zweiter save (anderer Tag simuliert via direktes KV? -> gleicher Tag ersetzt; nutze anderes Feld)
  r = res0(); await H(reqFor('POST', { action: 'save', weight: 88 }), r); j = JSON.parse(r.body);
  ok('B5. zweiter save gleicher Tag ersetzt (count bleibt 1, Wert 88)', j.summary.count === 1 && j.summary.metrics.find((m) => m.key === 'weight').latest === 88);

  // review mit nur 1 Messung -> no_data
  r = res0(); await H(reqFor('POST', { action: 'review' }), r); j = JSON.parse(r.body);
  ok('B6. review < 2 Messungen -> no_data', j.ok === false && j.error === 'no_data');

  // zweite echte Messung direkt in KV legen, damit count=2
  const raw = JSON.parse(kv.get('nutri:figur:M1'));
  raw.list.push({ at: 1, date: '2026-06-01', values: { weight: 92 }, note: '' });
  kv.set('nutri:figur:M1', JSON.stringify(raw));

  // review ohne Premium + Kontingent 0 -> premium_required
  premium = false; quotaOk = false;
  r = res0(); await H(reqFor('POST', { action: 'review' }), r); j = JSON.parse(r.body);
  ok('B7. review ohne Premium + Kontingent 0 -> premium_required', j.ok === false && j.error === 'premium_required');

  // review mit Premium -> ok + review, kein Kontingent-Verbrauch
  premium = true; incrs = 0;
  r = res0(); await H(reqFor('POST', { action: 'review' }), r); j = JSON.parse(r.body);
  ok('B8. review mit Premium -> ok + FINN-Auswertung', j.ok === true && j.review && j.review.summary === 'gut' && reviewCalls > 0);
  ok('B9. Premium verbraucht kein Gratis-Kontingent', incrs === 0);

  // delete
  r = res0(); await H(reqFor('POST', { action: 'delete', date: '2026-06-01' }), r); j = JSON.parse(r.body);
  ok('B10. delete entfernt Eintrag (count 1)', j.ok === true && j.deleted === true && j.summary.count === 1);

  console.log(pass ? 'FIGURCHECK PASS' : 'FIGURCHECK FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
