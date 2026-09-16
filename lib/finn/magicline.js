'use strict';

/**
 * FINN – zentraler Magicline-Tool-Layer (Service-Schicht).
 * -----------------------------------------------------------------------------
 * Die EINZIGE Stelle, über die FINN-Agenten Magicline erreichen. Sie ruft die
 * bestehenden, 403-festen Wrapper (lib/members.js, lib/ml*.js, lib/bookable.js …)
 * und normalisiert deren Ergebnisse auf EIN Format:
 *
 *   { ok, forbidden, status, data, error, via, scope }
 *     via   = 'magicline' | 'mock'
 *     error = kurzer Code ('forbidden' | 'not_found' | 'unavailable' | 'invalid' | …),
 *             nie ein roher Magicline-Text (der bleibt serverseitig)
 *
 * Jeder Aufruf meldet sein Ergebnis an die Capability-Erkennung (403 -> Scope
 * gemerkt). Es werden KEINE neuen Magicline-Endpunkte erfunden: jede Funktion
 * hier ruft eine Funktion, die es im Bestand schon gibt.
 *
 * MAGICLINE_MODE=mock schaltet auf lib/finn/mock.js – nur außerhalb der Produktion.
 */

const Cap = require('./capabilities');
const { isProduction } = require('./util');

function mockOn() { return String(process.env.MAGICLINE_MODE || '').toLowerCase() === 'mock' && !isProduction(); }
function mockRequestedInProd() { return String(process.env.MAGICLINE_MODE || '').toLowerCase() === 'mock' && isProduction(); }
function mock() { return require('./mock'); }

// Lazy-Requires: der Tool-Layer soll auch in Tests ladbar sein, in denen einzelne
// Bestandsmodule per require.cache ersetzt werden.
const M = () => require('../members');
const MC = () => require('../mlCancel');
const MM = () => require('../mlMembership');
const Mod = () => require('../mlModules');
const Acc = () => require('../mlAccount');
const Book = () => require('../bookable');
const Docs = () => require('../mlDocuments');
const AM = () => require('../mlAccessMedium');
const Comm = () => require('../mlComm');
const Hours = () => require('../studioHours');
const Util = () => require('../utilization');

function ok(data, scope) { return { ok: true, forbidden: false, status: 200, data: data, error: null, via: 'magicline', scope: scope || null }; }
function fail(code, r, scope) {
  r = r || {};
  const status = Number(r.status) || 0;
  const forbidden = r.forbidden === true || status === 403 || status === 401;
  return { ok: false, forbidden: forbidden, status: status, data: null, error: forbidden ? 'forbidden' : (code || (status === 404 ? 'not_found' : (status === 0 ? 'unavailable' : 'failed'))), via: 'magicline', scope: scope || null };
}
// Wrapper-Ergebnis {ok|available, forbidden, status} auf das FINN-Format bringen.
async function norm(scope, r, dataFn) {
  await Cap.record(scope, r);
  if (!r) return fail('unavailable', { status: 0 }, scope);
  const good = r.ok === true || r.available === true || (typeof r.status === 'number' && r.status >= 200 && r.status < 300 && r.ok !== false && r.available !== false);
  if (!good) return fail(null, r, scope);
  return ok(dataFn ? dataFn(r) : r, scope);
}
// Aufrufe ohne Netz-Ausnahme: Wrapper werfen normalerweise nicht, aber sicher ist sicher.
async function guard(scope, fn) {
  try { return await fn(); } catch (e) { return fail('unavailable', { status: 0 }, scope); }
}
// Mock-Ergebnis mit Scope-Angabe versehen (Capabilities werden im Mock als ok gemerkt).
async function viaMock(scope, p) { const r = await p; r.scope = scope || null; if (r.ok) await Cap.noteOk(scope); return r; }

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ── Kunde ──
const customer = {
  // Stammdaten (minimiert: kein Bankkonto, IBAN nur maskiert – wie publicProfile).
  async get(id) {
    const scope = 'CUSTOMER_READ';
    if (mockOn()) return viaMock(scope, mock().customer.get(id));
    return guard(scope, async () => {
      const m = await M().getMember(id);
      await Cap.record(scope, { ok: !!m, status: m ? 200 : 404 });
      if (!m) return fail('not_found', { status: 404 }, scope);
      return ok(Object.assign({ id: m.id }, M().publicProfile(m)), scope);
    });
  },
  async updateContact(id, d) {
    const scope = 'CUSTOMER_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().customer.updateContact(id, d));
    return guard(scope, async () => norm(scope, await M().writeContact(id, d || {}), () => ({ updated: true })));
  },
  async updateAddress(id, d) {
    const scope = 'CUSTOMER_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().customer.updateAddress(id, d));
    return guard(scope, async () => norm(scope, await M().writeAddress(id, d || {}), () => ({ updated: true })));
  },
  async updatePayment(id, d) {
    const scope = 'CUSTOMER_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().customer.updatePayment(id, d));
    return guard(scope, async () => norm(scope, await M().writePayment(id, d || {}), () => ({ updated: true })));
  },
};

// ── Vertrag ──
const contract = {
  async get(id) {
    const scope = 'CUSTOMER_READ';
    if (mockOn()) return viaMock(scope, mock().contract.get(id));
    return guard(scope, async () => {
      const c = await M().getContract(id);
      await Cap.record(scope, { ok: !!c, status: c ? 200 : 404 });
      return c ? ok(c, scope) : fail('not_found', { status: 404 }, scope);
    });
  },
  async cancelReasons() {
    const scope = 'MEMBERSHIP_SELF_SERVICE_READ';
    if (mockOn()) return viaMock(scope, mock().contract.cancelReasons());
    return guard(scope, async () => norm(scope, await MC().cancelReasons(), (r) => r.reasons || []));
  },
  // body: { contractId, cancelationReasonId, cancelationDate }
  async cancel(id, body) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    body = body || {};
    if (!body.contractId || body.cancelationReasonId == null || !body.cancelationDate) return fail('invalid', { status: 400 }, scope);
    if (mockOn()) return viaMock(scope, mock().contract.cancel(id, body));
    return guard(scope, async () => norm(scope, await MC().ordinaryCancel(id, body), () => ({ effectiveDate: body.cancelationDate })));
  },
  async withdrawCancel(id, contractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    if (!contractId) return fail('invalid', { status: 400 }, scope);
    if (mockOn()) return viaMock(scope, mock().contract.withdrawCancel(id, contractId));
    return guard(scope, async () => norm(scope, await MC().withdrawCancel(id, contractId), () => ({ withdrawn: true })));
  },
  // 14-Tage-Widerruf (Fernabsatz).
  async withdrawal(id, contractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    if (!contractId) return fail('invalid', { status: 400 }, scope);
    if (mockOn()) return viaMock(scope, mock().contract.withdrawal(id, contractId));
    return guard(scope, async () => norm(scope, await MC().contractWithdrawal(id, contractId), () => ({ reversed: true })));
  },
};

// ── Beitragspause ──
const pause = {
  async config(contractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_READ';
    if (mockOn()) return viaMock(scope, mock().pause.config(contractId));
    return guard(scope, async () => norm(scope, await MM().idleConfig(contractId)));
  },
  async list(contractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_READ';
    if (mockOn()) return viaMock(scope, mock().pause.list(contractId));
    return guard(scope, async () => norm(scope, await MM().idleList(contractId), (r) => ({ current: r.current, past: r.past })));
  },
  async validate(contractId, data) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().pause.validate(contractId, data));
    return guard(scope, async () => norm(scope, await MM().idleValidate(contractId, data), (r) => ({ validationStatus: r.validationStatus, creatable: !!r.creatable })));
  },
  async create(contractId, data, documentB64) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().pause.create(contractId, data));
    return guard(scope, async () => norm(scope, await MM().idleCreate(contractId, data, documentB64), (r) => ({ idlePeriod: r.idlePeriod })));
  },
  async withdraw(contractId, id) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_WRITE';
    if (mockOn()) return viaMock(scope, mock().pause.withdraw(contractId, id));
    return guard(scope, async () => norm(scope, await MM().idleWithdraw(contractId, id), () => ({ withdrawn: true })));
  },
};

// ── Zusatzmodule ──
const modules = {
  async list(contractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ';
    if (mockOn()) return viaMock(scope, mock().modules.list(contractId));
    return guard(scope, async () => norm(scope, await Mod().listModules(contractId), (r) => ({ bookable: r.bookable || [], booked: r.booked || [] })));
  },
  async book(contractId, moduleId, paymentFrequencyId, opts) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE';
    if (mockOn()) return viaMock(scope, mock().modules.book(contractId, moduleId));
    return guard(scope, async () => norm(scope, await Mod().bookModule(contractId, moduleId, paymentFrequencyId, opts), (r) => ({ moduleContractId: r.moduleContractId || r.id || null })));
  },
  async cancel(contractId, moduleContractId, opts) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE';
    if (mockOn()) return viaMock(scope, mock().modules.cancel(contractId, moduleContractId, opts));
    return guard(scope, async () => norm(scope, await Mod().cancelModule(contractId, moduleContractId, opts), (r) => ({ cancelled: true, endDate: r.endDate || r.until || null })));
  },
  async contract(contractId, moduleContractId) {
    const scope = 'MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_CONTRACT_READ';
    if (mockOn()) return viaMock(scope, mock().modules.contract(contractId, moduleContractId));
    return guard(scope, async () => norm(scope, await Mod().getModuleContract(contractId, moduleContractId), (r) => r.contract));
  },
};

// ── Beitragskonto ──
const account = {
  async summary(id) {
    const scope = 'CUSTOMER_ACCOUNT_READ';
    if (mockOn()) return viaMock(scope, mock().account.summary(id));
    return guard(scope, async () => norm(scope, await Acc().accountSummary(id)));
  },
};

// ── Termine ──
function isCancelled(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true) return true;
  return /CANCEL|STORN/i.test(String(a.status || a.bookingStatus || ''));
}
const appointments = {
  async types() {
    const scope = 'BOOKABLE_APPOINTMENTS_READ';
    if (mockOn()) return viaMock(scope, mock().appointments.types());
    return guard(scope, async () => {
      const list = await Book().listTypes();
      await Cap.record(scope, { ok: Array.isArray(list) && list.length > 0, status: list && list.length ? 200 : 0 });
      return ok(Array.isArray(list) ? list : [], scope);
    });
  },
  async slots(typeId, customerId, startYMD, days) {
    const scope = 'BOOKABLE_APPOINTMENTS_READ';
    if (mockOn()) return viaMock(scope, mock().appointments.slots(typeId, customerId, startYMD, days));
    return guard(scope, async () => ok(await Book().freeSlots(typeId, customerId, startYMD, days), scope));
  },
  // Gebuchte Termine des Kunden (nur kommende, nicht stornierte).
  async mine(customerId) {
    const scope = 'APPOINTMENTS_READ';
    if (mockOn()) return viaMock(scope, mock().appointments.mine(customerId));
    return guard(scope, async () => {
      const r = await M().ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(customerId));
      await Cap.record(scope, r);
      if (r.status !== 200 || !Array.isArray(r.json)) return fail(null, r, scope);
      const list = r.json.filter((a) => a && !isCancelled(a)).map((a) => ({
        bookingId: a.bookingId != null ? a.bookingId : a.id, title: a.title || a.name || 'Termin',
        start: a.startDateTime || null, end: a.endDateTime || null, status: a.bookingStatus || a.status || null,
      }));
      return ok(list, scope);
    });
  },
  async book(customerId, typeId, slot) {
    const scope = 'APPOINTMENTS_WRITE';
    if (!slot || !slot.start) return fail('invalid', { status: 400 }, scope);
    if (mockOn()) return viaMock(scope, mock().appointments.book(customerId, typeId, slot));
    return guard(scope, async () => norm(scope, await Book().book(customerId, typeId, slot), (r) => ({ bookingStatus: r.bookingStatus || null, start: slot.start })));
  },
  // Storno mit Eigentumsprüfung (wie api/member/appointment-cancel.js).
  async cancel(customerId, bookingId) {
    const scope = 'APPOINTMENTS_WRITE';
    if (!bookingId) return fail('invalid', { status: 400 }, scope);
    if (mockOn()) return viaMock(scope, mock().appointments.cancel(customerId, bookingId));
    return guard(scope, async () => {
      const mine = await appointments.mine(customerId);
      if (!mine.ok) return fail('verify_failed', { status: mine.status }, scope);
      if (!mine.data.some((a) => String(a.bookingId) === String(bookingId))) return fail('not_your_booking', { status: 404 }, scope);
      const r = await M().ml('DELETE', '/appointments/booking/' + encodeURIComponent(bookingId));
      return norm(scope, r, () => ({ cancelled: true }));
    });
  },
};

// ── Check-ins ──
const checkins = {
  async recent(id, opts) {
    const scope = 'CHECKIN_READ';
    if (mockOn()) return viaMock(scope, mock().checkins.recent(id));
    return guard(scope, async () => {
      const list = await M().recentCheckins(id, opts || { windows: 1 });
      await Cap.record(scope, { ok: Array.isArray(list), status: Array.isArray(list) ? 200 : 0 });
      return ok(Array.isArray(list) ? list : [], scope);
    });
  },
  async checkin(id) {
    const scope = 'CHECKIN_WRITE';
    if (mockOn()) return viaMock(scope, mock().checkins.checkin(id));
    return guard(scope, async () => norm(scope, await M().checkinCustomer(id), () => ({ checkedIn: true })));
  },
  async checkout(id) {
    const scope = 'CHECKIN_WRITE';
    if (mockOn()) return viaMock(scope, mock().checkins.checkout(id));
    return guard(scope, async () => norm(scope, await M().checkoutCustomer(id), () => ({ checkedOut: true })));
  },
};

// ── Dokumente ──
const documents = {
  async list(id) {
    const scope = 'CUSTOMER_DOCUMENT_READ';
    if (mockOn()) return viaMock(scope, mock().documents.list(id));
    return guard(scope, async () => norm(scope, await Docs().listDocuments(id), (r) => ({ available: true, items: r.items || [] })));
  },
  async upload(id, doc) {
    const scope = 'CUSTOMER_DOCUMENT_WRITE';
    if (mockOn()) return viaMock(scope, mock().documents.upload(id, doc));
    return guard(scope, async () => norm(scope, await Docs().uploadDocument(id, doc)));
  },
};

// ── Zugangsmedien ──
const access = {
  async list(id) {
    const scope = 'CUSTOMER_ACCESS_MEDIUM_READ';
    if (mockOn()) return viaMock(scope, mock().access.list(id));
    return guard(scope, async () => norm(scope, await AM().listAccessMedia(id), (r) => ({ available: true, items: r.items || r.media || [] })));
  },
  async block(id, mid) {
    const scope = 'CUSTOMER_ACCESS_MEDIUM_WRITE';
    if (mockOn()) return viaMock(scope, mock().access.block(id, mid));
    return guard(scope, async () => norm(scope, await AM().blockAccessMedium(id, mid), () => ({ blocked: true })));
  },
  async unblock(id, mid) {
    const scope = 'CUSTOMER_ACCESS_MEDIUM_WRITE';
    if (mockOn()) return viaMock(scope, mock().access.unblock(id, mid));
    return guard(scope, async () => norm(scope, await AM().unblockAccessMedium(id, mid), () => ({ unblocked: true })));
  },
};

// ── Kommunikations-Einwilligungen ──
const comm = {
  async get(id) {
    const scope = 'COMMUNICATION_PREFERENCES_READ';
    if (mockOn()) return viaMock(scope, mock().comm.get(id));
    return guard(scope, async () => norm(scope, await Comm().getCommPrefs(id), (r) => ({ available: true, prefs: r.prefs || {} })));
  },
  async set(id, patch) {
    const scope = 'COMMUNICATION_PREFERENCES_WRITE';
    if (mockOn()) return viaMock(scope, mock().comm.set(id, patch));
    return guard(scope, async () => norm(scope, await Comm().setCommPrefs(id, patch || {}), (r) => ({ available: true, prefs: r.prefs || patch || {} })));
  },
};

// ── Studio ──
const studio = {
  async hours() {
    const scope = 'STUDIO_READ';
    if (mockOn()) return viaMock(scope, mock().studio.hours());
    return guard(scope, async () => norm(scope, await Hours().fetchHours()));
  },
  async utilization() {
    const scope = 'STUDIO_READ';
    if (mockOn()) return viaMock(scope, mock().studio.utilization());
    return guard(scope, async () => {
      const u = await Util().fetchUtilization();
      return u ? ok(u, scope) : fail('unavailable', { status: 0 }, scope);
    });
  },
};

// ── Leads ──
const leads = {
  async create(d) {
    const scope = 'LEAD_WRITE';
    if (mockOn()) return viaMock(scope, mock().leads.create(d));
    return guard(scope, async () => norm(scope, await M().createLead(d), (r) => ({ leadId: (r.json && (r.json.id || r.json.leadId)) || null })));
  },
  async config() {
    const scope = 'LEAD_READ';
    if (mockOn()) return viaMock(scope, mock().leads.config());
    return guard(scope, async () => { const c = await M().getLeadConfig(); await Cap.record(scope, { ok: !!c, status: c ? 200 : 0 }); return c ? ok(c, scope) : fail('unavailable', { status: 0 }, scope); });
  },
};

module.exports = {
  mockOn, mockRequestedInProd, ok, fail, num,
  customer, contract, pause, modules, account, appointments, checkins, documents, access, comm, studio, leads,
};
