'use strict';

/**
 * TEMPORÄRER Scope-Check (nach Gebrauch wieder entfernen!).
 * Ruft pro Scope einen NUR-LESENDEN Magicline-Endpunkt auf und meldet den Status.
 * 403 = das Recht fehlt auf unserem API-Key. Alles andere (200/400/404) = Recht vorhanden.
 * Schutz: Team-Passwort (?pw=...). Aufruf z. B.:
 *   https://mitglieder.fit-inn-trier.de/api/scopecheck?pw=DEIN_TEAM_PASSWORT
 */

const M = require('../lib/members');
const TA = require('../lib/teamAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: new Map() }; }
  const pw = (url.searchParams.get && url.searchParams.get('pw')) || '';
  if (!TA.verifyPassword(pw)) { res.statusCode = 401; return res.end('unauthorized'); }

  // Kunden-ID bestimmen: ?customerId= ODER über den Demo-Account (Mitgliedsnummer+Geburtstag)
  let cid = (url.searchParams.get && url.searchParams.get('customerId')) || null;
  if (!cid) {
    try {
      const m = await M.findByNumberDob(process.env.DEMO_CUSTOMER_NUMBER, process.env.DEMO_LOGIN_DOB);
      if (m) cid = m.id != null ? m.id : m.customerId;
    } catch (e) {}
  }
  if (!cid) { res.statusCode = 200; return res.end('Keine Kunden-ID gefunden. Bitte ?customerId=... anhängen (oder DEMO_CUSTOMER_NUMBER/DEMO_LOGIN_DOB prüfen).'); }

  // contractId für die membership-/idle-period-Checks
  let kid = null;
  try {
    const r = await M.ml('GET', '/customers/' + encodeURIComponent(cid) + '/contracts');
    if (Array.isArray(r.json) && r.json.length) { const c = r.json[0]; kid = c.id != null ? c.id : (c.contractId != null ? c.contractId : null); }
  } catch (e) {}

  const C = encodeURIComponent(cid);
  const probes = [
    ['CUSTOMER_READ', '/customers/' + C],
    ['CUSTOMER_SELF_SERVICE_READ', '/customers/' + C + '/self-service/address-data'],
    ['CUSTOMER_CONTRACT_READ', '/customers/' + C + '/contracts'],
    ['CHECKIN_READ', '/customers/' + C + '/activities/checkins?sliceSize=5'],
    ['CUSTOMER_ACCOUNT_READ', '/customers/' + C + '/account/balances'],
    ['PAYMENT_READ', '/customers/' + C + '/account/payment-details'],
    ['CUSTOMER_PAYMENT_SEARCH', '/customers/' + C + '/account/transactions'],
    ['CUSTOMER_MEASUREMENT_READ', '/customers/measurement/latest?customerId=' + C],
    ['COMMUNICATION_PREFERENCES_READ', '/communications/' + C + '/communication-preferences'],
    ['CUSTOMER_BENEFIT_READ', '/customers/' + C + '/benefits'],
    ['CUSTOMER_DOCUMENT_READ', '/customers/' + C + '/documents'],
    ['ADDITIONAL_INFORMATION_READ', '/customers/' + C + '/additional-information-field-assignments'],
    ['EMPLOYEE_READ', '/employees'],
    ['ONLINE_OFFER_READ', '/online-offers/purchasable'],
    ['BOOKABLE_APPOINTMENTS_READ', '/appointments/bookable'],
    ['APPOINTMENTS_READ', '/appointments/booking?customerId=' + C],
    ['STUDIO_READ', '/studios/utilization'],
    ['LEAD_READ', '/leads/config'],
  ];
  if (kid != null) {
    const K = encodeURIComponent(kid);
    probes.push(['MEMBERSHIP_SELF_SERVICE_IDLE_PERIOD_CONFIG_READ', '/memberships/' + K + '/self-service/idle-periods/config']);
    probes.push(['MEMBERSHIP_SELF_SERVICE_IDLE_PERIOD_READ', '/memberships/' + K + '/self-service/idle-periods']);
  }

  const results = [];
  for (const [scope, path] of probes) {
    let st = -1; try { const r = await M.ml('GET', path); st = r.status; } catch (e) { st = -1; }
    results.push({ scope: scope, status: st });
  }

  const missing = results.filter((r) => r.status === 403).map((r) => r.scope);
  const lines = [];
  lines.push('=== Magicline Scope-Check ===');
  lines.push('customerId=' + cid + '  contractId=' + (kid != null ? kid : '—'));
  lines.push('');
  results.forEach((r) => {
    const tag = r.status === 403 ? 'FEHLT ❌' : (r.status === 401 ? 'AUTH ⚠️' : 'OK ✓   ');
    lines.push(tag + '  ' + r.scope + '  (HTTP ' + r.status + ')');
  });
  lines.push('');
  lines.push('Bekannt: CUSTOMER_SELF_SERVICE_WRITE -> 403 (Schreiben Adresse/Bank).');
  lines.push('');
  lines.push('>>> FEHLENDE LESE-RECHTE (403): ' + (missing.length ? missing.join(', ') : 'KEINE'));
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
