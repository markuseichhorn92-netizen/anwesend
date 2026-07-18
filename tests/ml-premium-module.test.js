'use strict';
// Coach Premium über EIN oder MEHRERE Magicline-Zusatzmodule (kommagetrennt):
// Monat / Jahr / Vital-Starter – alle schalten dasselbe Premium frei.
process.env.ML_PREMIUM_MODULE_ID = '101, 102, 103';
const Mod = require('../lib/mlModules');

function run() {
  let pass = true;
  const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  ok('1. premiumConfigured bei mehreren IDs', Mod.premiumConfigured() === true);
  ok('2. isPremiumModule erkennt alle drei (Zahl & String)', Mod.isPremiumModule(101) && Mod.isPremiumModule('102') && Mod.isPremiumModule(103));
  ok('3. Fremd-Modul ist NICHT premium', Mod.isPremiumModule(999) === false && Mod.isPremiumModule(null) === false);
  ok('4. PREMIUM_MODULE_ID = primäre (erste) ID', String(Mod.PREMIUM_MODULE_ID) === '101');
  ok('5. PREMIUM_MODULE_IDS = alle drei (getrimmt)', Array.isArray(Mod.PREMIUM_MODULE_IDS) && Mod.PREMIUM_MODULE_IDS.length === 3 && Mod.PREMIUM_MODULE_IDS[2] === '103');

  console.log(pass ? 'ML-PREMIUM-MODULE PASS' : 'ML-PREMIUM-MODULE FAIL');
  process.exit(pass ? 0 : 1);
}
run();
