'use strict';

/**
 * Premium fürs Ernährungsmodul über ein Magicline-Zusatzmodul (SEPA, Teil des
 * Mitgliedsvertrags) – Alternative/Ersatz zum Stripe-Abo.
 * -------------------------------------------------------------------------
 * Aktiv nur, wenn ML_PREMIUM_MODULE_ID gesetzt ist. Ohne diese Env passiert hier
 * gar nichts – der Stripe-Weg bleibt unverändert.
 *
 * Idee: Der gebuchte Modul-Status wird (gecacht) in denselben Entitlement-
 * Datensatz (lib/entitlements) gespiegelt, den ALLE Premium-Gates ohnehin lesen –
 * mit source:'magicline'. Damit muss keine einzige Gate-Stelle geändert werden.
 *   - Modul gebucht           -> Premium an (status active, until = Modul-Ende falls gekündigt)
 *   - Modul gekündigt         -> läuft bis Modul-Ende weiter, dann aus (until greift)
 *   - Modul nicht (mehr) da    -> Premium-Datensatz dieser Quelle wird abgeräumt
 *
 * reconcile() deckt auch Buchungen/Kündigungen ab, die das Studio DIREKT in
 * Magicline vornimmt. Ein Stripe-Premium wird NIE überschrieben (Stripe gewinnt).
 * Alles ist 403-/Fehler-sicher und wirft nie.
 */

const { redisPipeline, hasStore } = require('./store');
const M = require('./members');
const MlMod = require('./mlModules');
const Ent = require('./entitlements');

const CACHE_KEY = (id) => 'nutri:mlmod:' + String(id);
const CACHE_TTL = 1800;   // 30 min – begrenzt die Magicline-Aufrufe pro Mitglied
const GRACE_MS = 15 * 60 * 1000;   // Frisch gebuchtes Modul nicht sofort wieder abräumen (Listen-Endpunkt läuft nach)

function configured() { return MlMod.premiumConfigured() && hasStore; }

// Membership-/Vertrags-ID auflösen (die Self-Service-Endpunkte laufen über die
// Vertrags-ID). Ohne Vertrag als Fallback die Kunden-ID.
async function membershipId(customerId) {
  try { var ct = await M.getContract(customerId); if (ct && ct.contractId != null) return ct.contractId; }
  catch (e) {}
  return customerId;
}

// Gebuchtes Premium-Modul aus Magicline (mit Redis-Cache). -> { booked:bool,
// moduleContractId?, endDate?, cancelled?, nextCancellationDate? } | null (inaktiv).
async function moduleStatus(customerId, opts) {
  if (!configured()) return null;
  opts = opts || {};
  if (!opts.fresh) {
    try { const [c] = await redisPipeline([['GET', CACHE_KEY(customerId)]]); if (c) return JSON.parse(c); }
    catch (e) {}
  }
  const mid = await membershipId(customerId);
  let booked = null;
  try { booked = await MlMod.findBookedPremium(mid); } catch (e) { booked = null; }
  const out = booked
    ? { booked: true, moduleContractId: booked.id, endDate: booked.endDate || null, cancelled: !!booked.cancelled, nextCancellationDate: booked.nextCancellationDate || null }
    : { booked: false };
  try { await redisPipeline([['SET', CACHE_KEY(customerId), JSON.stringify(out), 'EX', String(CACHE_TTL)]]); } catch (e) {}
  return out;
}

// Cache verwerfen (nach Buchung/Kündigung in der App), damit der nächste
// reconcile den frischen Stand aus Magicline zieht.
async function invalidate(customerId) {
  if (!hasStore) return;
  try { await redisPipeline([['DEL', CACHE_KEY(customerId)]]); } catch (e) {}
}

// Entitlement-Datensatz mit dem Magicline-Modulstatus abgleichen. Best effort:
// wirft nie, blockiert nichts. Gibt den (ggf. aktualisierten) publicTier zurück.
async function reconcile(customerId) {
  if (!configured()) return null;
  let ent = null;
  try { ent = await Ent.getEntitlement(customerId); } catch (e) {}
  // Ein AKTIVES Stripe-Abo gewinnt immer – Modulstatus nicht drüberschreiben.
  if (ent && ent.source !== 'magicline' && ent.stripeSubId && Ent.isPremium(ent)) return Ent.publicTier(ent);

  let st = null;
  try { st = await moduleStatus(customerId); } catch (e) { st = null; }
  if (!st) return ent ? Ent.publicTier(ent) : null;

  const now = Date.now();
  if (st.booked) {
    const until = (st.cancelled && st.endDate) ? Date.parse(st.endDate + 'T23:59:59') : null;
    const next = {
      tier: 'premium',
      status: 'active',
      source: 'magicline',
      moduleContractId: st.moduleContractId != null ? st.moduleContractId : null,
      until: (until && !isNaN(until)) ? until : null,
      cancelAtPeriodEnd: !!st.cancelled,
      since: (ent && ent.since) || now,
      updatedAt: now,
    };
    // Nur schreiben, wenn sich etwas Relevantes geändert hat (spart Writes).
    const same = ent && ent.source === 'magicline' && ent.status === next.status
      && (ent.until || null) === (next.until || null) && !!ent.cancelAtPeriodEnd === next.cancelAtPeriodEnd
      && String(ent.moduleContractId || '') === String(next.moduleContractId || '');
    if (!same) { try { await Ent.setEntitlement(customerId, next); } catch (e) {} ent = next; }
    return Ent.publicTier(ent);
  }

  // Nicht (mehr) gebucht: einen magicline-Datensatz abräumen (Stripe/Team unberührt).
  // ABER: eine gerade eben freigeschaltete Buchung nicht sofort wieder kappen – der
  // Listen-Endpunkt (/additional-module-contracts) kann direkt nach dem Kauf nachlaufen
  // oder 403 liefern. Kurze Schonfrist ab dem letzten Update schützt den Frisch-Kauf.
  if (ent && ent.source === 'magicline' && ent.status !== 'canceled') {
    const fresh = ent.updatedAt && (now - Number(ent.updatedAt) < GRACE_MS);
    if (fresh) return Ent.publicTier(ent);   // eben gebucht -> stehen lassen, nächster reconcile prüft erneut
    const off = Object.assign({}, ent, { status: 'canceled', cancelAtPeriodEnd: true, updatedAt: now });
    try { await Ent.setEntitlement(customerId, off); } catch (e) {}
    ent = off;
  }
  return ent ? Ent.publicTier(ent) : null;
}

// Sofort-Freischaltung nach erfolgreicher Buchung IN der App (ohne auf den Cache
// zu warten). Schreibt den Premium-Datensatz direkt.
async function grantFromBooking(customerId, moduleContractId) {
  if (!configured()) return false;
  let ent = null; try { ent = await Ent.getEntitlement(customerId); } catch (e) {}
  if (ent && ent.stripeSubId && Ent.isPremium(ent)) return false;   // Stripe gewinnt
  const now = Date.now();
  const next = {
    tier: 'premium', status: 'active', source: 'magicline',
    moduleContractId: moduleContractId != null ? moduleContractId : ((ent && ent.moduleContractId) || null),
    until: null, cancelAtPeriodEnd: false,
    since: (ent && ent.since) || now, updatedAt: now,
  };
  try { await Ent.setEntitlement(customerId, next); } catch (e) { return false; }
  await invalidate(customerId);
  return true;
}

module.exports = { configured, membershipId, moduleStatus, reconcile, invalidate, grantFromBooking };
