'use strict';

/**
 * TEMPORÄR – Scope-Diagnose. Prüft serverseitig, welche Magicline-Endpunkte der
 * hinterlegte API-Key darf (403 = Scope fehlt). Liefert NUR Statuscodes, KEINE
 * personenbezogenen Daten und KEINE Secrets. Wird nach der Prüfung wieder entfernt.
 */

const M = require('../lib/members');
const Inbox = require('../lib/inbox');

async function probe(method, path, body) {
  try {
    const r = await M.ml(method, path, body);
    const st = r.status;
    // Scope gilt als vorhanden, wenn NICHT 401/403 (400/404/409 = autorisiert, nur Body/Ziel abweichend).
    return { status: st, granted: !!(st && st !== 401 && st !== 403) };
  } catch (e) { return { status: 0, granted: false, error: true }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  // Eine Kunden-ID aus dem Postfach ziehen (nur intern für ID-basierte Proben; wird NICHT zurückgegeben).
  let cid = null;
  try { const all = await Inbox.listAll({ limit: 8 }); for (const v of (all || [])) { if (v && v._memberId) { cid = String(v._memberId); break; } } } catch (e) {}

  const out = {};
  out.STUDIO_READ = await probe('GET', '/studios/information');
  out.BOOKABLE_APPOINTMENTS_READ = await probe('GET', '/appointments/bookable?sliceSize=1');
  out.TRIAL_OFFER_READ = await probe('GET', '/trial-offers/bookable-trial-offers/appointments/bookable?sliceSize=1');
  out.MEMBERSHIP_SELF_SERVICE_read_reasons = await probe('GET', '/memberships/self-service/contract-cancelation-reasons');
  // Schreib-Scopes SICHER über die validate-Endpunkte prüfen (403 = kein Scope; 400/404 = Scope da).
  const dummy = { customerId: 0, bookableAppointmentId: 0, startDateTime: '2000-01-01T00:00:00+00:00', endDateTime: '2000-01-01T01:00:00+00:00' };
  out.APPOINTMENTS_WRITE_validate = await probe('POST', '/appointments/bookable/validate', dummy);
  out.TRIAL_OFFER_WRITE_validate = await probe('POST', '/trial-offers/appointments/booking/validate', dummy);
  if (cid) {
    out.CHECKIN_READ = await probe('GET', '/customers/' + encodeURIComponent(cid) + '/activities/checkins?sliceSize=1&fromDate=2024-01-01&toDate=2024-01-08');
    out.APPOINTMENTS_READ = await probe('GET', '/appointments/booking?customerId=' + encodeURIComponent(cid));
    out.CUSTOMER_CONTRACT_READ = await probe('GET', '/customers/' + encodeURIComponent(cid) + '/contracts');
  } else {
    out.CHECKIN_READ = { skipped: 'no_customer_id' };
    out.APPOINTMENTS_READ = { skipped: 'no_customer_id' };
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, hadCustomerId: !!cid, probes: out }, null, 2));
};
