'use strict';
// publicTier(): adaptive Upgrade-Copy-Felder everPremium / trialEligible.
//   1. kein Entitlement (nie getestet) -> trialEligible:true, everPremium:false
//   2. laufender Trial                  -> premium:true, trialing:true, everPremium:true, trialEligible:false
//   3. abgelaufen/gekündigt (lapsed)    -> premium:false, everPremium:true, trialEligible:false
const path = require('path');
const Ent = require(path.resolve(__dirname, '..', 'lib', 'entitlements.js'));

function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };
  const future = Date.now() + 7 * 864e5;
  const past = Date.now() - 864e5;

  const a = Ent.publicTier(null);
  ok('1. kein Entitlement -> nicht premium', a.premium === false);
  ok('1b. -> everPremium:false, trialEligible:true', a.everPremium === false && a.trialEligible === true);

  const b = Ent.publicTier({ tier: 'premium', status: 'trialing', until: future });
  ok('2. Trial -> premium:true, trialing:true', b.premium === true && b.trialing === true);
  ok('2b. -> everPremium:true, trialEligible:false', b.everPremium === true && b.trialEligible === false);

  const c = Ent.publicTier({ tier: 'premium', status: 'canceled', until: past });
  ok('3. abgelaufen -> premium:false', c.premium === false);
  ok('3b. -> everPremium:true, trialEligible:false', c.everPremium === true && c.trialEligible === false);

  // aktiv bezahlt (nicht Trial) zählt auch als everPremium
  const d = Ent.publicTier({ tier: 'premium', status: 'active', until: future });
  ok('4. aktiv -> premium:true, trialing:false, everPremium:true', d.premium === true && d.trialing === false && d.everPremium === true);

  console.log(pass ? 'ENTITLEMENTS PASS' : 'ENTITLEMENTS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
