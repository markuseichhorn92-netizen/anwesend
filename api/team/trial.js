'use strict';

/**
 * Team-Backend: Probetraining buchen (Magicline Trial-Offer-Flow).
 *   GET  ?action=offers                         -> buchbare Probetraining-Angebote
 *   GET  ?action=slots&bookableId=<id>&days=<n> -> freie Termine (echte Verfügbarkeit)
 *   POST { action:'book', firstName, lastName, email, configId, bookableId,
 *          start, end, instructorIds? }
 *        -> Lead anlegen (/trial-offers/lead/create) + buchen
 *           (/trial-offers/appointments/booking/book) + ggf. bestätigen.
 *
 * Scopes: TRIAL_OFFER_READ / TRIAL_OFFER_WRITE. Fehlen sie (403) oder scheitert
 * die Buchung, geht der Wunsch NICHT verloren: Fallback per E-Mail ans Studio.
 * Alles team-gesichert, 403-/fehlersicher, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const { sendMail, hasMail } = require('../../lib/mail');

const WINDOW = 6;   // max. daysAhead laut API
function ymd(d) { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

// Buchbare Probetraining-Angebote (Konfig + zugehörige Termin-Art).
async function loadOffers() {
  try {
    const r = await M.ml('GET', '/trial-offers/bookable-trial-offers/appointments/bookable?sliceSize=100');
    if (!(r.status >= 200 && r.status < 300)) return { available: false, forbidden: r.status === 403, offers: [] };
    const arr = (r.json && Array.isArray(r.json.result)) ? r.json.result : (Array.isArray(r.json) ? r.json : []);
    const offers = arr.map((o) => {
      const ba = o.trialOfferBookableAppointment || o.bookableAppointment || {};
      const bid = ba.id != null ? ba.id : o.id;
      return { configId: o.trialOfferConfigId, bookableId: bid, title: ba.title || o.title || 'Probetraining', duration: ba.duration || null };
    }).filter((x) => x.configId != null && x.bookableId != null);
    return { available: true, offers: offers };
  } catch (e) { return { available: false, offers: [] }; }
}

// Freie Slots einer Probetraining-Art (mehrere 6-Tage-Fenster zusammengeführt).
async function loadSlots(bookableId, days) {
  days = days || 21; if (!(days > 0)) days = 21; if (days > 42) days = 42;
  const starts = [];
  const today = new Date();
  for (let off = 0; off < days; off += WINDOW) { const d = new Date(today.getTime()); d.setDate(d.getDate() + off); starts.push(ymd(d)); }
  const base = '/trial-offers/bookable-trial-offers/appointments/bookable/' + encodeURIComponent(bookableId) + '/slots';
  try {
    const results = await Promise.all(starts.map((sd) =>
      M.ml('GET', base + '?daysAhead=' + WINDOW + '&slotWindowStartDate=' + sd)
        .then((r) => Array.isArray(r.json) ? r.json : []).catch(() => [])));
    const seen = {}, out = [], now = Date.now();
    results.forEach((arr) => arr.forEach((s) => {
      if (!s || !s.startDateTime || seen[s.startDateTime]) return;
      const t = Date.parse(s.startDateTime); if (!isNaN(t) && t <= now) return;
      seen[s.startDateTime] = 1;
      const ins = Array.isArray(s.instructors) ? s.instructors : [];
      const first = ins[0] || null;
      out.push({ start: s.startDateTime, end: s.endDateTime || null,
        instructorIds: ins.map((i) => i.id).filter((x) => x != null),
        instructor: first ? (first.publicName || ((first.firstName || '') + ' ' + (first.lastName || '')).trim()) : '' });
    }));
    out.sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0));
    return out;
  } catch (e) { return []; }
}

// Lead anlegen -> buchen -> ggf. bestätigen. Liefert { ok, forbidden?, bookingStatus?, message? }.
async function doBook(body) {
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim();
  const configId = body.configId, bookableId = body.bookableId, start = body.start, end = body.end;
  if (!firstName || !lastName || !email) return { ok: false, validation: true, message: 'Bitte Vorname, Nachname und E-Mail angeben.' };
  if (configId == null || bookableId == null || !start || !end) return { ok: false, validation: true, message: 'Bitte einen freien Termin wählen.' };

  // 1) Lead anlegen
  let leadId = null, leadStatus = 0;
  try {
    const r = await M.ml('POST', '/trial-offers/lead/create', {
      leadCustomerData: { firstname: firstName, lastname: lastName, email: email },
      trialOfferConfigId: Number(configId),
    });
    leadStatus = r.status;
    if (r.status >= 200 && r.status < 300 && r.json) {
      leadId = r.json.leadCustomerId != null ? r.json.leadCustomerId : (r.json.id != null ? r.json.id : (r.json.customerId != null ? r.json.customerId : null));
    }
  } catch (e) { /* -> unten Fallback */ }
  if (leadId == null) return { ok: false, forbidden: leadStatus === 403, message: 'Lead konnte nicht angelegt werden.' };

  // 2) buchen
  const payload = { customerId: Number(leadId), bookableAppointmentId: Number(bookableId), startDateTime: String(start), endDateTime: String(end) };
  if (Array.isArray(body.instructorIds) && body.instructorIds.length) {
    const ids = body.instructorIds.map(Number).filter((n) => !isNaN(n));
    if (ids.length) payload.instructorIds = ids;
  }
  let bookingId = null, bookingStatus = null, bookStatus = 0;
  try {
    const r = await M.ml('POST', '/trial-offers/appointments/booking/book', payload);
    bookStatus = r.status;
    if (r.status >= 200 && r.status < 300 && r.json) { bookingId = r.json.bookingId != null ? r.json.bookingId : null; bookingStatus = r.json.bookingStatus || null; }
  } catch (e) { /* -> unten Fallback */ }
  if (bookStatus < 200 || bookStatus >= 300) return { ok: false, forbidden: bookStatus === 403, message: 'Der Termin konnte nicht gebucht werden.' };

  // 3) ggf. bestätigen
  if (bookingStatus === 'BOOKED_WITH_CONFIRMATION_REQUIRED' && bookingId != null) {
    try { await M.ml('POST', '/trial-offers/bookings/' + encodeURIComponent(bookingId) + '/confirm', {}); } catch (e) {}
  }
  return { ok: true, bookingId: bookingId, bookingStatus: bookingStatus };
}

// Fallback: Wunsch per E-Mail ans Studio, wenn die API-Buchung nicht möglich war.
async function bookFallback(body, whenText) {
  if (!hasMail) return { ok: false, message: 'Probetraining-Buchung ist nicht eingerichtet (Scope TRIAL_OFFER_* bzw. E-Mail fehlt).' };
  try {
    await sendMail('🎟️ Probetraining-Wunsch – ' + (body.firstName || '') + ' ' + (body.lastName || ''),
      'Ein Probetraining wurde im Team-Backend angefragt (automatische Buchung war nicht möglich – bitte im Magicline-Kalender eintragen).\n\n'
      + 'Name: ' + (body.firstName || '') + ' ' + (body.lastName || '')
      + '\nE-Mail: ' + (body.email || '—')
      + '\nWunschtermin: ' + (whenText || '—')
      + '\n\nBitte manuell als Probetraining/Lead anlegen und den Termin buchen.');
    return { ok: true, via: 'fallback', message: 'Der Probetraining-Wunsch wurde ans Studio übergeben (manuelle Eintragung).' };
  } catch (e) { return { ok: false, message: 'Übermittlung fehlgeschlagen – bitte später erneut.' }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action');
    if (action === 'slots') {
      const bid = url.searchParams.get('bookableId');
      if (!/^\d+$/.test(String(bid || ''))) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_id' })); }
      const days = parseInt(url.searchParams.get('days') || '21', 10);
      const slots = await loadSlots(bid, days);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, slots: slots }));
    }
    // default: offers
    const o = await loadOffers();
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: !!o.available, forbidden: !!o.forbidden, offers: o.offers || [] }));
  }

  if (req.method === 'POST') {
    const body = await M.readBody(req);
    if ((body && body.action) !== 'book') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' })); }
    // sanfte Rate-Limit
    try { const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x'; if (!(await M.rateLimit('team-trial:' + ip, 20, 600))) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Versuche – kurz warten.' })); } } catch (e) {}

    const r = await doBook(body);
    if (r.ok) {
      const msg = r.bookingStatus === 'BOOKED_WITH_CONFIRMATION_REQUIRED'
        ? 'Probetraining eingetragen – das Studio bestätigt den Termin noch.'
        : 'Probetraining verbindlich gebucht! ✓';
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: msg, bookingStatus: r.bookingStatus || null }));
    }
    // Eingabefehler (fehlende Felder) NICHT als Studio-Wunsch verschicken, sondern melden.
    if (r.validation) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: r.message })); }
    // Fallback (Scope fehlt / Buchung nicht möglich) -> Wunsch ans Studio, geht nicht verloren.
    const fb = await bookFallback(body, body.whenText || (body.start ? String(body.start) : ''));
    res.statusCode = 200; return res.end(JSON.stringify(fb));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
