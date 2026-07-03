'use strict';

/**
 * Zusatzmodule / Zusatzleistungen – Magicline Membership-Self-Service-API.
 * ----------------------------------------------------------------------
 * 403-feste Wrapper (Scopes MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_*).
 * Verifiziert gegen die echte OpenAPI-Spec (über die Vertrags-/Membership-ID):
 *   Buchbar:  GET  /memberships/{contractId}/self-service/additional-modules/purchasable
 *   Buchen:   POST /memberships/{contractId}/self-service/additional-modules/purchase
 *             Body: { additionalModuleId, paymentFrequencyId, bookTrialPeriod:false }
 *   Kündigen: POST /memberships/{contractId}/self-service/additional-module-contracts/{id}/ordinary-cancelation
 *             Body: { cancelationDate, cancelationReasonId }  (benötigt Grund/Datum)
 *
 * Für die GEBUCHTEN Module gibt es keinen sauberen Listen-Endpunkt -> booked
 * bleibt leer; eine Kündigung fällt daher im Zweifel auf den Studio-Weg
 * (Inbox-Vorgang + Mail) im aufrufenden Handler zurück. Jeder Zugriff ist
 * strikt 403-/Fehler-sicher: liefert die API nicht sauber, gilt
 * { available:false } bzw. { ok:false, forbidden }. Es wird NIE geworfen.
 */

const { ml } = require('./members');

const svc = (contractId) => '/memberships/' + encodeURIComponent(contractId) + '/self-service/additional-modules';
const contracts = (contractId) => '/memberships/' + encodeURIComponent(contractId) + '/self-service/additional-module-contracts';

function arr(x) { return Array.isArray(x) ? x : []; }
function listFrom(j) { return Array.isArray(j) ? j : arr(j && (j.result || j.content || j.items || j.additionalModules)); }

// Preis robust auf einen kurzen Anzeigetext bringen (Zahl -> "12,90 €", sonst String).
function priceText(v, currency) {
  if (v == null) return null;
  if (typeof v === 'number') {
    var cur = (currency && currency !== 'EUR') ? (' ' + currency) : ' €';
    return v.toFixed(2).replace('.', ',') + cur;
  }
  var s = String(v).trim();
  return s || null;
}

// Erste Zahlungsfrequenz eines Moduls (trägt id + Preis).
function pickFrequency(m) {
  var fs = arr(m && m.paymentFrequencies);
  return fs.length ? fs[0] : null;
}
function freqPrice(f) {
  if (!f) return null;
  var cur = f.currency || (f.price && f.price.currency) || 'EUR';
  var raw = (typeof f.price === 'number') ? f.price
    : (f.price && typeof f.price.amount === 'number') ? f.price.amount
    : (typeof f.amount === 'number') ? f.amount
    : (typeof f.grossPrice === 'number') ? f.grossPrice
    : (typeof f.grossAmount === 'number') ? f.grossAmount
    : (typeof f.monthlyPrice === 'number') ? f.monthlyPrice
    : null;
  return priceText(raw, cur);
}

function pickId(m) {
  return m.id != null ? m.id
    : (m.additionalModuleId != null ? m.additionalModuleId
    : (m.moduleId != null ? m.moduleId : null));
}

// Ein buchbares Modul (AdditionalModule) auf die UI-Felder eindampfen.
function normBookable(m) {
  m = m || {};
  var f = pickFrequency(m);
  var out = { id: pickId(m), name: String(m.name || m.title || m.moduleName || 'Zusatzmodul') };
  if (f && f.id != null) out.paymentFrequencyId = f.id;
  var price = freqPrice(f);
  if (price) out.price = price;
  var desc = m.description || m.text || m.subtitle || null;
  if (desc) out.description = String(desc);
  return out;
}

// ── Buchbare Zusatzmodule (gebuchte: kein Listen-Endpunkt -> leer) ──
// -> { available:true, booked:[], bookable:[{id,name,price?,description?,paymentFrequencyId?}] }
// -> { available:false }   (403/Fehler/unbekannte Form)
async function listModules(contractId) {
  var r;
  try { r = await ml('GET', svc(contractId) + '/purchasable'); }
  catch (e) { return { available: false }; }
  if (!r || r.status !== 200) return { available: false };
  var list = listFrom(r.json);
  if (!Array.isArray(list)) return { available: false };
  var bookable = list.map(normBookable).filter(function (x) { return x.id != null; });
  return { available: true, booked: [], bookable: bookable };
}

function num(v) { var n = Number(v); return isNaN(n) ? v : n; }

// ── Modul buchen ── (paymentFrequencyId wird bei Bedarf aus der Liste ermittelt)
// -> { ok, forbidden, status, error }.  Wirft nie.
async function bookModule(contractId, moduleId, paymentFrequencyId) {
  var freqId = paymentFrequencyId;
  if (freqId == null) {
    try {
      var lr = await ml('GET', svc(contractId) + '/purchasable');
      if (lr && lr.status === 200) {
        var mod = listFrom(lr.json).find(function (m) { return m && String(pickId(m)) === String(moduleId); });
        var f = mod && pickFrequency(mod);
        if (f && f.id != null) freqId = f.id;
      }
    } catch (e) { /* Frequenz optional – ggf. lehnt die API ab, dann Fallback */ }
  }
  var body = { additionalModuleId: num(moduleId), bookTrialPeriod: false };
  if (freqId != null) body.paymentFrequencyId = num(freqId);
  var r;
  try { r = await ml('POST', svc(contractId) + '/purchase', body); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null };
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'purchase_failed' };
}

// ── Modul-Vertrag kündigen ── (braucht Grund/Datum; ohne diese -> Fallback im Handler)
// -> { ok, forbidden, status, error }.  Wirft nie.
async function cancelModule(contractId, moduleContractId) {
  var r;
  try { r = await ml('POST', contracts(contractId) + '/' + encodeURIComponent(moduleContractId) + '/ordinary-cancelation', {}); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null };
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'cancel_failed' };
}

module.exports = { listModules, bookModule, cancelModule };
