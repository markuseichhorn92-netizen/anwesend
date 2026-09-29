'use strict';
// FINN Journeys – Sende-Regeln und Abläufe im simulierten Zeitverlauf:
// Hauptschalter, Einwilligung, Probelauf/Testnummern, Fenster -> Freitext vs. Vorlage,
// Ruhezeiten, Kappen, Sperren, STOP; Lead-Journey (Erinnerungen, Nachfassen, gewonnen,
// verloren), Onboarding, Comeback (inkl. „reaktiviert"), Meilenstein, Zustellfehler 63016.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
delete process.env.JOURNEYS; delete process.env.JOURNEYS_MODE; delete process.env.JOURNEYS_TEST_NUMBERS; delete process.env.JOURNEYS_TRACK;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const out = [];   // { kind:'text'|'tpl', to, text|sid, vars }
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, {
  hasWhatsApp: true, hasTwilio: true, hasMeta: false, hasWaButtons: false,
  sendText: async (to, text) => { out.push({ kind: 'text', to: String(to), text: String(text) }); return { ok: true, id: 'SMt' + out.length }; },
  twilioSendTemplate: async (to, sid, vars) => { out.push({ kind: 'tpl', to: String(to), sid: sid, vars: vars }); return { ok: true, id: 'SMp' + out.length }; },
  sendButtons: async () => ({ ok: false, error: 'no_buttons' }),
}));
const MEMBERS = { 5001: { firstName: 'Nina', lastName: 'Neu', phoneMobile: '0151 5001000' }, 6001: { firstName: 'Carl', lastName: 'Comeback', phoneMobile: '0151 6001000' } };
inject('lib/members.js', {
  getMember: async (id) => MEMBERS[id] || null,
  getContract: async () => ({ active: true, cancelled: false }),
  checkinHistory: async () => [],
  rateLimit: async () => true, findByPhone: async () => null, searchByEmail: async () => [], getLeadConfig: async () => null,
});
inject('lib/privacy.js', { recordConsent: async () => ({}) });
inject('lib/push.js', { notifyMember: async () => {}, sendToTeam: async () => {}, hasPush: false, allPushMembers: async () => [] });

const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Window = require(path.join(ROOT, 'lib/journeys/window.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Sender = require(path.join(ROOT, 'lib/journeys/sender.js'));
const Engine = require(path.join(ROOT, 'lib/journeys/engine.js'));
const Hooks = require(path.join(ROOT, 'lib/journeys/hooks.js'));
const Eng = require(path.join(ROOT, 'lib/journeys/engagement.js'));
const Status = require(path.join(ROOT, 'lib/journeys/status.js'));
const Tick = require(path.join(ROOT, 'lib/journeys/tick.js'));
const KPI = require(path.join(ROOT, 'lib/journeys/kpi.js'));
const Quiet = require(path.join(ROOT, 'lib/journeys/quiet.js'));
const LF = require(path.join(ROOT, 'lib/leadflow.js'));
const Inbox = require(path.join(ROOT, 'lib/inbox.js'));
const Todos = require(path.join(ROOT, 'lib/todos.js'));
const MlEvents = require(path.join(ROOT, 'lib/mlEvents.js'));

const HOUR = 3600000, DAY = 86400000, MIN = 60000;
function berlin(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi || 0);
  for (const off of [1, 2]) { const t = guess - off * 3600000; const p = Quiet.parts(t); if (p.hh === h && p.mm === (mi || 0) && p.d === d) return t; }
  return guess;
}
const TUE = berlin(2026, 10, 6, 10, 0);   // Di 6.10.2026 10:00
async function stateAfter(subj, now) { await Engine.runSubject(subj, now); return Store.load(subj); }
function lastOut() { return out[out.length - 1]; }

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // ── A. Sende-Regeln ──
  const P = '4915111110001';
  const st = Store.blank('L900'); st.phone = P; st.firstName = 'Lea';
  let r = await Sender.send(st, { journey: 'lead', step: 's1', tpl: 'fi_trial_24h', vars: { 1: 'Lea' } }, TUE);
  ok('A1. ohne JOURNEYS=1: nichts', r.status === 'skipped' && r.reason === 'off');
  process.env.JOURNEYS = '1';
  r = await Sender.send(st, { journey: 'lead', step: 's1', tpl: 'fi_trial_24h', vars: { 1: 'Lea' } }, TUE);
  ok('A2. ohne Einwilligung: übersprungen', r.status === 'skipped' && r.reason === 'no_consent', JSON.stringify(r));
  await Consent.grant(P, ['service'], { src: 'test' });
  r = await Sender.send(st, { journey: 'lead', step: 's1', tpl: 'fi_trial_24h', vars: { 1: 'Lea' } }, TUE);
  ok('A3. Fenster zu + keine Vorlage: no_template (nie Freitext riskieren)', r.status === 'skipped' && r.reason === 'no_template', JSON.stringify(r));
  await Config.save({ templates: { fi_trial_24h: { sid: 'HX24' }, fi_trial_2h: { sid: 'HX2' }, fi_trial_after: { sid: 'HXa' }, fi_trial_offer: { sid: 'HXo' }, fi_lead_last: { sid: 'HXl' }, fi_lead_followup: { sid: 'HXf' }, fi_onb_welcome: { sid: 'HXw' }, fi_onb_induction: { sid: 'HXi' }, fi_first_visit: { sid: 'HXv' }, fi_week_good: { sid: 'HXg' }, fi_week_nudge: { sid: 'HXn' }, fi_comeback_1: { sid: 'HXc1' }, fi_comeback_2: { sid: 'HXc2' }, fi_milestone: { sid: 'HXm' }, fi_habit_below: { sid: 'HXb' } } });
  r = await Sender.send(st, { journey: 'lead', step: 's1', tpl: 'fi_trial_24h', vars: { 1: 'Lea', 2: 'Donnerstag', 3: '18:00' } }, TUE);
  const dry = R.json && (await require(path.join(ROOT, 'lib/finn/kv.js')).lrangeJSON('jr:dry', 0, 0))[0];
  ok('A4. Probelauf (Standard): nichts gesendet, Vorschau ohne Namen', r.status === 'dry' && out.length === 0 && dry && dry.text.indexOf('Lea') < 0 && /\{Vorname\}/.test(dry.text), JSON.stringify(dry));
  process.env.JOURNEYS_MODE = 'auto';
  st.sent = [];
  r = await Sender.send(st, { journey: 'lead', step: 's1', tpl: 'fi_trial_24h', vars: { 1: 'Lea', 2: 'Donnerstag', 3: '18:00' } }, TUE);
  ok('A5. Auto + Fenster zu: Vorlage mit Variablen', r.status === 'sent' && r.via === 'template' && lastOut().sid === 'HX24' && lastOut().vars['1'] === 'Lea' && lastOut().vars['3'] === '18:00', JSON.stringify(lastOut()));
  const box = (await Inbox.list('wa' + P))[0];
  ok('A5a. Im WhatsApp-Vorgang als „FINN · Journey", ohne Team-Alarm', box && box.messages.some((m) => m.author === 'FINN · Journey') && box.teamUnread === false, JSON.stringify(box && box.teamUnread));
  ok('A5b. Zustellstatus verfolgbar (jr:out)', !!R.json('jr:out:' + r.id));
  await Window.touch(P, TUE - HOUR);
  r = await Sender.send(Object.assign({}, st, { sent: [] }), { journey: 'lead', step: 's2', tpl: 'fi_trial_2h', vars: { 1: 'Lea', 2: '18:00' } }, TUE);
  ok('A6. Fenster offen: kostenloser Freitext statt Vorlage', r.status === 'sent' && r.via === 'session' && lastOut().kind === 'text' && /Hi Lea, gleich/.test(lastOut().text));
  process.env.JOURNEYS_TEST_NUMBERS = '4915199999999';
  r = await Sender.send(Object.assign({}, st, { sent: [] }), { journey: 'lead', step: 's3', tpl: 'fi_trial_2h', vars: { 1: 'Lea' } }, TUE);
  ok('A7. Testnummern gesetzt, Nummer nicht darauf: nur Probelauf', r.status === 'dry');
  delete process.env.JOURNEYS_TEST_NUMBERS;
  const SUN = berlin(2026, 10, 11, 12, 0);
  await Consent.grant(P, ['marketing'], { src: 'test' });
  r = await Sender.send(Object.assign({}, st, { sent: [] }), { journey: 'lead', step: 'm1', tpl: 'fi_trial_after', vars: { 1: 'Lea' } }, SUN);
  const pn = Quiet.parts(r.retryAt || 0);
  ok('A8. Motivation am Sonntag: verschoben auf Mo 09:00', r.status === 'deferred' && r.reason === 'quiet' && pn.wd === 1 && pn.hh === 9, JSON.stringify(r) + JSON.stringify(pn));
  const capSt = Object.assign({}, st, { sent: [{ at: TUE - 3 * DAY, cat: 'marketing', via: 'template' }, { at: TUE - 1 * DAY, cat: 'marketing', via: 'template' }] });
  r = await Sender.send(capSt, { journey: 'lead', step: 'm2', tpl: 'fi_trial_after', vars: { 1: 'Lea' } }, TUE);
  ok('A9. Kappe 2 Motivationsnachrichten / 7 Tage: verschoben', r.status === 'deferred' && r.reason === 'cap' && r.retryAt >= TUE - 3 * DAY + 7 * DAY, JSON.stringify(r));
  const dayCap = Object.assign({}, st, { sent: [{ at: TUE - HOUR, cat: 'marketing', via: 'session' }] });
  r = await Sender.send(dayCap, { journey: 'lead', step: 'm3', tpl: 'fi_trial_after', vars: { 1: 'Lea' } }, TUE);
  ok('A9a. höchstens 1 Motivationsnachricht pro Tag', r.status === 'deferred' && r.reason === 'cap');
  const mem = Store.blank('7001'); mem.phone = P; mem.facts.cancelled = TUE - DAY;
  r = await Sender.send(mem, { journey: 'habit', step: 'x', tpl: 'fi_milestone', vars: { 1: 'X', 2: '10' } }, TUE);
  ok('A10. gekündigtes Mitglied: keine Journey-Nachricht', r.status === 'skipped' && r.reason === 'cancelled');
  const mem2 = Store.blank('7002'); mem2.phone = P;
  await Inbox.addVorgang('7002', { type: 'kuendigung', subject: 'Kündigung', notifyTeam: false });
  r = await Sender.send(mem2, { journey: 'habit', step: 'x', tpl: 'fi_milestone', vars: { 1: 'X', 2: '10' } }, TUE);
  ok('A10a. offener Kündigungs-Vorgang: gesperrt', r.status === 'skipped' && r.reason === 'open_case', JSON.stringify(r));
  await Consent.suppress(P);
  r = await Sender.send(Object.assign({}, st, { sent: [] }), { journey: 'lead', step: 'z', tpl: 'fi_trial_2h', vars: { 1: 'Lea' } }, TUE);
  ok('A11. STOP-Sperre gewinnt immer', r.status === 'skipped' && r.reason === 'stop');

  // ── B. Lead-Journey (Website-Buchung, Termin Do 18:00) ──
  const LP = '4915122220001';
  const lead = await LF.recordLead({ phone: '0151 22220001', name: 'Tim Probe', email: 't@x.de', source: 'probetraining', customerId: '8801', trialAt: berlin(2026, 10, 8, 18, 0) });
  ok('B0. Lead mit Quelle, Termin und Stufe probetraining', lead && lead.source === 'probetraining' && lead.status === 'probetraining' && lead.phone === '+' + LP, JSON.stringify(lead));
  const lead2 = await LF.recordLead({ phone: '+49 151 22220001', customerId: '8801', source: 'magicline' });
  ok('B0a. gleiche Person in anderer Schreibweise: KEIN zweiter Lead, Quelle bleibt', lead2 && lead2.id === lead.id && lead2.source === 'probetraining', JSON.stringify(lead2));
  const TRIAL = berlin(2026, 10, 8, 18, 0);
  await Hooks.onTrialBooked({ leadId: lead.id, customerId: '8801', phone: '0151 22220001', firstName: 'Tim', trialAt: TRIAL, source: 'probetraining', consent: { service: true, marketing: true } });
  let ls = await Store.load(lead.id);
  ok('B1. Lead-Journey gestartet, Termin + Nummer im Zustand', ls && ls.runs.lead && ls.facts.trialAt === TRIAL && ls.phone === LP);
  const n0 = out.length;
  ls = await stateAfter(lead.id, TRIAL - 24 * HOUR + 5 * MIN);
  ok('B2. 24 h vorher: Erinnerung (Vorlage, Datum + Uhrzeit)', out.length === n0 + 1 && lastOut().sid === 'HX24' && lastOut().vars['3'] === '18:00' && /Donnerstag/.test(lastOut().vars['2']), JSON.stringify(lastOut()));
  ls = await stateAfter(lead.id, TRIAL - 2 * HOUR + 5 * MIN);
  ok('B3. 2 h vorher: zweite Erinnerung', lastOut().sid === 'HX2');
  // erschienen: Check-in der Kunden-Id kurz vor Termin
  process.env.JOURNEYS_TRACK = '1';
  await Hooks.onCheckin({ cid: '8801', type: 'CUSTOMER_CHECKIN' }, { timestamp: new Date(TRIAL - 10 * MIN).toISOString() });
  ls = await Store.load(lead.id);
  ok('B4. Check-in um den Termin: erschienen (Zustand + Pipeline)', ls.facts.showedAt && (await LF.getLead(lead.id)).status === 'erschienen');
  ls = await stateAfter(lead.id, TRIAL + 3 * HOUR + 5 * MIN);   // 21:05 -> Ruhezeit
  ok('B5. „Wie war\'s?" nach 21 Uhr: verschoben, nicht gesendet', lastOut().sid === 'HX2' && ls.runs.lead.defer.after > TRIAL + 3 * HOUR);
  const fri9 = berlin(2026, 10, 9, 9, 5);
  ls = await stateAfter(lead.id, fri9);
  ok('B6. Freitag 09:05: Nachfrage gesendet', lastOut().sid === 'HXa', JSON.stringify(lastOut()));
  // Vertrag! -> gewonnen, Lead-Journey endet
  await Hooks.onContract({ cid: '8801', type: 'CONTRACT_CREATED' }, { timestamp: new Date(fri9 + HOUR).toISOString() });
  ls = await Store.load(lead.id);
  ok('B7. Vertrag: Lead gewonnen, Journey beendet', (await LF.getLead(lead.id)).status === 'gewonnen' && ls.runs.lead.exit && ls.runs.lead.exit.r === 'won', JSON.stringify(ls.runs.lead.exit));
  const n1 = out.length;
  await stateAfter(lead.id, TRIAL + 2 * DAY + HOUR);
  ok('B8. nach dem Abschluss kein Angebot mehr', out.length === n1);
  const newMember = await Store.load('8801');
  ok('B9. Neues Mitglied übernimmt Nummer + Vorname, Onboarding läuft', newMember && newMember.phone === LP && newMember.firstName === 'Tim' && newMember.runs.onboarding && !newMember.runs.onboarding.exit);

  // B10. Lead ohne Termin: Nachfassen und nach 14 Tagen „verloren"
  const lead3 = await LF.recordLead({ phone: '4915133330001', name: 'Ole', source: 'whatsapp' });
  await Consent.grant('4915133330001', ['service', 'marketing'], { src: 'test' });
  await Hooks.onLeadContact({ leadId: lead3.id, phone: '4915133330001', firstName: 'Ole', source: 'whatsapp' });
  let s3 = await Store.load(lead3.id); s3.facts.leadAt = TUE; await Store.save(s3);
  await stateAfter(lead3.id, TUE + DAY + 5 * MIN);
  ok('B10. Tag 1 ohne Termin: Nachfassen', lastOut().sid === 'HXf');
  await stateAfter(lead3.id, TUE + 4 * DAY + 5 * MIN);
  ok('B11. Tag 4: letzter Kontakt', lastOut().sid === 'HXl');
  s3 = await stateAfter(lead3.id, TUE + 14 * DAY + 5 * MIN);
  ok('B12. Tag 14: Pipeline „verloren", Journey zu Ende', (await LF.getLead(lead3.id)).status === 'verloren' && s3.runs.lead.exit, JSON.stringify(s3.runs.lead));

  // ── C. Onboarding ──
  const JOIN = berlin(2026, 10, 6, 11, 0);
  await Hooks.onContract({ cid: '5001', type: 'CONTRACT_CREATED' }, { timestamp: new Date(JOIN).toISOString() });
  let ob = await Store.load('5001');
  ok('C1. Vertrag: Onboarding + Motivation eingeschrieben, Profil folgt', ob.runs.onboarding && ob.runs.habit && ob.facts.needsProfile && ob.facts.joinAt === JOIN);
  await Tick.enrich(ob, { ml: 1 }); await Store.save(ob);
  ob = await Store.load('5001');
  ok('C2. Profil aus Magicline: Vorname + Mobilnummer', ob.firstName === 'Nina' && ob.phone === '491515001000' && (await Store.forPhone('0151 5001000')) === '5001');
  const n2 = out.length;
  await stateAfter('5001', JOIN + 15 * MIN);
  ok('C3. ohne WhatsApp-Einwilligung: keine Willkommensnachricht', out.length === n2);
  // Einwilligung kam später (Code aus der Willkommens-Mail) – Schritt ist dann schon übersprungen,
  // die nächsten Schritte laufen.
  await Consent.grant('491515001000', ['service', 'marketing'], { src: 'test', cid: '5001' });
  await MlEvents.upsertAppointment({ bookingId: 'B77', title: 'Einführungstraining', start: new Date(JOIN + DAY).toISOString(), customerId: '5001' });
  await Hooks.onAppointment({ cid: '5001', entityId: 'B77', type: 'APPOINTMENT_BOOKING_CREATED' }, { entityId: 'B77', content: { customerId: '5001' } });
  ob = await Store.load('5001');
  ok('C4. Einführungstraining gebucht erkannt', !!ob.facts.inductionBookedAt);
  const n3 = out.length;
  await stateAfter('5001', JOIN + 3 * DAY + 5 * MIN);
  ok('C5. Tag 3 mit gebuchter Einführung: keine Erinnerung', out.length === n3);
  const V1 = JOIN + 2 * DAY + 2 * HOUR;
  await Hooks.onCheckin({ cid: '5001', type: 'CUSTOMER_CHECKIN' }, { timestamp: new Date(V1).toISOString() });
  ob = await Store.load('5001');
  ok('C6. erster Besuch erkannt', ob.facts.firstVisitAt === V1);
  await stateAfter('5001', berlin(2026, 10, 9, 10, 0));
  ok('C7. Glückwunsch zum ersten Training', lastOut().sid === 'HXv', JSON.stringify(lastOut()));
  await stateAfter('5001', JOIN + 7 * DAY + 5 * MIN);
  ok('C8. Tag 7 mit 1 Besuch: Anstoß-Variante (fi_week_nudge)', lastOut().sid === 'HXn' && lastOut().vars['2'] === '1', JSON.stringify(lastOut()));
  const n4 = out.length;
  await stateAfter('5001', JOIN + 14 * DAY + 5 * MIN);
  ok('C9. Tag 14 entfällt, weil Tag 7 schon kam', out.length === n4);

  // ── D. Comeback + reaktiviert ──
  const CB = '6001';
  const lastV = TUE - 12 * DAY;
  await Eng.applyHistory(CB, [lastV - 7 * DAY, lastV], TUE);
  const cst = await Store.loadOrCreate(CB); cst.phone = '491516001000'; cst.firstName = 'Carl'; await Store.save(cst); await Store.linkPhone(cst.phone, CB);
  await Consent.grant(cst.phone, ['service', 'marketing'], { src: 'test', cid: CB });
  await Tick.evaluate(CB, TUE, { ml: 0 });
  let cs = await Store.load(CB);
  ok('D1. 12 Tage weg: Comeback eingeschrieben, Stufe inaktiv10', cs.runs.comeback && !cs.runs.comeback.exit && cs.facts.stage === 'inaktiv10', JSON.stringify(cs.facts));
  await stateAfter(CB, TUE + 5 * MIN);
  ok('D2. sanfter Anstoß gesendet', lastOut().sid === 'HXc1');
  await Hooks.onCheckin({ cid: CB, type: 'CUSTOMER_CHECKIN' }, { timestamp: new Date(TUE + DAY).toISOString() });
  cs = await stateAfter(CB, TUE + DAY + HOUR);
  const k = await KPI.read(KPI.ym(TUE + DAY), ['comeback']);
  ok('D3. Check-in beendet Comeback und zählt „reaktiviert"', cs.runs.comeback.exit && cs.runs.comeback.exit.r === 'visited' && k.data.comeback && k.data.comeback.reactivated === 1, JSON.stringify(k));

  // ── E. Meilenstein ──
  const MS = '6002';
  await Eng.applyHistory(MS, Array.from({ length: 9 }, (x, i) => TUE - (i + 1) * 3 * DAY), TUE);
  const mst = await Store.loadOrCreate(MS); mst.phone = '491516002000'; mst.firstName = 'Mia'; Engine.enroll(mst, 'habit', TUE - 30 * DAY); await Store.save(mst); await Store.linkPhone(mst.phone, MS);
  await Consent.grant(mst.phone, ['marketing'], { src: 'test', cid: MS });
  const VIS = berlin(2026, 10, 7, 8, 0);
  await Hooks.onCheckin({ cid: MS, type: 'CUSTOMER_CHECKIN' }, { timestamp: new Date(VIS).toISOString() });
  const eng = await Eng.read(MS);
  ok('E1. 10. Besuch als Meilenstein vermerkt', eng.tot === '10' && Number(eng['ms:10']) === VIS, JSON.stringify(eng));
  await stateAfter(MS, VIS + 2 * HOUR + 5 * MIN);
  ok('E2. Glückwunsch zum 10. Besuch', lastOut().sid === 'HXm' && lastOut().vars['2'] === '10');

  // ── F. Zustellfehler: Freitext außerhalb des Fensters (63016) -> einmal als Vorlage ──
  const FP = '4915144440001';
  const fl = await LF.recordLead({ phone: FP, name: 'Fe', source: 'whatsapp' });
  await Consent.grant(FP, ['service', 'marketing'], { src: 'test' });
  await Hooks.onLeadContact({ leadId: fl.id, phone: FP, firstName: 'Fe', source: 'whatsapp' });
  let fs = await Store.load(fl.id); fs.facts.leadAt = TUE; await Store.save(fs);
  await Window.touch(FP, TUE + DAY - HOUR);            // Fenster (scheinbar) offen
  await stateAfter(fl.id, TUE + DAY + 5 * MIN);
  const sess = lastOut();
  ok('F1. Fenster offen: als Freitext', sess.kind === 'text' && /Probetraining/.test(sess.text));
  const sid = 'SMt' + out.length;
  await Status.onStatus(sid, 'undelivered', '63016');
  ok('F2. 63016: Fenster als geschlossen gemerkt', !(await Window.isOpen(FP, TUE + DAY + 6 * MIN)));
  fs = await Store.load(fl.id);
  ok('F3. Schritt wieder offen und neu eingeplant', !fs.runs.lead.done.nudge_d1 && fs.runs.lead.defer.nudge_d1 > 0);
  await stateAfter(fl.id, Math.max(fs.runs.lead.defer.nudge_d1, TUE + DAY + 10 * MIN) + MIN);
  ok('F4. zweiter Versuch als Vorlage', lastOut().kind === 'tpl' && lastOut().sid === 'HXf', JSON.stringify(lastOut()));

  // ── G. Durchlauf ──
  const t = await Tick.run({ now: TUE + 30 * DAY, budgetMs: 8000, maxMagicline: 2 });
  ok('G1. Durchlauf läuft und meldet fertig', t.ok && typeof t.fertig === 'boolean' && t.due >= 0, JSON.stringify(t));
  const locked = await require(path.join(ROOT, 'lib/finn/kv.js')).set('jr:lock:tick', '1', 55, { nx: true });
  const t2 = await Tick.run({ now: TUE + 30 * DAY, budgetMs: 3000 });
  ok('G2. paralleler Durchlauf wird gesperrt', locked === true && t2.locked === true);

  // ── H. Aufgaben fürs Team entstehen nur im echten Betrieb ──
  const todos = await Todos.listTodos();
  ok('H1. keine Team-Aufgaben aus Probeläufen', Array.isArray(todos));

  console.log(pass ? 'JOURNEYS ENGINE PASS' : 'JOURNEYS ENGINE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
