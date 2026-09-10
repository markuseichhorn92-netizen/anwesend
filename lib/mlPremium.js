'use strict';

/**
 * Premium fürs Ernährungsmodul über ein Magicline-Zusatzmodul (SEPA, Teil des
 * Mitgliedsvertrags) – der einzige Premium-Kaufweg der App.
 * -------------------------------------------------------------------------
 * Aktiv nur, wenn ML_PREMIUM_MODULE_ID gesetzt ist. Ohne diese Env gibt es keinen
 * In-App-Kaufweg (Premium dann nur per Team-Freischaltung).
 *
 * Idee: Der gebuchte Modul-Status wird (gecacht) in denselben Entitlement-
 * Datensatz (lib/entitlements) gespiegelt, den ALLE Premium-Gates ohnehin lesen –
 * mit source:'magicline'. Damit muss keine einzige Gate-Stelle geändert werden.
 *   - Modul gebucht           -> Premium an (status active, until = Modul-Ende falls gekündigt)
 *   - Modul gekündigt         -> läuft bis Modul-Ende weiter, dann aus (until greift)
 *   - Modul nicht (mehr) da    -> Premium-Datensatz dieser Quelle wird abgeräumt
 *
 * reconcile() deckt auch Buchungen/Kündigungen ab, die das Studio DIREKT in
 * Magicline vornimmt. Eine Team-Freischaltung (source:'team*') bleibt unberührt.
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

// Status des gebuchten Premium-Moduls (mit Redis-Cache). Die Open API bietet KEINE
// Auflistung gebuchter Module – daher wird die beim Kauf gemerkte Modul-Vertrags-ID
// (ent.moduleContractId) per GET-by-ID verifiziert.
// -> { booked:true, moduleContractId, endDate?, cancelled?, nextCancellationDate? }
//    { booked:false }   (Vertrag existiert nicht mehr – 404)
//    null               (keine gemerkte ID ODER 403/Fehler -> Status unbekannt)
async function moduleStatus(customerId, opts) {
  if (!configured()) return null;
  opts = opts || {};
  if (!opts.fresh) {
    try { const [c] = await redisPipeline([['GET', CACHE_KEY(customerId)]]); if (c) return JSON.parse(c); }
    catch (e) {}
  }
  let ent = null; try { ent = await Ent.getEntitlement(customerId); } catch (e) {}
  const cid = (ent && ent.moduleContractId != null) ? ent.moduleContractId : null;
  if (cid == null) return null;   // ohne gemerkte ID nicht abfragbar -> Entitlement bleibt maßgeblich
  const mid = await membershipId(customerId);
  let res = null;
  try { res = await MlMod.getModuleContract(mid, cid); } catch (e) { res = null; }
  let out;
  if (res && res.ok && res.contract) {
    out = { booked: true, moduleContractId: cid, endDate: res.contract.endDate || null, cancelled: !!res.contract.cancelled, nextCancellationDate: res.contract.nextCancellationDate || null, trialEnd: (res.contract.trial && res.contract.trial.endDate) || null };
  } else if (res && res.gone) {
    out = { booked: false };
  } else {
    return null;   // 403/Fehler/unbekannt -> nicht cachen, nichts downgraden
  }
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
  // Ohne Abo-Modell gibt es nichts abzugleichen: kein Magicline-Aufruf, kein
  // Schreiben am Entitlement. Der Modulstatus bleibt über moduleStatus() lesbar,
  // damit eine bestehende Buchung weiterhin gekündigt werden kann.
  if (!require('./features').aboOn()) return null;
  let ent = null;
  try { ent = await Ent.getEntitlement(customerId); } catch (e) {}
  // Eine Team-Freischaltung (comp) gewinnt – Modulstatus nicht drüberschreiben.
  if (ent && ent.source && String(ent.source).indexOf('team') === 0 && Ent.isPremium(ent)) return Ent.publicTier(ent);

  let st = null;
  try { st = await moduleStatus(customerId); } catch (e) { st = null; }
  if (!st) return ent ? Ent.publicTier(ent) : null;

  const now = Date.now();
  if (st.booked) {
    const trialEndMs = st.trialEnd ? Date.parse(st.trialEnd + 'T23:59:59') : null;
    const inTrial = !!(trialEndMs && !isNaN(trialEndMs) && trialEndMs >= now);
    const cancelUntil = (st.cancelled && st.endDate) ? Date.parse(st.endDate + 'T23:59:59') : null;
    // until = Ende NUR bei Kündigung (läuft bis dahin, danach aus). Im laufenden Trial läuft
    // Premium danach als zahlendes Abo weiter -> until bleibt null (Premium verfällt nicht).
    const until = (st.cancelled && cancelUntil && !isNaN(cancelUntil)) ? cancelUntil : null;
    const next = {
      tier: 'premium',
      status: inTrial ? 'trialing' : 'active',
      source: 'magicline',
      moduleContractId: st.moduleContractId != null ? st.moduleContractId : null,
      until: until,
      cancelAtPeriodEnd: !!st.cancelled,
      trialEnd: st.trialEnd || null,
      since: (ent && ent.since) || now,
      updatedAt: now,
    };
    // Nur schreiben, wenn sich etwas Relevantes geändert hat (spart Writes).
    const same = ent && ent.source === 'magicline' && ent.status === next.status
      && (ent.until || null) === (next.until || null) && !!ent.cancelAtPeriodEnd === next.cancelAtPeriodEnd
      && String(ent.moduleContractId || '') === String(next.moduleContractId || '')
      && (ent.trialEnd || null) === (next.trialEnd || null);
    if (!same) { try { await Ent.setEntitlement(customerId, next); } catch (e) {} ent = next; }
    return Ent.publicTier(ent);
  }

  // Nicht (mehr) gebucht: einen magicline-Datensatz abräumen (Team-Comp unberührt).
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
