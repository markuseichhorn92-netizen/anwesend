'use strict';

/**
 * Premium-Entitlements fürs Ernährungsmodul (Freemium: Basis gratis, KI kostet).
 * -------------------------------------------------------------------------
 * Ein Datensatz pro Mitglied in Upstash, gesetzt/entzogen ausschließlich vom
 * Stripe-Webhook (api/webhooks/stripe.js). Gelesen von api/member/nutrition.js
 * (Gate + buildState) und api/member/nutrition-billing.js.
 *
 * Key:   nutri:prem:<memberId>   (memberId = Magicline-Customer-id = sess.id)
 * Wert:  { tier:'premium', status, until, since, source?, stripeCustomerId?,
 *          stripeSubId?, moduleContractId?, updatedAt }
 *        status ∈ trialing | active | past_due | canceled | incomplete
 *        until  = Ende der aktuellen Periode (ms) – nach Ablauf kein Premium mehr.
 *        source = 'stripe' (Default bei stripeSubId) | 'magicline' (Zusatzmodul,
 *                 SEPA über den Mitgliedsvertrag, siehe lib/mlPremium) | 'team*'
 *                 (vom Studio kostenlos freigeschaltet).
 *
 * WICHTIG: Dieser Datensatz ist ABRECHNUNGSSTATUS, keine „Ernährungsdaten":
 * er wird bei delete-all NICHT gelöscht (das würde ein laufendes Abo kappen).
 * Kündigung läuft je nach Quelle über das Stripe-Portal ODER über die
 * Magicline-Modul-Kündigung (siehe api/member/modules.js).
 */

const { redisPipeline, hasStore } = require('./store');

const PREMKEY = (id) => 'nutri:prem:' + String(id);

async function getEntitlement(id) {
  if (!hasStore || !id) return null;
  try { const [v] = await redisPipeline([['GET', PREMKEY(id)]]); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}

async function setEntitlement(id, ent) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['SET', PREMKEY(id), JSON.stringify(ent)]]); return true; }
  catch (e) { return false; }
}

// Premium aktiv? tier=premium UND Status aktiv/Trial UND Periode nicht abgelaufen.
function isPremium(ent) {
  if (!ent || ent.tier !== 'premium') return false;
  if (ent.status !== 'active' && ent.status !== 'trialing') return false;
  if (ent.until && Number(ent.until) > 0 && Number(ent.until) < Date.now()) return false;
  return true;
}

// Client-sicherer Auszug (keine internen Stripe-IDs an den Browser).
function publicTier(ent) {
  const premium = isPremium(ent);
  // Quelle bestimmen: Stripe (Default bei stripeSubId), Magicline-Modul, oder Team-Comp.
  const rawSource = (ent && ent.source) || null;
  let source = rawSource;
  if (!source && ent && ent.stripeSubId) source = 'stripe';
  // comp = vom Studio (Team) kostenlos freigeschaltet (kein Abo) -> keine Zahl-/Kündigen-UI.
  const comp = !!(rawSource && String(rawSource).indexOf('team') === 0);
  const viaModule = source === 'magicline';   // Premium läuft über ein Magicline-Zusatzmodul (SEPA)
  return {
    premium: premium,
    tier: premium ? 'premium' : 'free',
    status: (ent && ent.status) || 'free',
    trialing: !!(ent && ent.status === 'trialing') && premium,
    trialEnd: (ent && ent.trialEnd) ? String(ent.trialEnd) : null,
    until: (ent && ent.until) ? Number(ent.until) : null,
    cancelAtPeriodEnd: !!(ent && ent.cancelAtPeriodEnd),
    comp: comp,
    permanent: comp && !(ent && ent.until),
    source: source || null,
    viaModule: viaModule,
    moduleContractId: viaModule ? ((ent && ent.moduleContractId) || null) : null,
  };
}

module.exports = { PREMKEY, getEntitlement, setEntitlement, isPremium, publicTier };
