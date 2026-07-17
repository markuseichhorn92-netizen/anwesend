'use strict';
// Premium übers Magicline-Zusatzmodul (SEPA, Teil der Mitgliedschaft) – Alternative
// zum Stripe-Abo. Prüft die Kopplung Modul-Status <-> Entitlement (lib/mlPremium +
// lib/mlModules gegen ein In-Memory-Store), ohne Magicline echt aufzurufen:
//   1. Buchung schaltet Premium frei (grantFromBooking, source:'magicline')
//   2. reconcile mit gekündigtem Modul setzt until = Modul-Ende (läuft bis dahin weiter)
//   3. Modul nicht (mehr) gebucht -> magicline-Datensatz wird abgeräumt (canceled)
//   4. Frisch gebuchtes Modul wird NICHT sofort wieder abgeräumt (Schonfrist)
//   5. Ein aktives Stripe-Abo gewinnt IMMER und wird nie überschrieben
//   6. cancelModule schickt Datum + Kündigungsgrund an ordinary-cancelation
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

  // ── Fake Magicline (lib/members.ml) mit steuerbarer Liste gebuchter Module ──
  let bookedList = [];
  const calls = [];
  const ml = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (method === 'GET' && /additional-module-contracts$/.test(p)) return { status: 200, json: bookedList };
    if (method === 'GET' && /additional-modules\/purchasable$/.test(p)) return { status: 200, json: [] };
    if (method === 'POST' && /ordinary-cancelation$/.test(p)) return { status: 200, json: { endDate: '2026-09-30' } };
    if (method === 'POST' && /purchase$/.test(p)) return { status: 200, json: {} };
    return { status: 404, json: null };
  };
  inject('lib/members.js', { ml, getContract: async (id) => ({ contractId: 'C' + id }) });

  // ── Module unter Test frisch laden (Env vor mlModules setzen!) ──
  process.env.ML_PREMIUM_MODULE_ID = '42';
  const Ent = fresh('lib/entitlements.js');
  const MlMod = fresh('lib/mlModules.js');
  const MlPremium = fresh('lib/mlPremium.js');

  ok('0. configured() = true (Modul-ID gesetzt + Store da)', MlPremium.configured() === true && MlMod.premiumConfigured() === true);
  ok('0b. isPremiumModule matcht nur die konfigurierte ID', MlMod.isPremiumModule('42') === true && MlMod.isPremiumModule('43') === false);

  // 1. Buchung schaltet Premium frei (Sofort-Freischaltung nach In-App-Buchung)
  const g = await MlPremium.grantFromBooking('A', 'MC1');
  let tA = Ent.publicTier(await Ent.getEntitlement('A'));
  ok('1. grantFromBooking -> Premium an, source magicline, viaModule',
    g === true && tA.premium === true && tA.source === 'magicline' && tA.viaModule === true && tA.moduleContractId === 'MC1');

  // 2. reconcile mit gekündigtem Modul -> until = Modul-Ende, cancelAtPeriodEnd
  bookedList = [{ id: 'MC2', additionalModule: { id: 42 }, endDate: '2026-08-31', nextCancellationDate: '2026-08-31' }];
  let tB = await MlPremium.reconcile('B');
  const wantUntil = Date.parse('2026-08-31T23:59:59');
  ok('2. gekündigtes Modul: Premium läuft bis Modul-Ende (until gesetzt, cancelAtPeriodEnd)',
    tB && tB.premium === true && tB.viaModule === true && tB.cancelAtPeriodEnd === true
    && tB.until === wantUntil);

  // 3. Modul nicht mehr gebucht + alter Datensatz -> wird abgeräumt (canceled)
  await Ent.setEntitlement('C', { tier: 'premium', status: 'active', source: 'magicline', moduleContractId: 'MCx', updatedAt: Date.now() - 3600 * 1000 });
  bookedList = [];
  let tC = await MlPremium.reconcile('C');
  const rawC = await Ent.getEntitlement('C');
  ok('3. Modul weg (alter Datensatz): Premium aus, Status canceled',
    tC && tC.premium === false && rawC.status === 'canceled' && rawC.cancelAtPeriodEnd === true);

  // 4. Frisch gebuchtes Modul (updatedAt jetzt) NICHT sofort abräumen (Schonfrist)
  await Ent.setEntitlement('E', { tier: 'premium', status: 'active', source: 'magicline', moduleContractId: 'MCy', updatedAt: Date.now() });
  bookedList = [];   // Listen-Endpunkt läuft nach -> noch nicht sichtbar
  let tE = await MlPremium.reconcile('E');
  const rawE = await Ent.getEntitlement('E');
  ok('4. frische Buchung überlebt trotz leerem Listen-Endpunkt (Schonfrist)',
    tE && tE.premium === true && rawE.status === 'active');

  // 5. Aktives Stripe-Abo gewinnt und wird nie überschrieben
  await Ent.setEntitlement('D', { tier: 'premium', status: 'active', stripeSubId: 'sub_1', updatedAt: Date.now() });
  bookedList = [];   // Modul nicht gebucht – darf Stripe NICHT anfassen
  let tD = await MlPremium.reconcile('D');
  const rawD = await Ent.getEntitlement('D');
  const gD = await MlPremium.grantFromBooking('D', 'MCz');
  const rawD2 = await Ent.getEntitlement('D');
  ok('5. Stripe-Abo unangetastet (reconcile + grantFromBooking greifen nicht)',
    tD && tD.premium === true && tD.source === 'stripe'
    && rawD.stripeSubId === 'sub_1' && rawD.status === 'active'
    && gD === false && rawD2.stripeSubId === 'sub_1' && rawD2.status === 'active');

  // 6. cancelModule schickt Datum + Grund an den ordinary-cancelation-Endpunkt
  const cr = await MlMod.cancelModule('C1', 'MC1', { cancelationDate: '2026-08-31', cancelationReasonId: 7 });
  const last = calls[calls.length - 1];
  ok('6. cancelModule: Body trägt Datum + Grund, Endpunkt ordinary-cancelation, endDate zurück',
    cr.ok === true && cr.endDate === '2026-09-30'
    && /ordinary-cancelation$/.test(last.path) && last.body.cancelationDate === '2026-08-31' && last.body.cancelationReasonId === 7);

  // 7. findBookedPremium erkennt genau das Premium-Modul (moduleId == ML_PREMIUM_MODULE_ID)
  bookedList = [{ id: 'MCa', additionalModule: { id: 99 } }, { id: 'MCb', additionalModule: { id: 42 }, nextCancellationDate: '2026-10-31' }];
  const fb = await MlMod.findBookedPremium('C1');
  ok('7. findBookedPremium liefert nur das Premium-Modul (Modul-Vertrags-ID + nextCancellationDate)',
    !!fb && fb.id === 'MCb' && fb.moduleId === 42 && fb.nextCancellationDate === '2026-10-31');

  console.log(pass ? 'ML-PREMIUM PASS' : 'ML-PREMIUM FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
