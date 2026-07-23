'use strict';

/**
 * Zusatzmodule / Zusatzleistungen – Magicline Membership-Self-Service-API.
 * ----------------------------------------------------------------------
 * 403-feste Wrapper. Verifiziert gegen die echte OpenAPI-Spec (Endpunkte laufen
 * über die Vertrags-/Membership-ID):
 *   Buchbar:   GET  /memberships/{contractId}/self-service/additional-modules/purchasable
 *              (Scope MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ)
 *   Buchen:    POST /memberships/{contractId}/self-service/additional-modules/purchase
 *              Body: { additionalModuleId, paymentFrequencyId, bookTrialPeriod:false }
 *              -> Antwort: { id } = Modul-VERTRAGS-ID (additionalModuleContractId)
 *   Lesen:     GET  /memberships/{contractId}/self-service/additional-module-contracts/{id}
 *              (Scope MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_CONTRACT_READ)
 *   Kündigen:  POST …/additional-module-contracts/{id}/ordinary-cancelation
 *              Body: { cancelationDate, cancelationReasonId }  (BEIDE Pflicht)
 *   Gründe:    GET  /memberships/self-service/contract-cancelation-reasons
 *
 * WICHTIG (aus der Spec): Es gibt KEINEN Endpunkt, der die gebuchten Zusatzmodule
 * eines Mitglieds AUFLISTET – nur Buchen, Lesen/Kündigen per bekannter Vertrags-ID.
 * Deshalb wird die beim Kauf zurückgegebene Modul-Vertrags-ID gemerkt (siehe
 * lib/mlPremium) und der Status per GET-by-ID verifiziert. Jeder Zugriff ist strikt
 * 403-/Fehler-sicher und wirft NIE.
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

// Term ({value,unit}) grob in Tage umrechnen – für die „X Tage gratis testen"-Anzeige.
function termToDays(t) {
  if (!t || t.value == null) return null;
  var v = Number(t.value); if (isNaN(v)) return null;
  var u = String(t.unit || '').toUpperCase();
  return u === 'WEEK' ? v * 7 : u === 'MONTH' ? v * 30 : u === 'YEAR' ? v * 365 : v;
}
// Hat das Modul eine Testphase konfiguriert?  -> Tage (Zahl) oder null.
function trialDaysOf(m) { var c = m && m.trialPeriodConfig; return (c && c.term) ? termToDays(c.term) : null; }
function hasTrial(m) { return !!(m && m.trialPeriodConfig && (m.trialPeriodConfig.term || m.trialPeriodConfig.description)); }

// Term ({value,unit}) als deutscher Klartext ("3 Monate") – für die Pflichtangaben (§312j BGB).
function unitDe(u, v) {
  u = String(u || '').toUpperCase(); var one = Number(v) === 1;
  return u === 'DAY' ? (one ? 'Tag' : 'Tage') : u === 'WEEK' ? (one ? 'Woche' : 'Wochen')
    : u === 'MONTH' ? (one ? 'Monat' : 'Monate') : u === 'YEAR' ? (one ? 'Jahr' : 'Jahre') : '';
}
function fmtTerm(t) {
  if (!t || t.value == null) return null;
  var v = Number(t.value); if (isNaN(v)) return null;
  var u = unitDe(t.unit, v);
  return u ? (v + ' ' + u) : String(v);
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
  var td = trialDaysOf(m);
  if (td) out.trialDays = td;
  // Pflichtangaben (§312j BGB): Laufzeit, Verlängerung, Kündigung – aus termInformation.
  var ti = m.termInformation || {};
  var laufzeit = fmtTerm(ti.term);
  if (laufzeit) out.laufzeit = laufzeit;
  var kfr = fmtTerm(ti.cancelationPeriod);
  out.kuendigung = kfr ? ('Kündigungsfrist ' + kfr + ' zum Laufzeitende') : 'zum jeweiligen Laufzeitende';
  var ext = ti.extension, extTerm = ext && fmtTerm(ext.termExtension);
  out.verlaengerung = (ext && ext.extensionType && extTerm)
    ? ('verlängert sich automatisch um ' + extTerm + ', wenn nicht gekündigt')
    : 'keine automatische Verlängerung';
  return out;
}

// Einen gelesenen Modul-Vertrag (AdditionalModuleContractExtended) auf UI-Felder
// eindampfen. cancelled = es liegt eine (ggf. noch nicht bestätigte) Kündigung vor.
function normContract(x, id) {
  x = x || {};
  var out = { id: id, name: String(x.name || 'Zusatzmodul') };
  var price = freqPrice(x.price) || priceText((x.price && x.price.amount), (x.price && x.price.currency));
  if (price) out.price = price;
  var cstat = String(x.contractCancelationStatus || '');
  var cancelled = !!x.cancelationDate || cstat === 'CANCELED' || cstat === 'PENDING_VERIFICATION';
  out.cancelled = cancelled;
  var end = x.endDate || x.cancelationDate || null;
  if (cancelled && end) out.endDate = String(end).slice(0, 10);
  // Nächstmögliches Kündigungsdatum (für die Kündigung selbst): erste verfügbare
  // Kündigungsdatum, sonst die letztmögliche Kündigung.
  var avail = arr(x.availableCancelationDates);
  var nextCancel = avail.length ? avail[0] : (x.lastPossibleCancelationDate || null);
  if (nextCancel) out.nextCancellationDate = String(nextCancel).slice(0, 10);
  out.canWithdraw = !!x.contractCancelationCanBeWithdrawn;
  // Testphase (falls mit Trial gebucht): endDate = letzter Gratis-Tag; zum Trial-Ende
  // kündigen bedeutet: keine Abbuchung.
  var tp = x.trialPeriod;
  if (tp && (tp.endDate || tp.startDate)) {
    out.trial = { startDate: tp.startDate ? String(tp.startDate).slice(0, 10) : null, endDate: tp.endDate ? String(tp.endDate).slice(0, 10) : null };
  }
  return out;
}

// ── Ausgeblendete Zusatzmodule ──
// Module, die in der App NICHT angeboten werden sollen (z. B. reine Studio-/Theken-
// Angebote, die nur intern gebucht werden). Ausblendbar per ID über die Env-Variable
// ML_HIDDEN_MODULE_IDS (kommagetrennt, ohne Deployment änderbar) und zusätzlich per
// fest hinterlegtem Namensmuster.
var HIDDEN_MODULE_IDS = String(process.env.ML_HIDDEN_MODULE_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var HIDDEN_NAME_PATTERNS = [
  // „3 Monate Ernährungsplanung inkl. Stoffwechsel-Ruheanalyse" – wird im Studio verkauft,
  // nicht über die App (die App hat dafür Coach Premium).
  /ern[äa]hrungsplanung.*stoffwechsel|stoffwechsel[\s-]*ruheanalyse/i,
];
function isHiddenModule(moduleId, name) {
  if (moduleId != null && HIDDEN_MODULE_IDS.indexOf(String(moduleId)) >= 0) return true;
  var n = String(name || '');
  for (var i = 0; i < HIDDEN_NAME_PATTERNS.length; i++) { if (HIDDEN_NAME_PATTERNS[i].test(n)) return true; }
  return false;
}

// ── Buchbare Zusatzmodule ──
// -> { available:true, booked:[], bookable:[{id,name,price?,description?,paymentFrequencyId?}] }
// -> { available:false }   (403/Fehler/unbekannte Form)
// booked bleibt leer: die Open API bietet keine Auflistung gebuchter Module (s. o.).
async function listModules(contractId) {
  var r;
  try { r = await ml('GET', svc(contractId) + '/purchasable'); }
  catch (e) { return { available: false }; }
  if (!r || r.status !== 200) return { available: false };
  var list = listFrom(r.json);
  if (!Array.isArray(list)) return { available: false };
  var bookable = list.map(normBookable).filter(function (x) { return x.id != null && !isHiddenModule(x.id, x.name); });
  return { available: true, booked: [], bookable: bookable };
}

// Es gibt KEINEN Listen-Endpunkt für gebuchte Module -> immer leer (Kompatibilität).
async function listBooked() { return []; }

function num(v) { var n = Number(v); return isNaN(n) ? v : n; }

// ── Einen gebuchten Modul-Vertrag per ID lesen ──
// -> { ok:true, contract:{id,name,price?,cancelled,endDate?,nextCancellationDate?,canWithdraw} }
//    { ok:false, gone:true }   (404 -> Vertrag existiert nicht/nicht mehr)
//    { ok:false, forbidden?, status } (403/Fehler)   Wirft nie.
async function getModuleContract(contractId, moduleContractId) {
  if (contractId == null || moduleContractId == null) return { ok: false, status: 0 };
  var r;
  try { r = await ml('GET', contracts(contractId) + '/' + encodeURIComponent(moduleContractId)); }
  catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status === 200 && r.json) return { ok: true, status: 200, contract: normContract(r.json, moduleContractId) };
  if (r && r.status === 404) return { ok: false, status: 404, gone: true };
  return { ok: false, status: (r && r.status) || 0, forbidden: !!(r && (r.status === 401 || r.status === 403)) };
}

// ── Kündigungsgründe des Studios (für die ordinary-cancelation Pflichtangabe) ──
async function getCancelationReasons() {
  var r;
  try { r = await ml('GET', '/memberships/self-service/contract-cancelation-reasons'); }
  catch (e) { return []; }
  if (r && r.status === 200 && Array.isArray(r.json)) return r.json;
  return [];
}
function pickReasonId(reasons) {
  var list = arr(reasons);
  if (!list.length) return null;
  var pref = list.find(function (x) { return /sonst|other|misc|kein/i.test(String((x && x.cancelationReasonName) || '')); });
  var pick = pref || list[0];
  return (pick && pick.cancelationReasonId != null) ? pick.cancelationReasonId : null;
}

// ── Modul buchen ── (paymentFrequencyId wird bei Bedarf aus der Liste ermittelt)
// -> { ok, forbidden, status, error, moduleContractId? }.  Wirft nie.
// moduleContractId = die vom Kauf zurückgegebene additionalModuleContractId (Basis für
// spätere Statusabfrage/Kündigung – die einzige Quelle dafür!).
async function bookModule(contractId, moduleId, paymentFrequencyId, opts) {
  opts = opts || {};
  var freqId = paymentFrequencyId;
  var wantTrial = (opts.trial === true || opts.trial === false) ? opts.trial : null;
  // Modulinfo (Frequenz + Trial-Erkennung) holen, falls nötig.
  if (freqId == null || wantTrial == null) {
    try {
      var lr = await ml('GET', svc(contractId) + '/purchasable');
      if (lr && lr.status === 200) {
        var mod = listFrom(lr.json).find(function (m) { return m && String(pickId(m)) === String(moduleId); });
        if (mod) {
          if (freqId == null) { var f = pickFrequency(mod); if (f && f.id != null) freqId = f.id; }
          if (wantTrial == null) wantTrial = hasTrial(mod);   // Trial automatisch buchen, wenn konfiguriert
        }
      }
    } catch (e) { /* Frequenz/Trial optional – ggf. lehnt die API ab, dann Fallback */ }
  }
  var body = { additionalModuleId: num(moduleId), bookTrialPeriod: !!wantTrial };
  if (freqId != null) body.paymentFrequencyId = num(freqId);
  var r;
  try { r = await ml('POST', svc(contractId) + '/purchase', body); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) {
    // Kauf-Antwort (AdditionalModuleContract) trägt die neue Vertrags-ID – auch verschachtelte
    // Formen abfangen, damit die ID zuverlässig gemerkt werden kann (Basis fürs Kündigen).
    var j = r.json || {};
    var nested = j.contract || j.additionalModuleContract || j.result || {};
    var newId = j.id != null ? j.id
      : (j.additionalModuleContractId != null ? j.additionalModuleContractId
      : ((nested && nested.id != null) ? nested.id
      : ((nested && nested.additionalModuleContractId != null) ? nested.additionalModuleContractId : null)));
    return { ok: true, forbidden: false, status: r.status, error: null, moduleContractId: newId };
  }
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'purchase_failed' };
}

// ── Modul-Vertrag kündigen ── (der Endpunkt erwartet cancelationDate + Grund; BEIDE Pflicht)
// opts: { cancelationDate:'YYYY-MM-DD', cancelationReasonId }. -> { ok, forbidden, status, error }.  Wirft nie.
async function cancelModule(contractId, moduleContractId, opts) {
  opts = opts || {};
  var body = {};
  if (opts.cancelationDate) body.cancelationDate = String(opts.cancelationDate).slice(0, 10);
  if (opts.cancelationReasonId != null) body.cancelationReasonId = num(opts.cancelationReasonId);
  var r;
  try { r = await ml('POST', contracts(contractId) + '/' + encodeURIComponent(moduleContractId) + '/ordinary-cancelation', body); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null, endDate: body.cancelationDate || null };
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'cancel_failed' };
}

// ── Premium-Zusatzmodul(e) (Coach Premium über die Mitgliedschaft, SEPA) ──
// Aktiv nur, wenn ML_PREMIUM_MODULE_ID gesetzt ist; sonst gibt es keinen In-App-Kaufweg.
// Unterstützt EIN oder MEHRERE Module (kommagetrennt): z. B. „Coach Premium Monat",
// „Coach Premium Jahr" und „Vital-Starter" (Jahr inkl. H9). Alle schalten dasselbe
// Premium frei. Rückwärtskompatibel – ein einzelner Wert funktioniert unverändert.
var PREMIUM_MODULE_IDS = String(process.env.ML_PREMIUM_MODULE_ID || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var PREMIUM_MODULE_ID = PREMIUM_MODULE_IDS[0] || '';   // primäre ID (Anzeige/Abwärtskompatibilität)
function premiumConfigured() { return PREMIUM_MODULE_IDS.length > 0; }
function isPremiumModule(moduleId) { return moduleId != null && PREMIUM_MODULE_IDS.indexOf(String(moduleId)) >= 0; }

module.exports = {
  listModules, listBooked, bookModule, cancelModule,
  getModuleContract, getCancelationReasons, pickReasonId,
  PREMIUM_MODULE_ID, PREMIUM_MODULE_IDS, premiumConfigured, isPremiumModule,
  isHiddenModule,
};
