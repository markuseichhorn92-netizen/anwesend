'use strict';

/**
 * Magicline-Buchungsdetails für den Termin-Feed (Magicline-Kalender im Familien-Hub).
 * -----------------------------------------------------------------------------
 * GET /appointments/booking/{bookingId} (Scope APPOINTMENTS_READ) liefert u. a.
 * instructors[{id,firstName,lastName,publicName}], customerId, title, category,
 * startDateTime, endDateTime, bookingStatus, appointmentStatus, participantStatus.
 * Daraus speichern wir NUR: instructorIds, category, Status und – datensparsam –
 * den Mitgliedsnamen als „Vorname N.“ (lib/members.getMember, ein Abruf je Termin).
 *
 * MAGICLINE_MODE=mock (nur außerhalb der Produktion) liefert feste Testdaten ohne Netz.
 * Wirft NIE.
 */

const M = require('./members');
const MlEvents = require('./mlEvents');

function isProduction() { try { return require('./finn/util').isProduction(); } catch (e) { return process.env.VERCEL_ENV === 'production'; } }
function mockOn() { return String(process.env.MAGICLINE_MODE || '').toLowerCase() === 'mock' && !isProduction(); }

function s(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 80); }

// „Vorname N.“ – nie den vollen Nachnamen weitergeben.
function shortName(first, last) {
  const f = s(first, 30).split(' ')[0] || '';
  const l = s(last, 30);
  const ini = l ? (l[0].toUpperCase() + '.') : '';
  return (f + (ini ? ' ' + ini : '')).trim() || null;
}

// Stornierte/abgesagte Buchung? (Status-Felder aus dem Detail bzw. Feed-Eintrag)
function isCancelled(a) {
  if (!a) return true;
  const st = [a.bookingStatus, a.appointmentStatus, a.status].filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN/.test(st);
}

function mockDetail(id) {
  return { bookingId: Number(id) || id, bookingStatus: 'BOOKED', appointmentStatus: 'PLANNED', participantStatus: 'UNSET',
    startDateTime: '2026-11-02T10:00:00+01:00', endDateTime: '2026-11-02T11:00:00+01:00', title: 'Probetraining', category: 'Fitness',
    instructors: [{ id: 1001, firstName: 'Mock', lastName: 'Trainer', publicName: 'Mock' }], customerId: 4711 };
}

// Detail einer Buchung normalisiert. { ok, status, data } – data null bei Fehler/403/404.
async function bookingDetail(bookingId) {
  const id = s(bookingId, 40);
  if (!/^\d{1,20}$/.test(id)) return { ok: false, status: 400, data: null };
  let r;
  try { r = mockOn() ? { status: 200, json: mockDetail(id) } : await M.ml('GET', '/appointments/booking/' + encodeURIComponent(id)); }
  catch (e) { return { ok: false, status: 0, data: null }; }
  const j = r && r.json;
  if (!r || r.status !== 200 || !j || Array.isArray(j) || typeof j !== 'object' || !j.startDateTime) return { ok: false, status: (r && r.status) || 0, data: null };
  const ins = Array.isArray(j.instructors) ? j.instructors : [];
  return { ok: true, status: 200, data: {
    bookingId: id,
    title: s(j.title, 80) || null,
    category: s(j.category, 60) || null,
    start: s(j.startDateTime, 40),
    end: s(j.endDateTime, 40) || null,
    customerId: j.customerId != null ? s(j.customerId, 40) : null,
    instructorIds: ins.map((i) => (i && i.id != null ? s(i.id, 30) : '')).filter(Boolean),
    bookingStatus: s(j.bookingStatus, 40) || null,
    appointmentStatus: s(j.appointmentStatus, 40) || null,
  } };
}

async function memberShortName(customerId) {
  if (customerId == null || customerId === '') return null;
  if (mockOn()) return 'Max M.';
  try { const m = await M.getMember(customerId); return m ? shortName(m.firstName, m.lastName) : null; } catch (e) { return null; }
}

// Feed-Eintrag mit Details anreichern und zurückschreiben. Klappt das Detail nicht, bleibt der
// Eintrag unverändert (nächster Versuch beim nächsten Abruf). Liefert den neuen Eintrag oder null.
async function enrich(appt, opts) {
  opts = opts || {};
  if (!appt || appt.bookingId == null) return null;
  const d = await bookingDetail(appt.bookingId);
  if (!d.ok) return null;
  const x = d.data;
  const cid = x.customerId || appt.customerId || null;
  const name = appt.memberName || (opts.name === false ? null : await memberShortName(cid));
  const rec = {
    bookingId: x.bookingId, title: x.title || appt.title || 'Termin', start: x.start || appt.start, end: x.end || appt.end || null,
    customerId: cid, memberName: name, instructorIds: x.instructorIds, category: x.category,
    bookingStatus: x.bookingStatus, appointmentStatus: x.appointmentStatus, detailAt: Date.now(),
  };
  const ok = await MlEvents.upsertAppointment(rec);
  return ok ? Object.assign({}, appt, rec) : null;
}

// Mehrere Einträge mit begrenzter Parallelität anreichern (Magicline schonen).
async function enrichMany(list, max, parallel) {
  const todo = (list || []).slice(0, Math.max(0, max || 0));
  const out = new Map();
  const p = Math.max(1, Math.min(6, parallel || 4));
  let i = 0;
  async function worker() { while (i < todo.length) { const a = todo[i++]; const r = await enrich(a); if (r) out.set(String(a.bookingId), r); } }
  await Promise.all(Array.from({ length: Math.min(p, todo.length) }, worker));
  return out;
}

module.exports = { bookingDetail, enrich, enrichMany, memberShortName, shortName, isCancelled, mockOn };
