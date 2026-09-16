'use strict';

/**
 * FINN – Magicline-Mock (MAGICLINE_MODE=mock).
 * -----------------------------------------------------------------------------
 * Fixtures für Tests und lokale Entwicklung. Kein Netz, keine echten Daten.
 * Schreibende Aktionen verändern nur diesen In-Memory-Zustand, damit Tests die
 * Ergebnisvalidierung („Vertrag steht danach auf gekündigt") prüfen können.
 * In Produktion ist der Mock unwirksam (lib/finn/magicline.js prüft das).
 *
 * Namen sind erkennbar erfunden („Test") und tauchen nur im Mock-Modus auf.
 */

function iso(daysAhead, hour) {
  const d = new Date(Date.now() + (daysAhead || 0) * 86400000);
  d.setUTCHours(hour == null ? 9 : hour, 0, 0, 0);
  return d.toISOString();
}
function ymd(daysAhead) { return new Date(Date.now() + (daysAhead || 0) * 86400000).toISOString().slice(0, 10); }

function fresh() {
  return {
    customers: {
      '1001': { id: 1001, customerNumber: '10001', firstName: 'Test', lastName: 'Mitglied', email: 'test-mitglied@example.invalid', phonePrivate: '+49 651 0000000', street: 'Musterweg', houseNumber: '1', zipCode: '54290', city: 'Trier', dateOfBirth: '1990-05-04' },
    },
    contracts: {
      '1001': { contractId: 5001, rateName: 'Flex 12', active: true, cancelled: false, cancellationDate: null, reversed: false, startDate: '01.02.2026', endDate: '31.01.2027', endDateISO: '2027-01-31', cancellationPeriod: '4 Wochen', nextCancellationDate: '31.01.2027', nextCancellationDateISO: '2027-01-31', withdrawalEligible: false, withdrawalDeadline: null, weeklyPrice: 12 },
    },
    accounts: { '1001': { available: true, balance: 0, currency: 'EUR', dunningLevel: null, inDebtCollection: false, openTotal: 0, openCount: 0 } },
    bookings: { '1001': [{ bookingId: 9001, title: 'Einführungstraining', startDateTime: iso(3, 10), endDateTime: iso(3, 11), bookingStatus: 'BOOKED' }] },
    types: [{ id: '301', title: 'Stoffwechselanalyse', duration: 30, category: '' }, { id: '302', title: 'Einführungstraining', duration: 60, category: '' }],
    checkins: { '1001': [{ in: iso(-2, 17), out: iso(-2, 18) }, { in: iso(-6, 8), out: iso(-6, 9) }] },
    idle: { '5001': { config: { available: true, temporalUnit: 'WEEK', maxTerms: 8, firstPossibleStartDate: ymd(7), unlimitedAllowed: false, fee: { amount: 0, currency: 'EUR' }, reasons: [{ id: 1, name: 'Krankheit', documentRequired: true }, { id: 2, name: 'Urlaub', documentRequired: false }] }, list: [] } },
    modules: { '5001': { bookable: [{ id: '701', name: 'Getränkeflat', price: '9,90 €', paymentFrequencyId: 1, laufzeit: '1 Monat', kuendigung: 'zum jeweiligen Laufzeitende', verlaengerung: 'verlängert sich automatisch um 1 Monat, wenn nicht gekündigt' }], contracts: {} } },
    documents: { '1001': [{ id: 'd1', name: 'Mitgliedsvertrag.pdf', date: '2026-02-01', type: 'application/pdf' }] },
    access: { '1001': [{ id: 'm1', label: '4711', type: 'Chip', status: 'aktiv' }] },
    comm: { '1001': { available: true, prefs: { email: true, phone: false, post: false, sms: false } } },
    hours: { available: true, studioName: 'Fit-Inn Trier (Mock)', openingHours: [{ dayOfWeek: 'MONDAY', from: '06:00', to: '22:00' }] },
    cancelReasons: [{ id: 11, name: 'Umzug' }, { id: 12, name: 'Zeitmangel' }, { id: 13, name: 'Sonstiges' }],
    leads: [],
    seq: 9100,
  };
}

let S = fresh();
function reset() { S = fresh(); }
function state() { return S; }

const ok = (data) => ({ ok: true, forbidden: false, status: 200, data: data, error: null, via: 'mock' });
const notFound = () => ({ ok: false, forbidden: false, status: 404, data: null, error: 'not_found', via: 'mock' });

const customer = {
  async get(id) { const c = S.customers[String(id)]; return c ? ok(Object.assign({}, c)) : notFound(); },
  async updateContact(id, d) { const c = S.customers[String(id)]; if (!c) return notFound(); if (d.email) c.email = d.email; if (d.phone) c.phonePrivate = d.phone; return ok({ updated: true }); },
  async updateAddress(id, d) { const c = S.customers[String(id)]; if (!c) return notFound(); Object.assign(c, { street: d.street, houseNumber: d.houseNumber, zipCode: d.zipCode, city: d.city }); return ok({ updated: true }); },
  async updatePayment(id) { return S.customers[String(id)] ? ok({ updated: true }) : notFound(); },
};
const contract = {
  async get(id) { const c = S.contracts[String(id)]; return c ? ok(Object.assign({}, c)) : notFound(); },
  async cancelReasons() { return ok(S.cancelReasons.slice()); },
  async cancel(id, body) {
    const c = S.contracts[String(id)]; if (!c) return notFound();
    if (String(c.contractId) !== String(body.contractId)) return { ok: false, forbidden: false, status: 400, data: null, error: 'wrong_contract', via: 'mock' };
    c.cancelled = true; c.cancellationDate = body.cancelationDate; return ok({ effectiveDate: body.cancelationDate });
  },
  async withdrawCancel(id, contractId) { const c = S.contracts[String(id)]; if (!c || String(c.contractId) !== String(contractId)) return notFound(); c.cancelled = false; c.cancellationDate = null; return ok({ withdrawn: true }); },
  async withdrawal(id, contractId) { const c = S.contracts[String(id)]; if (!c || String(c.contractId) !== String(contractId)) return notFound(); c.reversed = true; c.active = false; return ok({ reversed: true }); },
};
const pause = {
  async config(contractId) { const p = S.idle[String(contractId)]; return p ? ok(p.config) : notFound(); },
  async list(contractId) { const p = S.idle[String(contractId)]; return p ? ok({ current: p.list.slice(), past: [] }) : notFound(); },
  async validate(contractId, data) { const p = S.idle[String(contractId)]; if (!p) return notFound(); return ok({ validationStatus: 'IDLEPERIOD_CREATABLE', creatable: !!data.startDate }); },
  async create(contractId, data) {
    const p = S.idle[String(contractId)]; if (!p) return notFound();
    const per = { id: ++S.seq, startDate: data.startDate, endDate: data.endDate || null, unlimited: !!data.unlimited, state: 'ACCEPTED', reasonId: data.reasonId };
    p.list.push(per); return ok({ idlePeriod: per });
  },
  async withdraw(contractId, id) { const p = S.idle[String(contractId)]; if (!p) return notFound(); p.list = p.list.filter((x) => String(x.id) !== String(id)); return ok({ withdrawn: true }); },
};
const modules = {
  async list(contractId) { const m = S.modules[String(contractId)]; return m ? ok({ bookable: m.bookable.slice(), booked: Object.values(m.contracts) }) : notFound(); },
  async book(contractId, moduleId) {
    const m = S.modules[String(contractId)]; if (!m) return notFound();
    const b = m.bookable.find((x) => String(x.id) === String(moduleId)); if (!b) return notFound();
    const id = ++S.seq; m.contracts[id] = { id: id, name: b.name, price: b.price, cancelled: false }; return ok({ moduleContractId: id, name: b.name });
  },
  async cancel(contractId, moduleContractId, opts) { const m = S.modules[String(contractId)]; const c = m && m.contracts[String(moduleContractId)]; if (!c) return notFound(); c.cancelled = true; c.endDate = (opts && opts.cancelationDate) || null; return ok({ cancelled: true, endDate: c.endDate }); },
  async contract(contractId, moduleContractId) { const m = S.modules[String(contractId)]; const c = m && m.contracts[String(moduleContractId)]; return c ? ok(Object.assign({}, c)) : notFound(); },
};
const account = { async summary(id) { const a = S.accounts[String(id)]; return a ? ok(Object.assign({}, a)) : notFound(); } };
const appointments = {
  async types() { return ok(S.types.slice()); },
  async slots(typeId, customerId, startYMD, days) {
    const t = S.types.find((x) => String(x.id) === String(typeId)); if (!t) return notFound();
    const out = []; for (let d = 1; d <= Math.min(days || 7, 7); d++) out.push({ start: iso(d, 10), end: iso(d, 11), instructorIds: [], instructor: '' });
    return ok(out);
  },
  async mine(customerId) { const l = S.bookings[String(customerId)]; return l ? ok(l.map((b) => ({ bookingId: b.bookingId, title: b.title, start: b.startDateTime, end: b.endDateTime, status: b.bookingStatus }))) : notFound(); },
  async book(customerId, typeId, slot) {
    const t = S.types.find((x) => String(x.id) === String(typeId)); if (!t) return notFound();
    const b = { bookingId: ++S.seq, title: t.title, startDateTime: slot.start, endDateTime: slot.end || slot.start, bookingStatus: 'BOOKED' };
    (S.bookings[String(customerId)] = S.bookings[String(customerId)] || []).push(b);
    return ok({ bookingId: b.bookingId, bookingStatus: 'BOOKED', title: t.title, start: b.startDateTime });
  },
  async cancel(customerId, bookingId) {
    const l = S.bookings[String(customerId)] || []; const i = l.findIndex((b) => String(b.bookingId) === String(bookingId));
    if (i < 0) return { ok: false, forbidden: false, status: 403, data: null, error: 'not_your_booking', via: 'mock' };
    l.splice(i, 1); return ok({ cancelled: true });
  },
};
const checkins = {
  async recent(id) { const l = S.checkins[String(id)]; return l ? ok(l.slice()) : notFound(); },
  async checkin(id) { if (!S.customers[String(id)]) return notFound(); (S.checkins[String(id)] = S.checkins[String(id)] || []).unshift({ in: new Date().toISOString(), out: null }); return ok({ checkedIn: true }); },
  async checkout(id) { const l = S.checkins[String(id)]; if (!l || !l[0]) return notFound(); l[0].out = new Date().toISOString(); return ok({ checkedOut: true }); },
};
const documents = {
  async list(id) { const l = S.documents[String(id)]; return l ? ok({ available: true, items: l.slice() }) : notFound(); },
  async upload(id, doc) { if (!S.customers[String(id)]) return notFound(); const d = { id: 'd' + (++S.seq), name: doc.fileName || 'Dokument', date: ymd(0) }; (S.documents[String(id)] = S.documents[String(id)] || []).push(d); return ok(d); },
};
const access = {
  async list(id) { const l = S.access[String(id)]; return l ? ok({ available: true, items: l.slice() }) : notFound(); },
  async block(id, mid) { const m = (S.access[String(id)] || []).find((x) => String(x.id) === String(mid)); if (!m) return notFound(); m.status = 'gesperrt'; return ok({ blocked: true }); },
  async unblock(id, mid) { const m = (S.access[String(id)] || []).find((x) => String(x.id) === String(mid)); if (!m) return notFound(); m.status = 'aktiv'; return ok({ unblocked: true }); },
};
const comm = {
  async get(id) { const c = S.comm[String(id)]; return c ? ok(Object.assign({}, c)) : notFound(); },
  async set(id, patch) { const c = S.comm[String(id)]; if (!c) return notFound(); Object.assign(c.prefs, patch || {}); return ok(Object.assign({}, c)); },
};
const studio = {
  async hours() { return ok(Object.assign({}, S.hours)); },
  async utilization() { return ok({ available: true, count: 23, max: 120, level: 'green' }); },
};
const leads = {
  async create(d) { const l = { id: ++S.seq, firstname: d.firstname, lastname: d.lastname, email: d.email }; S.leads.push(l); return ok({ leadId: l.id }); },
  async config() { return ok({ requiredFields: ['firstname', 'lastname', 'email'] }); },
};

module.exports = { reset, state, customer, contract, pause, modules, account, appointments, checkins, documents, access, comm, studio, leads };
