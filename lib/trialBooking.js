'use strict';

/**
 * Probetraining buchen für den WhatsApp-Lead-Agenten (Werkzeug book_trial) – gleiche
 * Regeln wie api/phone/book.js (dort bleiben die Helfer, weil tests/phone-api sie prüft).
 * -----------------------------------------------------------------------------
 * Was Magicline WIRKLICH verlangt (14.08. gegen die Connect-API ausgemessen):
 *   firstname, lastname, email, phone, gender, dateOfBirth und eine Anschrift MIT
 *   Hausnummer. gender nur MALE/FEMALE/UNISEX. note höchstens 300 Zeichen.
 * Das Geburtsdatum wird nie ersetzt (eine erfundene Angabe könnte eine minderjährige
 * Person als volljährig führen). E-Mail und Anschrift bekommen erkennbare Platzhalter.
 *
 * Der Termin MUSS einer der gerade angebotenen Slots sein: sonst legt Magicline den
 * Lead an und antwortet 200 – aber es entsteht KEIN Termin (siehe api/phone/book.js).
 */

const crypto = require('node:crypto');
const C = require('./connect');

const NOTE_MAX = 300;
const DAYPARTS = { morgens: [0, 12], mittags: [12, 17], abends: [17, 24] };

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

// Plus-Adresse auf dem Studio-Postfach (eindeutig je Lead, zustellbar ans Team).
function placeholderEmail(tag) {
  const id = crypto.randomBytes(4).toString('hex');
  const pattern = String(process.env.PHONE_LEAD_EMAIL || '').trim();
  if (pattern && pattern.indexOf('@') > 0) return pattern.replace('{id}', id);
  const box = String(process.env.MAIL_TO || 'info@fit-inn-trier.de').trim();
  const at = box.indexOf('@');
  const t = String(tag || 'tel').replace(/[^a-z]/g, '') || 'tel';
  if (at <= 0) return t + '-' + id + '@fit-inn-trier.de';
  return box.slice(0, at) + '+' + t + '-' + id + box.slice(at);
}

// „1990-05-04", „04.05.1990", „4.5.1990" -> YYYY-MM-DD (sonst '').
function birthDate(v) {
  const t = clean(v, 20);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (d) m = [null, d[3], ('0' + d[2]).slice(-2), ('0' + d[1]).slice(-2)];
  }
  if (!m) return '';
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
  const now = new Date().getFullYear();
  if (!(y >= 1900 && y <= now && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}

const GENDERS = { MALE: 1, FEMALE: 1, UNISEX: 1 };
function genderOf(v) {
  const t = clean(v, 12).toUpperCase();
  if (GENDERS[t]) return t;
  if (/^(M|HERR|MANN|MAENNLICH|MÄNNLICH)$/.test(t)) return 'MALE';
  if (/^(W|F|FRAU|WEIBLICH)$/.test(t)) return 'FEMALE';
  return 'UNISEX';
}

function berlinHour(iso) {
  try { return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)), 10); } catch (e) { return null; }
}
function label(iso) {
  try {
    const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    return p.weekday.replace(/\.$/, '') + ', ' + p.day + '.' + p.month + '. ' + p.hour + ':' + p.minute;
  } catch (e) { return iso; }
}
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

// Rohe Slot-Liste (ISO-Strings, unverändert aus der API) ab `from` für `days` Tage.
async function rawSlots(from, days, trainer) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : ymd(Date.now());
  const end = addDays(start, Math.max(1, Math.min(14, Number(days) || 7)));
  try {
    const sl = await C.getTrialSlots(start, end, C.wantTrainer(trainer));
    if (sl && sl.status === 200 && sl.json && Array.isArray(sl.json.slots)) return sl.json.slots.map((x) => String(x && x.startDateTime || '')).filter(Boolean);
  } catch (e) {}
  return null;
}

// Für den Agenten: höchstens `limit` Slots, optional nach Tageszeit gefiltert, nur Zukunft (+1 h).
async function freeSlots(o) {
  o = o || {};
  const list = await rawSlots(o.from, o.days || 7, o.trainer);
  if (!list) return { ok: false, error: 'unavailable' };
  const dp = DAYPARTS[String(o.daypart || '').toLowerCase()];
  const soon = Date.now() + 60 * 60 * 1000;
  const slots = list.filter((s) => Date.parse(s) > soon).filter((s) => { if (!dp) return true; const h = berlinHour(s); return h != null && h >= dp[0] && h < dp[1]; });
  // Über die Tage verteilen: je Tag höchstens zwei, damit die Auswahl nicht nur „morgen" zeigt.
  const perDay = {}; const picked = [];
  for (const s of slots) { const d = s.slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; if (perDay[d] <= 2) picked.push(s); if (picked.length >= (o.limit || 6)) break; }
  return { ok: true, slots: picked.map((s) => ({ startDateTime: s, label: label(s) })), total: slots.length };
}

/**
 * Buchen. d: { startDateTime, firstname, lastname, dateOfBirth, phone, email?, gender?,
 *              street?, houseNumber?, zip?, city?, trainerRequired?, note? }
 * opts: { source:'whatsapp'|'telefon', emailTag }
 * -> { ok, customerId, customerNumber, startDateTime, emailPlaceholder, addressPlaceholder }
 *  | { ok:false, error:'missing'|'slot_unavailable'|'already_booked'|'booking_failed', missing?, freeSlots? }
 */
async function book(d, opts) {
  d = d || {}; opts = opts || {};
  const firstname = clean(d.firstname, 60), lastname = clean(d.lastname, 60);
  const phone = clean(d.phone, 40);
  const start = clean(d.startDateTime, 40);
  const dob = birthDate(d.dateOfBirth);
  const missing = [];
  if (!firstname) missing.push('Vorname');
  if (!lastname) missing.push('Nachname');
  if (phone.replace(/[^\d]/g, '').length < 6) missing.push('Rufnummer');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) missing.push('Termin');
  if (!dob) missing.push('Geburtsdatum');
  if (missing.length) return { ok: false, error: 'missing', missing: missing };

  const trainer = C.wantTrainer(d.trainerRequired);
  const free = await rawSlots(start.slice(0, 10), 7, trainer);
  let startEff = start;
  if (free && free.indexOf(startEff) < 0) {
    try { const P = require('./phoneApi'); const fixed = P.fixLocalAsUtc(startEff, free); if (fixed) startEff = fixed; } catch (e) {}
  }
  if (!free || free.indexOf(startEff) < 0) {
    return { ok: false, error: 'slot_unavailable', freeSlots: (free || []).filter((s) => Date.parse(s) > Date.now()).slice(0, 4).map((s) => ({ startDateTime: s, label: label(s) })) };
  }

  const given = clean(d.email, 120);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(given);
  const email = emailOk ? given : placeholderEmail(opts.emailTag || (opts.source === 'whatsapp' ? 'wa' : 'tel'));
  const hasAddr = clean(d.street, 80) && clean(d.zip, 12) && clean(d.city, 60);
  const src = opts.source === 'whatsapp' ? 'WhatsApp' : 'Telefon';
  const address = hasAddr
    ? { street: clean(d.street, 80), houseNumber: clean(d.houseNumber, 20) || '-', zip: clean(d.zip, 12), city: clean(d.city, 60) }
    : { street: src + ' erfasst', houseNumber: '-', zip: '54296', city: 'Trier' };
  const flags = []; if (!emailOk) flags.push('E-Mail'); if (!hasAddr) flags.push('Anschrift');
  const note = [
    src === 'WhatsApp' ? 'Per WhatsApp (FINN) gebucht.' : 'Telefonisch per KI-Assistent gebucht.',
    'Rückruf/WhatsApp: ' + phone + '.',
    flags.length ? ('PLATZHALTER: ' + flags.join(' + ') + ' - bitte ersetzen.') : '',
    clean(d.note, 120),
  ].filter(Boolean).join(' ').slice(0, NOTE_MAX);

  let r = null;
  try {
    r = await C.bookTrial({
      firstname: firstname, lastname: lastname, email: email, phone: phone, gender: genderOf(d.gender), dateOfBirth: dob,
      street: address.street, houseNumber: address.houseNumber, zip: address.zip, city: address.city,
      startDateTime: startEff, trainerRequired: trainer, marketing: false, note: note,
    });
  } catch (e) { r = null; }
  if (!r || !r.ok) {
    const detail = String((r && (r.text || (r.json && JSON.stringify(r.json)))) || '');
    if (/TRIALSESSION_ALREADY_BOOKED|already booked a trial/i.test(detail)) return { ok: false, error: 'already_booked' };
    return { ok: false, error: 'booking_failed', status: (r && r.status) || null };
  }
  let customerId = null, customerNumber = null;
  try { const P = require('./phoneApi'); customerId = P.customerIdFrom(r.json); customerNumber = P.customerNumberFrom(r.json); } catch (e) {}
  return { ok: true, customerId: customerId, customerNumber: customerNumber, startDateTime: startEff, label: label(startEff), emailPlaceholder: !emailOk, addressPlaceholder: !hasAddr };
}

module.exports = { placeholderEmail, birthDate, genderOf, clean, label, rawSlots, freeSlots, book, DAYPARTS, NOTE_MAX };
