'use strict';

/**
 * Wrapper für die Magicline Open-API-Endpunkte zur Selbstverwaltung von
 * Kündigung & Widerruf (Scope MEMBERSHIP_SELF_SERVICE_WRITE).
 *
 * Alle Funktionen sind 403-fest und werfen NIE – Fehler werden als
 * { ok:false, forbidden:bool, status, error } zurückgegeben, damit der
 * bestehende Connect-API-/E-Mail-Weg als Fallback sauber greifen kann.
 * Solange der Scope fehlt (403), verhält sich alles wie „nicht verfügbar".
 */

const M = require('./members');

function norm(r) {
  const ok = r.status >= 200 && r.status < 300;
  return {
    ok: ok,
    forbidden: r.status === 403,
    status: r.status,
    json: r.json || null,
    error: ok ? null : String((r.json && r.json.errorMessage) || r.text || '').slice(0, 240),
  };
}
function fail(e) {
  return { ok: false, forbidden: false, status: 0, json: null, error: String(e && e.message || e) };
}

// Kündigungsgründe des Studios (GET). Liefert normalisiert [{ id, name }].
// 403/Fehler -> { ok:false, forbidden, reasons:[] } (nie werfen).
async function cancelReasons() {
  try {
    const r = await M.ml('GET', '/memberships/self-service/contract-cancelation-reasons');
    if (r.status >= 200 && r.status < 300 && Array.isArray(r.json)) {
      const reasons = r.json
        .map((x) => ({ id: x.cancelationReasonId, name: x.cancelationReasonName }))
        .filter((x) => x.id != null && x.name);
      return { ok: true, forbidden: false, status: r.status, reasons: reasons };
    }
    return { ok: false, forbidden: r.status === 403, status: r.status, reasons: [] };
  } catch (e) { return { ok: false, forbidden: false, status: 0, reasons: [], error: String(e && e.message || e) }; }
}

// Ordentliche Kündigung. body: { contractId, cancelationReasonId, cancelationDate (YYYY-MM-DD) }.
async function ordinaryCancel(customerId, body) {
  try {
    const r = await M.ml('POST', '/memberships/' + encodeURIComponent(customerId) + '/self-service/ordinary-contract-cancelation', {
      contractId: body.contractId,
      cancelationReasonId: body.cancelationReasonId,
      cancelationDate: body.cancelationDate,
    });
    return norm(r);
  } catch (e) { return fail(e); }
}

// Ordentliche Kündigung zurückziehen (Rückgewinnung). Kein Request-Body nötig.
async function withdrawCancel(customerId, contractId) {
  try {
    const r = await M.ml('POST', '/memberships/' + encodeURIComponent(customerId) + '/self-service/withdraw-ordinary-contract-cancelation/' + encodeURIComponent(contractId), {});
    return norm(r);
  } catch (e) { return fail(e); }
}

// 14-Tage-Widerruf (Fernabsatz). Kein Request-Body nötig.
async function contractWithdrawal(customerId, contractId) {
  try {
    const r = await M.ml('POST', '/memberships/' + encodeURIComponent(customerId) + '/self-service/contract-withdrawal/' + encodeURIComponent(contractId), {});
    return norm(r);
  } catch (e) { return fail(e); }
}

module.exports = { cancelReasons, ordinaryCancel, withdrawCancel, contractWithdrawal };
