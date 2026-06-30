'use strict';

/**
 * TEMPORÄRER Scope-Check (nach Gebrauch wieder entfernen!).
 * Ruft pro Scope einen NUR-LESENDEN Magicline-Endpunkt auf und meldet den Status.
 * 403 = das Recht fehlt auf unserem API-Key. Alles andere (200/400/404) = Recht vorhanden.
 *
 * Aufruf: https://mitglieder.fit-inn-trier.de/api/scopecheck  ->  Passwort-Formular
 * (Team-Passwort wird per POST übertragen; keine Sonderzeichen-Probleme in der URL).
 */

const M = require('../lib/members');
const TA = require('../lib/teamAuth');

function readRaw(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

const FORM = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">'
  + '<h2>Magicline Scope-Check</h2><p>Team-Passwort eingeben:</p>'
  + '<form method="post"><input type="password" name="pw" autofocus style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px">'
  + '<button style="margin-top:12px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#0e6072;color:#fff">Prüfen</button></form></body>';

module.exports = async function handler(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: () => '' } }; }
  const q = (k) => (url.searchParams.get && url.searchParams.get(k)) || '';

  // Passwort aus POST-Body (Formular) ODER ?pw=
  let pw = q('pw');
  let bodyParams = null;
  if (req.method === 'POST') {
    const raw = await readRaw(req);
    bodyParams = new URLSearchParams(raw);
    pw = bodyParams.get('pw') || pw;
    if (!pw) { try { pw = JSON.parse(raw || '{}').pw || ''; } catch (e) {} }
  }

  if (!TA.verifyPassword(pw)) {
    if (req.method === 'POST') { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(FORM);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // Kunden-ID: ?customerId / DEMO_CUSTOMER_ID / Mitgliedsnummer+dob / E-Mail+dob
  const param = (k) => q(k) || (bodyParams && bodyParams.get(k)) || '';
  const dob = param('dob') || process.env.DEMO_LOGIN_DOB;
  let cid = param('customerId') || process.env.DEMO_CUSTOMER_ID || null;
  if (!cid) { try { const m = await M.findByNumberDob(param('num') || process.env.DEMO_CUSTOMER_NUMBER, dob); if (m) cid = m.id != null ? m.id : m.customerId; } catch (e) {} }
  if (!cid) { try { const m = await M.findByEmailDob(param('email') || process.env.DEMO_LOGIN_EMAIL, dob); if (m) cid = m.id != null ? m.id : m.customerId; } catch (e) {} }
  // Falls cid eine Mitgliedsnummer ist (z. B. "M-2076"), echte interne ID auflösen.
  if (cid && !/^\d+$/.test(String(cid))) {
    try { const m = await M.findByNumberDob(String(cid), dob); if (m && (m.id != null || m.customerId != null)) cid = m.id != null ? m.id : m.customerId; } catch (e) {}
  }
  if (!cid) { res.statusCode = 200; return res.end('Keine Kunden-ID gefunden. Bitte mit ?customerId=… aufrufen (echte interne ID).'); }

  let kid = null;
  try { const r = await M.ml('GET', '/customers/' + encodeURIComponent(cid) + '/contracts'); if (Array.isArray(r.json) && r.json.length) { const c = r.json[0]; kid = c.id != null ? c.id : (c.contractId != null ? c.contractId : null); } } catch (e) {}

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
  const lines = ['=== Magicline Scope-Check ===', 'customerId=' + cid + '  contractId=' + (kid != null ? kid : '—'), ''];
  results.forEach((r) => {
    const tag = r.status === 403 ? 'FEHLT ❌' : (r.status === 401 ? 'AUTH ⚠️' : 'OK ✓   ');
    lines.push(tag + '  ' + r.scope + '  (HTTP ' + r.status + ')');
  });
  lines.push('', 'Bekannt: CUSTOMER_SELF_SERVICE_WRITE -> 403 (Schreiben Adresse/Bank).', '',
    '>>> FEHLENDE LESE-RECHTE (403): ' + (missing.length ? missing.join(', ') : 'KEINE'));
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
