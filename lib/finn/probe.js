'use strict';

/**
 * FINN – Scope-Probe (nur lesen).
 * -----------------------------------------------------------------------------
 * Das Team möchte auf der Statusseite sehen, welche Magicline-Scopes wirklich
 * freigeschaltet sind – ohne zu warten, bis ein Agent sie zufällig benutzt.
 * Die Probe ruft ausschließlich LESENDE Funktionen des Tool-Layers auf
 * (lib/finn/magicline.js); jedes Ergebnis wird von der Capability-Erkennung
 * gemerkt (grün/rot). Es wird nichts geschrieben, nichts in Magicline verändert.
 *
 *   run({ customerId? })  -> { ok, checks:[{ scope, fn, state:'ok'|'forbidden'|'unavailable'|'not_found', status }] }
 *
 * Ohne customerId nur studioweite Scopes; mit customerId zusätzlich die
 * kundenbezogenen Lese-Scopes (die Daten selbst werden NICHT zurückgegeben).
 */

const ML = require('./magicline');
const Audit = require('./audit');

function classify(r) {
  if (!r) return 'unavailable';
  if (r.ok) return 'ok';
  if (r.forbidden) return 'forbidden';
  if (r.error === 'not_found') return 'not_found';
  return 'unavailable';
}

async function run(o) {
  o = o || {};
  const cid = o.customerId != null && /^[0-9]{1,12}$/.test(String(o.customerId)) ? String(o.customerId) : null;
  const plan = [
    ['STUDIO_READ', 'studio.hours', () => ML.studio.hours()],
    ['BOOKABLE_APPOINTMENTS_READ', 'appointments.types', () => ML.appointments.types()],
    ['MEMBERSHIP_SELF_SERVICE_READ', 'contract.cancelReasons', () => ML.contract.cancelReasons()],
    ['LEAD_READ', 'leads.config', () => ML.leads.config()],
  ];
  if (cid) {
    plan.push(
      ['CUSTOMER_READ', 'customer.get', () => ML.customer.get(cid)],
      ['CUSTOMER_ACCOUNT_READ', 'account.summary', () => ML.account.summary(cid)],
      ['APPOINTMENTS_READ', 'appointments.mine', () => ML.appointments.mine(cid)],
      ['CHECKIN_READ', 'checkins.recent', () => ML.checkins.recent(cid, { windows: 1 })],
      ['CUSTOMER_DOCUMENT_READ', 'documents.list', () => ML.documents.list(cid)],
      ['CUSTOMER_ACCESS_MEDIUM_READ', 'access.list', () => ML.access.list(cid)],
      ['COMMUNICATION_PREFERENCES_READ', 'comm.get', () => ML.comm.get(cid)],
    );
  }
  const checks = [];
  for (const [scope, fn, call] of plan) {
    let r = null;
    try { r = await call(); } catch (e) { r = null; }
    checks.push({ scope: scope, fn: fn, state: classify(r), status: (r && r.status) || 0 });
  }
  // Kundenbezogene Modul-/Pausen-Scopes hängen an der Vertrags-Id.
  if (cid) {
    const c = await ML.contract.get(cid);
    const k = c.ok && c.data ? c.data.contractId : null;
    if (k != null) {
      for (const [scope, fn, call] of [
        ['MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ', 'modules.list', () => ML.modules.list(k)],
        ['MEMBERSHIP_SELF_SERVICE_READ', 'pause.config', () => ML.pause.config(k)],
      ]) {
        let r = null; try { r = await call(); } catch (e) { r = null; }
        checks.push({ scope: scope, fn: fn, state: classify(r), status: (r && r.status) || 0 });
      }
    }
  }
  try { await Audit.record({ kind: 'probe', status: 'ok', tool: 'scope_probe', agent: 'team', actor: o.actor || { kind: 'team', id: 'probe' }, channel: 'team', customerId: cid, code: checks.filter((x) => x.state === 'forbidden').length + '_forbidden' }); } catch (e) {}
  return { ok: true, checks: checks, customerScoped: !!cid };
}

module.exports = { run, classify };
