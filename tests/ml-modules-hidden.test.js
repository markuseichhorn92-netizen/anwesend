'use strict';
// Zusatzmodule ausblenden: Module, die nur im Studio verkauft werden, dürfen in der
// App-Liste der buchbaren Zusatzmodule NICHT auftauchen. Ausblendung per festem
// Namensmuster („… Ernährungsplanung inkl. Stoffwechsel-Ruheanalyse") und per
// Env-Variable ML_HIDDEN_MODULE_IDS (kommagetrennt). Normale Module bleiben sichtbar.
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

  // Fake Magicline: /purchasable liefert 4 Module – 1 normales, das Studio-Modul
  // (Namensmuster), 1 per Env-ID verstecktes und 1 weiteres normales.
  const purchasable = [
    { id: 11, name: 'Getränke-Flat', paymentFrequencies: [{ id: 1, price: 9.9, currency: 'EUR' }] },
    { id: 12, name: '3 Monate Ernährungsplanung inkl. Stoffwechsel-Ruheanalyse', paymentFrequencies: [{ id: 2, price: 199, currency: 'EUR' }] },
    { id: 13, name: 'Solarium-Paket', paymentFrequencies: [{ id: 3, price: 14.9, currency: 'EUR' }] },
    { id: 14, name: 'Handtuch-Service', paymentFrequencies: [{ id: 4, price: 4.9, currency: 'EUR' }] },
  ];
  const ml = async (method, p) => {
    if (method === 'GET' && /additional-modules\/purchasable$/.test(p)) return { status: 200, json: purchasable };
    return { status: 404, json: null };
  };
  inject('lib/members.js', { ml, getContract: async (id) => ({ contractId: 'C' + id }) });

  process.env.ML_HIDDEN_MODULE_IDS = '13';
  const Mod = fresh('lib/mlModules.js');

  // 1) isHiddenModule: Namensmuster + Varianten + Env-ID.
  ok('1. Studio-Modul per Name versteckt', Mod.isHiddenModule(12, '3 Monate Ernährungsplanung inkl. Stoffwechsel-Ruheanalyse') === true);
  ok('1b. Schreibvariante (Stoffwechselruheanalyse) versteckt', Mod.isHiddenModule(99, 'Ernährungsplanung mit Stoffwechselruheanalyse') === true);
  ok('1c. Env-ID versteckt', Mod.isHiddenModule(13, 'Solarium-Paket') === true);
  ok('1d. normales Modul NICHT versteckt', Mod.isHiddenModule(11, 'Getränke-Flat') === false && Mod.isHiddenModule(14, 'Handtuch-Service') === false);
  ok('1e. Ernährungsberatung allein NICHT versteckt', Mod.isHiddenModule(50, 'Ernährungsberatung') === false);

  // 2) listModules filtert die versteckten Module aus der buchbaren Liste.
  const r = await Mod.listModules('C1');
  ok('2. Liste verfügbar', r && r.available === true);
  const ids = (r.bookable || []).map((x) => x.id);
  ok('2b. nur die sichtbaren Module übrig (11, 14)', ids.length === 2 && ids.indexOf(11) >= 0 && ids.indexOf(14) >= 0);
  ok('2c. Studio-Modul (12) ausgeblendet', ids.indexOf(12) < 0);
  ok('2d. Env-ID-Modul (13) ausgeblendet', ids.indexOf(13) < 0);

  delete process.env.ML_HIDDEN_MODULE_IDS;
  console.log(pass ? 'ML-MODULES-HIDDEN PASS' : 'ML-MODULES-HIDDEN FAIL');
  process.exit(pass ? 0 : 1);
}

run().catch((e) => { console.error('ERR', e); process.exit(1); });
