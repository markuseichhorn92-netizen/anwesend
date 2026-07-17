'use strict';
// Premium übers Magicline-Zusatzmodul (SEPA, Teil der Mitgliedschaft) – Alternative
// zum Stripe-Abo. Spiegelt die ECHTE Open-API-Realität: es gibt KEINEN Endpunkt, der
// gebuchte Module auflistet – nur Buchen (liefert die Vertrags-ID), Lesen per ID und
// Kündigen per ID. Getestet gegen einen In-Memory-Store, ohne Magicline echt aufzurufen:
//   1. bookModule liefert die additionalModuleContractId aus der Kauf-Antwort
//   2. getModuleContract/Reasons: Normalisierung + 404 -> gone
//   3. cancelModule schickt Datum + Grund an ordinary-cancelation
//   4. grantFromBooking: Premium an, Vertrags-ID gemerkt (Basis fürs Kündigen)
//   5. reconcile mit gekündigtem Modul (per ID verifiziert) -> until = Modul-Ende
//   6. Modul weg (404) + alt -> abräumen; frisch -> Schonfrist schützt
//   7. Stripe gewinnt fürs Gating, merkt aber die Modul-ID (Modul bleibt sichtbar/kündbar)
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const fresh = (rel) => {
  const p = path.resolve(ROOT, rel);
  delete require.cache[p];
  return require(p);
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
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });

  // ── Fake Magicline (lib/members.ml) ──
  let moduleContract = null;   // Antwort von GET-by-id (AdditionalModuleContractExtended) oder null=404
  const calls = [];
  const ml = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (method === 'GET' && /additional-module-contracts\/[^/]+$/.test(p)) {
      return moduleContract ? { status: 200, json: moduleContract } : { status: 404, json: null };
    }
    if (method === 'GET' && /additional-modules\/purchasable$/.test(p)) return { status: 200, json: [] };
    if (method === 'POST' && /additional-modules\/purchase$/.test(p)) return { status: 200, json: { id: 5555 } };
    if (method === 'POST' && /ordinary-cancelation$/.test(p)) return { status: 200, json: {} };
    if (method === 'GET' && /contract-cancelation-reasons$/.test(p)) return { status: 200, json: [{ cancelationReasonId: 7, cancelationReasonName: 'Sonstiges' }] };
    return { status: 404, json: null };
  };
  inject('lib/members.js', { ml, getContract: async (id) => ({ contractId: 'C' + id }) });

  process.env.ML_PREMIUM_MODULE_ID = '42';
  const Ent = fresh('lib/entitlements.js');
  const MlMod = fresh('lib/mlModules.js');
  const MlPremium = fresh('lib/mlPremium.js');

  ok('0. configured + isPremiumModule', MlPremium.configured() === true && MlMod.isPremiumModule('42') === true && MlMod.isPremiumModule('43') === false);

  // 1. bookModule liefert die Vertrags-ID aus der purchase-Antwort (einzige Quelle!)
  const br = await MlMod.bookModule('C1', '42');
  ok('1. bookModule -> moduleContractId aus purchase-Response', br.ok === true && br.moduleContractId === 5555);

  // 2. getModuleContract: Normalisierung (cancelled + endDate + nextCancellationDate) und 404 -> gone
  moduleContract = { name: 'App Premium', price: { amount: 4.99, currency: 'EUR' }, startDate: '2026-01-01', endDate: '2026-08-31', cancelationDate: '2026-08-31', contractCancelationStatus: 'CANCELED', contractCancelationCanBeWithdrawn: true, availableCancelationDates: ['2026-09-30', '2026-12-31'] };
  const mc = await MlMod.getModuleContract('C1', 5555);
  ok('2. getModuleContract: cancelled + endDate + nextCancellationDate', mc.ok === true && mc.contract.cancelled === true && mc.contract.endDate === '2026-08-31' && mc.contract.nextCancellationDate === '2026-09-30');
  moduleContract = null;
  const mc404 = await MlMod.getModuleContract('C1', 9999);
  ok('2b. getModuleContract: 404 -> gone', mc404.ok === false && mc404.gone === true);

  // 3. Kündigungsgründe + cancelModule schickt Datum + Grund
  const reasons = await MlMod.getCancelationReasons();
  ok('3. reasons + pickReasonId (Sonstiges)', reasons.length === 1 && MlMod.pickReasonId(reasons) === 7);
  const cr = await MlMod.cancelModule('C1', 5555, { cancelationDate: '2026-08-31', cancelationReasonId: 7 });
  const last = calls[calls.length - 1];
  ok('3b. cancelModule: ordinary-cancelation mit Datum + Grund', cr.ok === true && /ordinary-cancelation$/.test(last.path) && last.body.cancelationDate === '2026-08-31' && last.body.cancelationReasonId === 7);

  // 4. grantFromBooking -> Premium an, Vertrags-ID gemerkt
  const g = await MlPremium.grantFromBooking('A', 5555);
  const tA = Ent.publicTier(await Ent.getEntitlement('A'));
  const rawA = await Ent.getEntitlement('A');
  ok('4. grantFromBooking -> premium an, source magicline, moduleContractId gemerkt',
    g === true && tA.premium === true && tA.viaModule === true && rawA.moduleContractId === 5555);

  // 5. reconcile: gekündigtes Modul (per ID verifiziert) -> until = Modul-Ende
  moduleContract = { name: 'App Premium', price: { amount: 4.99, currency: 'EUR' }, startDate: '2026-01-01', endDate: '2026-08-31', cancelationDate: '2026-08-31', contractCancelationStatus: 'PENDING_VERIFICATION', contractCancelationCanBeWithdrawn: true, availableCancelationDates: ['2026-08-31'] };
  await MlPremium.invalidate('A');
  const tB = await MlPremium.reconcile('A');
  ok('5. gekündigtes Modul: until = Modul-Ende, cancelAtPeriodEnd',
    tB && tB.premium === true && tB.viaModule === true && tB.cancelAtPeriodEnd === true && tB.until === Date.parse('2026-08-31T23:59:59'));

  // 6. Modul weg (404) + alter Datensatz -> abräumen; frisch -> Schonfrist schützt
  await Ent.setEntitlement('C', { tier: 'premium', status: 'active', source: 'magicline', moduleContractId: 6001, updatedAt: Date.now() - 3600 * 1000 });
  moduleContract = null; await MlPremium.invalidate('C');
  const tC = await MlPremium.reconcile('C');
  const rawC = await Ent.getEntitlement('C');
  ok('6. Modul weg (404) + alt: premium aus, canceled', tC && tC.premium === false && rawC.status === 'canceled');

  await Ent.setEntitlement('E', { tier: 'premium', status: 'active', source: 'magicline', moduleContractId: 6002, updatedAt: Date.now() });
  moduleContract = null; await MlPremium.invalidate('E');
  const tE = await MlPremium.reconcile('E');
  ok('6b. frische Buchung überlebt 404 (Schonfrist)', tE && tE.premium === true);

  // 7. Stripe gewinnt fürs Gating, merkt aber die Modul-ID (Modul bleibt sichtbar/kündbar)
  await Ent.setEntitlement('D', { tier: 'premium', status: 'active', stripeSubId: 'sub_1', updatedAt: Date.now() });
  const gD = await MlPremium.grantFromBooking('D', 7001);
  const rawD = await Ent.getEntitlement('D');
  ok('7. Stripe-Vorrang: grant speichert nur moduleContractId, source bleibt stripe',
    gD === false && rawD.stripeSubId === 'sub_1' && rawD.status === 'active' && rawD.moduleContractId === 7001 && rawD.source === undefined);
  moduleContract = { name: 'App Premium', price: { amount: 4.99 }, startDate: '2026-01-01', contractCancelationCanBeWithdrawn: false, availableCancelationDates: ['2026-09-30'] };
  await MlPremium.invalidate('D');
  const tD = await MlPremium.reconcile('D');
  const rawD2 = await Ent.getEntitlement('D');
  const stD = await MlPremium.moduleStatus('D', { fresh: true });
  ok('7b. reconcile lässt Stripe unangetastet, Modul bleibt über gemerkte ID sichtbar',
    tD && tD.premium === true && tD.source === 'stripe' && rawD2.stripeSubId === 'sub_1' && rawD2.status === 'active'
    && stD && stD.booked === true && stD.moduleContractId === 7001);

  console.log(pass ? 'ML-PREMIUM PASS' : 'ML-PREMIUM FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
