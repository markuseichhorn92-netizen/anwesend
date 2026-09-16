'use strict';
// FINN Tool-Layer, Capability-Erkennung, Bestätigungs-Engine (Mock-Modus, kein Netz).
//  - Kunde / Vertrag / Zahlung / Termine über den Tool-Layer
//  - 403 wird gemerkt und blendet Werkzeuge aus; MEMBER_LIST_READ wird nie angenommen
//  - LOW läuft sofort, MEDIUM/HIGH nur nach Bestätigung, HIGH mit Ergebnisprüfung
//  - Mitglieder-Kanal ignoriert fremde customerId; Agenten sehen nur ihre Werkzeuge
//  - Fail-closed ohne Speicher in Produktion
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
process.env.MAGICLINE_MODE = 'mock';
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.STORAGE_REST_API_URL;
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
delete process.env.ML_SCOPES;
// Kein einziger Netzaufruf darf passieren.
global.fetch = async function () { throw new Error('NETZ VERBOTEN im Mock-Test'); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const ML = require(path.join(ROOT, 'lib/finn/magicline.js'));
const Cap = require(path.join(ROOT, 'lib/finn/capabilities.js'));
const Tools = require(path.join(ROOT, 'lib/finn/tools.js'));
const Confirm = require(path.join(ROOT, 'lib/finn/confirm.js'));
const Audit = require(path.join(ROOT, 'lib/finn/audit.js'));
const Timeline = require(path.join(ROOT, 'lib/finn/timeline.js'));
const Mock = require(path.join(ROOT, 'lib/finn/mock.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));

const member = { actor: { kind: 'member', id: '1001' }, channel: 'web', securityScope: 'member', traceId: 't1' };
const other = { actor: { kind: 'member', id: '2002' }, channel: 'web', securityScope: 'member', traceId: 't2' };

(async function () {
  // ── 1. Kunde / Vertrag / Zahlung / Termine über den Tool-Layer ──
  ok('1. Mock-Modus aktiv, KV im Speicher', ML.mockOn() && KV.mode() === 'memory', KV.mode());
  const c = await ML.customer.get('1001');
  ok('1a. Kunde lesen (via mock, IBAN nie im Klartext)', c.ok && c.via === 'mock' && c.data.firstName === 'Test' && !JSON.stringify(c.data).match(/DE[0-9]{2}[0-9]{6,}/), JSON.stringify(c).slice(0, 200));
  const ct = await ML.contract.get('1001');
  ok('1b. Vertrag lesen', ct.ok && ct.data.rateName === 'Flex 12' && ct.data.cancelled === false);
  const acc = await ML.account.summary('1001');
  ok('1c. Beitragskonto lesen', acc.ok && acc.data.available === true && acc.data.openTotal === 0);
  const ap = await ML.appointments.mine('1001');
  ok('1d. Termine lesen', ap.ok && ap.data.length === 1 && ap.data[0].title === 'Einführungstraining');
  const nf = await ML.contract.get('7777');
  ok('1e. Unbekannter Kunde -> not_found, kein Wurf', !nf.ok && nf.error === 'not_found');
  const inv = await ML.contract.cancel('1001', { contractId: 5001 });
  ok('1f. Kündigung ohne Pflichtfelder -> invalid (nichts passiert)', !inv.ok && inv.error === 'invalid' && (await ML.contract.get('1001')).data.cancelled === false);

  // ── 2. Capability-Erkennung ──
  Cap._reset();
  ok('2. Unbekannter Scope darf probiert werden', await Cap.can('APPOINTMENTS_WRITE'));
  ok('2a. MEMBER_LIST_READ wird nie angenommen', !(await Cap.can('MEMBER_LIST_READ')));
  process.env.ML_SCOPES = 'MEMBER_LIST_READ';
  ok('2b. … außer deklariert (und nicht verboten)', await Cap.can('MEMBER_LIST_READ'));
  delete process.env.ML_SCOPES;
  await Cap.record('APPOINTMENTS_WRITE', { ok: false, forbidden: true, status: 403 });
  ok('2c. 403 gemerkt -> can=false', !(await Cap.can('APPOINTMENTS_WRITE')));
  const st = await Cap.status();
  const aw = st.find((x) => x.scope === 'APPOINTMENTS_WRITE'), cr = st.find((x) => x.scope === 'CUSTOMER_READ');
  ok('2d. Statusseite: rot für verboten, grün für gesehen', aw && aw.light === 'red' && cr && cr.light === 'green', JSON.stringify({ aw: aw && aw.light, cr: cr && cr.light }));
  const defs = await Tools.toolsFor(Object.assign({}, member, { agent: 'appointment' }));
  ok('2e. Verbotene Werkzeuge werden dem Modell nicht angeboten', defs.some((t) => t.name === 'find_appointment_slots') && !defs.some((t) => t.name === 'book_appointment'), defs.map((t) => t.name).join(','));
  const ex = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'book_appointment', { typeId: '301', start: new Date().toISOString() }, { confirmed: true });
  ok('2f. Ausführung trotz Modellwunsch -> forbidden', !ex.ok && ex.forbidden === true && ex.error === 'forbidden');
  Cap._reset(); await KV.del('finncap:APPOINTMENTS_WRITE');

  // ── 3. Risiko-Stufen ──
  const low = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'get_contract', { customerId: '9999' });
  ok('3. LOW läuft sofort; fremde customerId im Mitglieder-Kanal ignoriert', low.ok && String(low.data.contractId) === '5001');
  const med = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'book_appointment', { typeId: '301', start: '2030-01-01T09:00:00.000Z', end: '2030-01-01T10:00:00.000Z', title: 'Stoffwechselanalyse' });
  ok('3a. MEDIUM ohne Bestätigung -> needsConfirm mit Vorschau', med.needsConfirm === true && med.risk === 'MEDIUM' && /Stoffwechselanalyse/.test(med.preview) && (await ML.appointments.mine('1001')).data.length === 1, JSON.stringify(med).slice(0, 200));
  const high = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'cancel_contract', { contractId: '5001', cancelationReasonId: '11', cancelationDate: '2027-01-31' });
  ok('3b. HIGH ohne Bestätigung -> needsConfirm, Vertrag unverändert', high.needsConfirm === true && high.risk === 'HIGH' && (await ML.contract.get('1001')).data.cancelled === false);
  const early = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'cancel_contract', { contractId: '5001', cancelationReasonId: '11', cancelationDate: '2026-10-01' }, { confirmed: true });
  ok('3c. Zu frühes Datum wird gegen den echten Vertrag geprüft -> invalid_date', !early.ok && early.error === 'invalid_date' && (await ML.contract.get('1001')).data.cancelled === false);
  const wrongC = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'cancel_contract', { contractId: '4242', cancelationReasonId: '11', cancelationDate: '2027-01-31' }, { confirmed: true });
  ok('3d. Fremde Vertrags-Id -> invalid', !wrongC.ok && wrongC.error === 'invalid');
  const notAllowed = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'cancel_contract', { contractId: '5001', cancelationReasonId: '11', cancelationDate: '2027-01-31' }, { confirmed: true });
  ok('3e. Termin-Agent darf keinen Vertrag kündigen', !notAllowed.ok && notAllowed.error === 'not_allowed');
  const badSchema = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'book_appointment', { start: '2030-01-01T09:00:00.000Z' });
  ok('3f. Fehlendes Pflichtfeld -> invalid', !badSchema.ok && badSchema.error === 'invalid' && badSchema.detail === 'missing_typeId');
  const teamOnly = await Tools.execute(Object.assign({}, member, { agent: 'access' }), 'unblock_access_medium', { mediumId: 'm1' }, { confirmed: true });
  ok('3g. Team-Werkzeug für Mitglied gesperrt', !teamOnly.ok && teamOnly.error === 'not_allowed');
  const pay = await Tools.execute(Object.assign({}, member, { agent: 'payment' }), 'update_payment', { accountHolder: 'Test Mitglied', iban: 'DE02 1203 0000 0000 2020 51' });
  ok('3h. Bankdaten: HIGH, IBAN in der Vorschau maskiert', pay.needsConfirm && pay.risk === 'HIGH' && /DE02…2051/.test(pay.preview) && !/1203/.test(pay.preview), pay.preview);
  const badIban = await Tools.execute(Object.assign({}, member, { agent: 'payment' }), 'update_payment', { accountHolder: 'X', iban: 'ABC' }, { confirmed: true });
  ok('3i. Ungültige IBAN -> invalid, nichts geschrieben', !badIban.ok && badIban.error === 'invalid');

  // ── 4. Bestätigungs-Engine ──
  const p = await Confirm.propose(Object.assign({}, member, { agent: 'contract' }), 'cancel_contract', high.args, high.preview, 'HIGH');
  ok('4. Vorschlag ausgestellt', p.ok && p.id && p.risk === 'HIGH');
  const mis = await Confirm.confirm(other, p.id);
  ok('4a. Fremder Aktor kann nicht bestätigen', !mis.ok && mis.error === 'confirm_mismatch' && (await ML.contract.get('1001')).data.cancelled === false);
  const dec = await Confirm.decline(member, p.id);
  ok('4b. Ablehnen -> nichts passiert', dec.ok && (await ML.contract.get('1001')).data.cancelled === false);
  const again = await Confirm.confirm(member, p.id);
  ok('4c. Abgelehnter Vorschlag nicht mehr einlösbar', !again.ok && again.error === 'confirm_expired');
  const p2 = await Confirm.propose(Object.assign({}, member, { agent: 'contract' }), 'cancel_contract', high.args, high.preview, 'HIGH');
  const done = await Confirm.confirm(member, p2.id);
  ok('4d. Bestätigt -> ausgeführt UND nachgeprüft', done.ok && done.validated && done.validated.ok === true && (await ML.contract.get('1001')).data.cancelled === true, JSON.stringify(done).slice(0, 200));
  const twice = await Confirm.confirm(member, p2.id);
  ok('4e. Einmal einlösbar', !twice.ok);
  const tl = await Timeline.list('1001');
  ok('4f. Timeline-Eintrag mit Prüfung', tl.length >= 1 && tl[0].kind === 'action' && /bestätigt/.test(tl[0].detail || ''), JSON.stringify(tl[0]));
  const aud = await Audit.list({ customerId: '1001' });
  ok('4g. Audit ohne Freitext, mit Status/Risiko', aud.length >= 3 && aud.every((a) => !('args' in a) && !('text' in a)) && aud.some((a) => a.status === 'confirmed' && a.risk === 'HIGH'), JSON.stringify(aud.slice(0, 2)));
  const wd = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'withdraw_cancellation', { contractId: '5001' }, { confirmed: true });
  ok('4h. Kündigung zurücknehmen -> validiert', wd.ok && wd.validated.ok && (await ML.contract.get('1001')).data.cancelled === false);

  // ── 5. Termin buchen / stornieren mit Prüfung ──
  const slots = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'find_appointment_slots', { typeId: '301', days: 3 });
  ok('5. Slots gelesen', slots.ok && slots.data.length >= 1 && slots.data[0].start);
  const bk = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'book_appointment', { typeId: '301', start: slots.data[0].start, end: slots.data[0].end, title: 'Stoffwechselanalyse' }, { confirmed: true });
  ok('5a. Buchung ausgeführt und in der Liste gefunden', bk.ok && bk.validated.ok && (await ML.appointments.mine('1001')).data.length === 2);
  const foreign = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'cancel_appointment', { bookingId: '424242' }, { confirmed: true });
  ok('5b. Fremde Buchung kann nicht storniert werden', !foreign.ok && foreign.error === 'not_your_booking');
  const cn = await Tools.execute(Object.assign({}, member, { agent: 'appointment' }), 'cancel_appointment', { bookingId: '9001', title: 'Einführungstraining' }, { confirmed: true });
  ok('5c. Eigene Buchung storniert und nachgeprüft', cn.ok && cn.validated.ok && !(await ML.appointments.mine('1001')).data.some((a) => String(a.bookingId) === '9001'));

  // ── 6. Pause ──
  const po = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'get_pause_options', {});
  ok('6. Pausen-Regeln inkl. contractId', po.ok && po.data.contractId === 5001 && po.data.reasons.length === 2);
  const pc = await Tools.execute(Object.assign({}, member, { agent: 'contract' }), 'create_pause', { startDate: '2026-11-01', termValue: 2, reasonId: '2', reasonName: 'Urlaub' }, { confirmed: true });
  ok('6a. Pause angelegt und nachgeprüft', pc.ok && pc.validated.ok, JSON.stringify(pc).slice(0, 200));

  // ── 7. Rate-Limit je Aktor ──
  const rl = { actor: { kind: 'member', id: '1001-rl' }, channel: 'web', agent: 'concierge' };
  let last = null; for (let i = 0; i < Tools.TOOL_LIMIT.n + 1; i++) last = await Tools.execute(rl, 'get_studio_hours', {});
  ok('7. Tool-Rate-Limit greift', !last.ok && last.error === 'rate_limited');

  // ── 8. Fail-closed in Produktion ohne Speicher; Mock in Produktion unwirksam ──
  process.env.VERCEL_ENV = 'production';
  ok('8. Mock in Produktion aus', !ML.mockOn() && ML.mockRequestedInProd());
  ok('8a. KV nicht verfügbar -> Modus none', KV.mode() === 'none');
  const pp = await Confirm.propose(member, 'cancel_contract', high.args, 'x', 'HIGH');
  ok('8b. Kein Vorschlag ohne Speicher (fail-closed)', !pp.ok && pp.error === 'no_store');
  delete process.env.VERCEL_ENV;

  Mock.reset();
  console.log(pass ? 'FINN-TOOLS PASS' : 'FINN-TOOLS FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
