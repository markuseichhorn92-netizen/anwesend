'use strict';
// FINN Journeys am echten Magicline-Webhook: Bestandsverarbeitung bleibt, Journeys
// hängen sich über den Event-Bus an. Vertrag -> Lead „gewonnen" (auch ohne JOURNEYS),
// Check-in zählt (einmal je Tag, Duplikat nicht), Onboarding startet, Termin-Storno
// wird über jr:bk gefunden, obwohl der Bestand den Termin vorher löscht.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.MAGICLINE_WEBHOOK_KEY = 'testsecret';
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test'; delete process.env.FINN_AUTOMATIONS;
delete process.env.JOURNEYS; delete process.env.JOURNEYS_TRACK;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const welcomes = [];
inject('lib/welcome.js', { sendAccessInfoOnce: async (id) => { welcomes.push(id); return { sent: true }; } });
inject('lib/newMembers.js', { recordJoin: async () => {}, listJoins: async () => [] });
inject('lib/members.js', { ml: async () => ({ status: 200, json: [] }), getMember: async (id) => ({ id: id, firstName: 'Max', lastName: 'Muster', customerNumber: '123', email: 'x@y.z' }), findByPhone: async () => null, searchByEmail: async () => [], rateLimit: async () => true });
inject('lib/studioReply.js', { notifyStudio: async () => {} });
inject('lib/mail.js', { sendMail: async () => ({ ok: true }), hasMail: false });

const H = require(path.join(ROOT, 'api/webhooks/magicline.js'));
const LF = require(path.join(ROOT, 'lib/leadflow.js'));
const Eng = require(path.join(ROOT, 'lib/journeys/engagement.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const MlEvents = require(path.join(ROOT, 'lib/mlEvents.js'));

function mockReq(raw) {
  const req = { method: 'POST', url: '/api/webhooks/magicline', headers: { 'x-api-key': 'testsecret' }, query: {},
    on: function (ev, cb) { if (ev === 'data') cb(raw); else if (ev === 'end') Promise.resolve().then(cb); return req; } };
  return req;
}
async function post(body) { const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; await H(mockReq(JSON.stringify(body)), res); return JSON.parse(res.body || '{}'); }

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Ohne JOURNEYS: Vertrag setzt Lead auf gewonnen, Willkommensmail wie bisher
  const lead = await LF.recordLead({ phone: '015155550001', name: 'Lena Lead', customerId: '3001', source: 'probetraining' });
  let r = await post({ id: 'e1', type: 'CONTRACT_CREATED', entityId: 3001, timestamp: '2026-10-06T09:00:00Z' });
  ok('1. Bestand: Willkommensmail läuft', r.summary[0].action === 'welcome_sent' && welcomes.length === 1);
  ok('1a. Lead „gewonnen" (ohne JOURNEYS)', (await LF.getLead(lead.id)).status === 'gewonnen');
  ok('1b. ohne JOURNEYS kein Journey-Zustand', !(await Store.load('3001')));

  // 2. Nur Mitzählen (JOURNEYS_TRACK=1): Check-ins je Tag
  process.env.JOURNEYS_TRACK = '1';
  await post({ id: 'c1', type: 'CUSTOMER_CHECKIN', entityId: 3002, timestamp: '2026-10-06T08:00:00Z', content: {} });
  await post({ id: 'c1', type: 'CUSTOMER_CHECKIN', entityId: 3002, timestamp: '2026-10-06T08:00:00Z', content: {} });
  await post({ id: 'c2', type: 'CUSTOMER_CHECKIN', entityId: 3002, timestamp: '2026-10-06T17:00:00Z', content: {} });
  await post({ id: 'c3', type: 'CUSTOMER_CHECKIN', entityId: 3002, timestamp: '2026-10-08T08:00:00Z', content: {} });
  let h = await Eng.read('3002');
  ok('2. Duplikat + zweiter Besuch am selben Tag zählen nicht doppelt', h.tot === '2', JSON.stringify(h));
  ok('2a. Kandidaten-Index gefüllt', R.Z.get('jr:idx') && R.Z.get('jr:idx').has('3002'));
  ok('2b. Live-Feed (Bestand) läuft weiter', (await MlEvents.recentCheckins(10)).filter((c) => String(c.customerId) === '3002').length >= 2);

  // 3. JOURNEYS=1: Vertrag startet Onboarding
  process.env.JOURNEYS = '1';
  r = await post({ id: 'e2', type: 'CONTRACT_CREATED', entityId: 3003, timestamp: '2026-10-06T10:00:00Z' });
  const st = await Store.load('3003');
  ok('3. Onboarding + Motivation eingeschrieben', st && st.runs.onboarding && st.runs.habit && st.facts.joinAt === Date.parse('2026-10-06T10:00:00Z'));
  ok('3a. ab Vertrag wird vollständig mitgezählt', !!(await Eng.read('3003')).track);
  ok('3b. fällig eingeplant', R.Z.get('jr:due') && R.Z.get('jr:due').has('3003'));

  // 4. Einführungstraining gebucht und wieder storniert
  await post({ id: 'a1', type: 'APPOINTMENT_BOOKING_CREATED', entityId: 555, timestamp: '2026-10-06T11:00:00Z', content: { customerId: 3003, title: 'Einführungstraining', startDateTime: '2026-10-08T16:00:00Z' } });
  ok('4. gebucht erkannt', !!(await Store.load('3003')).facts.inductionBookedAt);
  await post({ id: 'a2', type: 'APPOINTMENT_BOOKING_CANCELLED', entityId: 555, timestamp: '2026-10-06T12:00:00Z', content: {} });
  ok('4a. Storno gefunden (jr:bk), obwohl der Termin im Feed schon gelöscht ist', !(await Store.load('3003')).facts.inductionBookedAt && !(await MlEvents.getAppointment(555)));

  // 5. Kündigung beendet Motivation
  await post({ id: 'k1', type: 'CONTRACT_CANCELLED', entityId: 3003, timestamp: '2026-10-07T12:00:00Z' });
  ok('5. Kündigung vermerkt', !!(await Store.load('3003')).facts.cancelled);

  // 6. Probetraining als Termin (im Studio gebucht) -> Lead-Journey mit Termin
  const lead2 = await LF.recordLead({ phone: '015155550009', name: 'Pia Probe', customerId: '3009', source: 'magicline' });
  await post({ id: 'a3', type: 'APPOINTMENT_BOOKING_CREATED', entityId: 777, timestamp: '2026-10-06T11:00:00Z', content: { customerId: 3009, title: 'Probetraining', startDateTime: '2026-10-09T15:00:00Z' } });
  const ls = await Store.load(lead2.id);
  ok('6. Probetraining-Termin aus Magicline übernommen', ls && ls.facts.trialAt === Date.parse('2026-10-09T15:00:00Z') && ls.runs.lead, JSON.stringify(ls && ls.facts));

  const hRes = await post({ id: 'x', type: 'SOMETHING_ELSE', entityId: 1 });
  ok('7. unbekannte Events weiter „ignored"', hRes.summary[0].action === 'ignored');

  console.log(pass ? 'JOURNEYS WEBHOOKS PASS' : 'JOURNEYS WEBHOOKS FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
