'use strict';

/**
 * Zusatzmodule / Zusatzleistungen – Magicline Membership-Self-Service-API.
 * ----------------------------------------------------------------------
 * 403-feste Wrapper (Scopes MEMBERSHIP_SELF_SERVICE_* / ADDITIONAL_MODULE_*).
 *
 * WICHTIG – ANNAHME (nicht sicher verifiziert):
 *   Liste (buchbar + gebucht):
 *     GET  /v1/memberships/{membershipId}/self-service/additional-modules
 *   Buchen:
 *     POST /v1/memberships/{membershipId}/self-service/additional-modules       { moduleId }
 *   Kündigen:
 *     POST /v1/memberships/{membershipId}/self-service/additional-modules/{id}/cancel
 *
 * Die Zusatzmodul-Endpunkte liegen im selben `/memberships/{id}/self-service/`-
 * Bereich wie die Beitragspausen (lib/mlMembership.js) und werden – wie dort –
 * über die Membership-/Vertrags-ID adressiert. Da die exakten Endpunkte und
 * Feldnamen unsicher sind, ist JEDER Zugriff strikt 403-/Fehler-sicher:
 * liefert die API nicht sauber, gilt { available:false } bzw.
 * { ok:false, forbidden } und der Handler fällt auf einen Inbox-Vorgang +
 * Studio-Mail zurück. Es wird NIE geworfen und NIE gecrasht. Feldnamen werden
 * robust normalisiert (name aus name/title/moduleName; price aus
 * price/amount/priceText).
 */

const { ml } = require('./members');

const base = (membershipId) => '/memberships/' + encodeURIComponent(membershipId) + '/self-service/additional-modules';

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

// name aus name/title/moduleName/… robust ziehen.
function pickName(m) {
  return String(m.name || m.title || m.moduleName || m.displayName || m.label || 'Zusatzmodul');
}

// id robust ziehen (id/moduleId/additionalModuleId/uuid/code).
function pickId(m) {
  return m.id != null ? m.id
    : (m.moduleId != null ? m.moduleId
    : (m.additionalModuleId != null ? m.additionalModuleId
    : (m.uuid != null ? m.uuid
    : (m.code != null ? m.code : null))));
}

// price aus price/amount/priceText/… robust ziehen (Zahl, {amount,currency} oder Text).
function pickPrice(m) {
  if (m.priceText != null && String(m.priceText).trim() !== '') return String(m.priceText).trim();
  var cur = m.currency || (m.price && m.price.currency) || (m.amount && m.amount.currency) || 'EUR';
  var raw = (typeof m.price === 'number') ? m.price
    : (typeof m.amount === 'number') ? m.amount
    : (m.price && typeof m.price.amount === 'number') ? m.price.amount
    : (m.amount && typeof m.amount.amount === 'number') ? m.amount.amount
    : (typeof m.grossPrice === 'number') ? m.grossPrice
    : (typeof m.monthlyPrice === 'number') ? m.monthlyPrice
    : null;
  return priceText(raw, cur);
}

// Ein gebuchtes Modul auf die für die UI nötigen Felder eindampfen.
function normBooked(m) {
  m = m || {};
  var out = { id: pickId(m), name: pickName(m) };
  var price = pickPrice(m);
  if (price) out.price = price;
  var billing = m.billingText || m.billing || m.termText || m.cancellationText || m.runtimeText || null;
  if (billing) out.billingText = String(billing);
  return out;
}

// Ein buchbares Modul normalisieren.
function normBookable(m) {
  m = m || {};
  var out = { id: pickId(m), name: pickName(m) };
  var price = pickPrice(m);
  if (price) out.price = price;
  var desc = m.description || m.text || m.subtitle || m.info || m.details || null;
  if (desc) out.description = String(desc);
  return out;
}

function arr(x) { return Array.isArray(x) ? x : []; }

// Ist ein Modul (in einer Gesamtliste) bereits gebucht/aktiv?
function isBookedFlag(m) {
  if (!m) return false;
  if (m.booked || m.active || m.isBooked || m.isActive) return true;
  var st = String(m.state || m.status || '').toUpperCase();
  return st.indexOf('ACTIVE') >= 0 || st.indexOf('BOOKED') >= 0;
}

// ── Buchbare + gebuchte Zusatzmodule ──
// -> { available:true, booked:[{id,name,price?,billingText?}], bookable:[{id,name,price?,description?}] }
// -> { available:false }   (403/Fehler/unbekannte Form)
async function listModules(membershipId) {
  var r;
  try { r = await ml('GET', base(membershipId)); }
  catch (e) { return { available: false }; }
  if (!r || r.status !== 200 || !r.json) return { available: false };
  var j = r.json;
  // Antwortform robust: getrennte Listen ODER eine Gesamtliste mit "booked"-Flag.
  var bookedRaw = arr(j.booked || j.bookedModules || j.active || j.activeModules || j.current);
  var bookableRaw = arr(j.bookable || j.bookableModules || j.available || j.availableModules || j.offerable);
  if (!bookedRaw.length && !bookableRaw.length) {
    var all = arr(j.modules || j.additionalModules || j.result || j.items || j.content || (Array.isArray(j) ? j : null));
    all.forEach(function (m) { if (isBookedFlag(m)) bookedRaw.push(m); else bookableRaw.push(m); });
  }
  var booked = bookedRaw.map(normBooked).filter(function (x) { return x.id != null; });
  var bookable = bookableRaw.map(normBookable).filter(function (x) { return x.id != null; });
  return { available: true, booked: booked, bookable: bookable };
}

// ── Modul buchen ──
// -> { ok, forbidden, status, error }.  Wirft nie.
async function bookModule(membershipId, moduleId) {
  var r;
  try { r = await ml('POST', base(membershipId), { moduleId: moduleId, additionalModuleId: moduleId }); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null };
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'book_failed' };
}

// ── Modul kündigen ──
// -> { ok, forbidden, status, error }.  Wirft nie.
async function cancelModule(membershipId, moduleId) {
  var r;
  try { r = await ml('POST', base(membershipId) + '/' + encodeURIComponent(moduleId) + '/cancel', {}); }
  catch (e) { return { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
  if (r && r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null };
  var forbidden = !!(r && (r.status === 401 || r.status === 403));
  return { ok: false, forbidden: forbidden, status: (r && r.status) || 0, error: (r && r.text) ? String(r.text).slice(0, 200) : 'cancel_failed' };
}

module.exports = { listModules, bookModule, cancelModule };
