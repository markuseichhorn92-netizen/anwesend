'use strict';

/**
 * Beitragspausen (Idle Periods) – Magicline Membership-Self-Service-API.
 * ----------------------------------------------------------------------
 * Degradiert sauber: Fehlt der Scope, antwortet Magicline mit 403 -> die
 * Funktionen liefern { available:false, forbidden:true } bzw. { ok:false, … }
 * zurück und werfen NIE, damit im Handler der E-Mail-Fallback greifen kann.
 */

const { ml, mlForm } = require('./members');

const base = (contractId) => '/memberships/' + encodeURIComponent(contractId) + '/self-service/idle-periods';

// Eine Pause (bzw. einen Pause-Antrag) auf die für die UI nötigen Felder eindampfen.
function normPeriod(p) {
  p = p || {};
  return {
    id: p.id != null ? p.id : null,
    startDate: p.startDate || null,
    endDate: p.endDate || null,
    unlimited: !!p.unlimited,
    state: p.state || null,                                     // PENDING_VERIFICATION | ACCEPTED
    reason: (p.idlePeriodReason && p.idlePeriodReason.name) || p.reason || null,
    reasonId: (p.idlePeriodReason && p.idlePeriodReason.id != null) ? p.idlePeriodReason.id : null,
  };
}

// Pausen-Konfiguration des Vertrags (Gründe, Einheit, Limits, Gebühr).
async function idleConfig(contractId) {
  let r;
  try { r = await ml('GET', base(contractId) + '/config'); }
  catch (e) { return { available: false, forbidden: false }; }
  if (r.status === 403) return { available: false, forbidden: true };
  if (r.status !== 200 || !r.json) return { available: false, forbidden: false, status: r.status };
  const j = r.json;
  const fee = j.idlePeriodFee || {};
  return {
    available: true,
    temporalUnit: j.temporalUnit || 'WEEK',
    maxTerms: j.maxTerms != null ? j.maxTerms : null,
    maxTermPerReferencePeriod: j.maxTermPerReferencePeriod != null ? j.maxTermPerReferencePeriod : null,
    referencePeriod: j.referencePeriod || null,
    firstPossibleStartDate: j.firstPossibleStartDate || null,
    nextPossibleStartDateOnly: !!j.nextPossibleStartDateOnly,
    unlimitedAllowed: !!j.unlimitedAllowed,
    accessRefusal: !!j.accessRefusal,
    fee: { amount: (typeof fee.amount === 'number') ? fee.amount : 0, currency: fee.currency || 'EUR' },
    reasons: Array.isArray(j.idlePeriodReasons)
      ? j.idlePeriodReasons.map((x) => ({ id: x.id, name: x.name || '', documentRequired: !!x.documentRequired }))
      : [],
  };
}

// Verbleibendes Pausen-Kontingent des Vertrags.
async function idleRemaining(contractId) {
  let r;
  try { r = await ml('GET', base(contractId) + '/remaining'); }
  catch (e) { return { ok: false, status: 0 }; }
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };
  return { ok: true, maxTerms: r.json.remainingMaxTerms || null, freeTerms: r.json.remainingFreeTerms || null };
}

// Bestehende Pausen: aktiv/geplant (inkl. Anträge in Prüfung) + vergangen.
async function idleList(contractId) {
  let r;
  try { r = await ml('GET', base(contractId)); }
  catch (e) { return { ok: false, status: 0 }; }
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };
  return {
    ok: true,
    current: Array.isArray(r.json.currentAndUpcomingIdlePeriods) ? r.json.currentAndUpcomingIdlePeriods.map(normPeriod) : [],
    past: Array.isArray(r.json.pastIdlePeriods) ? r.json.pastIdlePeriods.map(normPeriod) : [],
  };
}

// Pause-Anfrage vorab prüfen. data = { startDate, temporalUnit, termValue, unlimited }
async function idleValidate(contractId, data) {
  let r;
  try { r = await ml('POST', base(contractId) + '/validate', data); }
  catch (e) { return { ok: false, status: 0 }; }
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };
  const st = r.json.validationStatus || null;
  return { ok: true, validationStatus: st, creatable: st === 'IDLEPERIOD_CREATABLE' };
}

// Pause anlegen. data = { startDate, temporalUnit, termValue, unlimited, reasonId },
// documentB64 = optionaler Nachweis (base64 ohne data:-Präfix).
// Der Create-Endpunkt ist ein Spring-Multipart-Endpunkt (@RequestPart data +
// optionales document) und akzeptiert KEIN application/json am Gesamt-Request –
// daher via mlForm (multipart/form-data) statt ml().
async function idleCreate(contractId, data, documentB64) {
  const parts = [{ name: 'data', json: data, filename: 'data.json' }];
  if (documentB64) parts.push({ name: 'document', base64: String(documentB64), type: 'application/octet-stream', filename: 'nachweis' });
  let r;
  try { r = await mlForm('POST', base(contractId), parts); }
  catch (e) { return { ok: false, status: 0 }; }
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, message: (r.json && r.json.errorMessage) || null };
  }
  return { ok: true, idlePeriod: normPeriod(r.json) };
}

// Pause bzw. Antrag zurückziehen.
async function idleWithdraw(contractId, id) {
  let r;
  try { r = await ml('DELETE', base(contractId) + '/' + encodeURIComponent(id)); }
  catch (e) { return { ok: false, status: 0 }; }
  if (r.status === 403) return { ok: false, forbidden: true, status: 403 };
  if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status };
  return { ok: true };
}

module.exports = { idleConfig, idleRemaining, idleList, idleValidate, idleCreate, idleWithdraw };
