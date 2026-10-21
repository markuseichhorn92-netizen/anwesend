'use strict';
// Magicline-Kalender (Familien-Hub): Webhook speichert Mitarbeiter/Kategorie/Status/„Vorname N.",
// GET /api/team/mitarbeiter-termine liefert nur Termine des Mitarbeiters (ab heute, ohne Stornos),
// lädt Altbestand nach (max. 40 je Aufruf), > 31 Tage in Stücken, Bearer HUB_FEED_KEY, ?email= nur ID,
// Mock-Modus ohne Netz. In-Memory-KV (tests/_memredis.js), Magicline per require.cache ersetzt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.MAGICLINE_WEBHOOK_KEY = 'testsecret';
process.env.HUB_FEED_KEY = 'hub-feed-test-key-123';
delete process.env.MAGICLINE_MODE;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);

// Magicline-Attrappe: Buchungsdetails je bookingId, Kunden, Mitarbeiter
const DETAILS = {};
const calls = [];
const CUSTOMERS = { 501: { id: 501, firstName: 'Anna Lena', lastName: 'Schmitz', email: 'anna@example.org' }, 502: { id: 502, firstName: 'Ben', lastName: 'Koch' } };
function iso(daysAhead, h) { const d = new Date(Date.now() + daysAhead * 86400000); const p = (n) => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(h || 10) + ':00:00+01:00'; }
function detail(id, o) { DETAILS[id] = Object.assign({ bookingId: id, bookingStatus: 'BOOKED', appointmentStatus: 'PLANNED', participantStatus: 'UNSET', title: 'Probetraining', category: 'Fitness', customerId: 501, instructors: [{ id: 77, firstName: 'Markus', lastName: 'E', publicName: 'Markus' }] }, o || {}); }
inject('lib/members.js', {
  ml: async (method, p) => {
    calls.push(method + ' ' + p);
    let m = /^\/appointments\/booking\/(\d+)$/.exec(p);
    if (m) return DETAILS[m[1]] ? { status: 200, json: DETAILS[m[1]] } : { status: 404, json: null };
    m = /^\/appointments\/booking\?customerId=(\d+)$/.exec(p);
    if (m) return { status: 200, json: Object.values(DETAILS).filter((d) => String(d.customerId) === m[1]).map((d) => ({ bookingId: d.bookingId, title: d.title, startDateTime: d.startDateTime, endDateTime: d.endDateTime })) };
    if (/^\/employees/.test(p)) return { status: 200, json: { result: [{ id: 77, firstName: 'Markus', lastName: 'E', email: 'chef@fit-inn.example' }, { id: 78, firstName: 'Tina', lastName: 'T', email: 'tina@fit-inn.example' }], hasNext: false } };
    return { status: 404, json: null };
  },
  getMember: async (id) => CUSTOMERS[id] || null,
  readBody: async (req) => req._body || {},
});
inject('lib/welcome.js', { sendAccessInfoOnce: async () => ({ sent: false, reason: 'test' }) });
inject('lib/newMembers.js', { recordJoin: async () => {} });
inject('lib/studioReply.js', { notifyStudio: async () => {} });
inject('lib/leadflow.js', { recordLead: async (o) => o });

const W = require(path.join(ROOT, 'api/webhooks/magicline.js'));
const H = require(path.join(ROOT, 'api/team/mitarbeiter-termine.js'));
const MlEvents = require(path.join(ROOT, 'lib/mlEvents.js'));
const B = require(path.join(ROOT, 'lib/mlBooking.js'));

function res0() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, body: null, end(x) { this.body = x; } }; }
function wreq(body) { const s = JSON.stringify(body); const req = { method: 'POST', url: '/api/webhooks/magicline', headers: { 'x-api-key': 'testsecret' }, query: {}, on(ev, cb) { if (ev === 'data') cb(s); else if (ev === 'end') Promise.resolve().then(cb); return req; } }; return req; }
async function hook(body) { const res = res0(); await W(wreq(body), res); return JSON.parse(res.body || '{}'); }
async function get(qs, key) {
  const res = res0();
  const headers = key === null ? {} : { authorization: 'Bearer ' + (key || process.env.HUB_FEED_KEY) };
  await H({ method: 'GET', url: '/api/team/mitarbeiter-termine?' + qs, headers }, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}'), headers: res.headers };
}

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── Schutz ──
  ok('1. ohne Schlüssel -> 401', (await get('employeeId=77', null)).status === 401);
  ok('2. falscher Schlüssel -> 401', (await get('employeeId=77', 'falsch')).status === 401);
  const save = process.env.HUB_FEED_KEY; delete process.env.HUB_FEED_KEY;
  ok('3. ohne HUB_FEED_KEY -> 503 (aus)', (await get('employeeId=77', 'egal')).status === 503);
  process.env.HUB_FEED_KEY = save;
  ok('4. employeeId muss Zahl sein -> 400', (await get('employeeId=abc')).status === 400);

  // ── Webhook speichert Details ──
  detail('9001', { startDateTime: iso(2, 10), endDateTime: iso(2, 11), customerId: 501 });
  let r = await hook({ type: 'APPOINTMENT_BOOKING_CREATED', entityId: 9001 });
  ok('5. Webhook-Buchung -> appt_upsert', r.summary && r.summary[0].action === 'appt_upsert', JSON.stringify(r));
  const a1 = R.json('mlx:appt:9001');
  ok('6. Feed hat instructorIds/Kategorie/Status', a1 && JSON.stringify(a1.instructorIds) === '["77"]' && a1.category === 'Fitness' && a1.appointmentStatus === 'PLANNED' && a1.detailAt > 0, JSON.stringify(a1));
  ok('7. Mitgliedsname datensparsam „Vorname N.“', a1 && a1.memberName === 'Anna S.', a1 && a1.memberName);
  ok('8. kein Nachname/keine E-Mail im Feed', !/Schmitz|anna@/.test(JSON.stringify(a1)));

  // Update ohne lesbares Detail (z. B. 403): Mitarbeiter-Zuordnung bleibt erhalten
  const keep = DETAILS['9001']; delete DETAILS['9001'];
  await hook({ type: 'APPOINTMENT_BOOKING_UPDATED', entityId: 9001, content: { startDateTime: iso(3, 9), endDateTime: iso(3, 10), title: 'Probetraining' } });
  const a1b = R.json('mlx:appt:9001');
  ok('9. Update ohne Detail behält instructorIds', a1b && JSON.stringify(a1b.instructorIds) === '["77"]' && a1b.start === iso(3, 9), JSON.stringify(a1b));
  DETAILS['9001'] = Object.assign(keep, { startDateTime: iso(3, 9), endDateTime: iso(3, 10) });

  // Termin eines anderen Mitarbeiters
  detail('9002', { startDateTime: iso(4, 12), endDateTime: iso(4, 13), instructors: [{ id: 78, firstName: 'Tina', lastName: 'T' }], customerId: 502 });
  await hook({ type: 'APPOINTMENT_BOOKING_CREATED', entityId: 9002 });
  // Stornierter Termin von Markus (Status im Detail)
  detail('9003', { startDateTime: iso(5, 12), endDateTime: iso(5, 13), bookingStatus: 'CANCELED', appointmentStatus: 'CANCELED' });
  await hook({ type: 'APPOINTMENT_BOOKING_UPDATED', entityId: 9003 });
  // Vergangener Termin von Markus (gestern) – darf nicht kommen
  detail('9004', { startDateTime: iso(-2, 10), endDateTime: iso(-2, 11) });
  await hook({ type: 'APPOINTMENT_BOOKING_CREATED', entityId: 9004 });
  // Altbestand ohne Details (wie vor dem Patch gespeichert) in 45 Tagen -> braucht Stücke > 31 Tage + Nachladen
  detail('9005', { startDateTime: iso(45, 8), endDateTime: iso(45, 9), customerId: 502, title: 'Trainingsplanung', category: 'Beratung' });
  await MlEvents.upsertAppointment({ bookingId: '9005', title: 'Trainingsplanung', start: iso(45, 8), end: iso(45, 9), customerId: '502' });
  ok('10. Altbestand ohne instructorIds im Feed', R.json('mlx:appt:9005') && R.json('mlx:appt:9005').instructorIds === null);

  calls.length = 0;
  r = await get('employeeId=77&days=60');
  const ids = (r.json.appointments || []).map((a) => a.bookingId);
  ok('11. Antwort ok + no-store', r.status === 200 && r.json.ok === true && /no-store/.test(r.headers['cache-control'] || ''), JSON.stringify(r));
  ok('12. nur Markus-Termine, ohne Storno/Vergangenes/fremde', JSON.stringify(ids) === '["9001","9005"]', JSON.stringify(ids));
  ok('13. Altbestand nachgeladen (Detail-Abruf) + zurückgeschrieben', calls.indexOf('GET /appointments/booking/9005') >= 0 && JSON.stringify(R.json('mlx:appt:9005').instructorIds) === '["77"]');
  const t5 = r.json.appointments.find((a) => a.bookingId === '9005') || {};
  ok('14. Felder: Titel, Kategorie, Status, member „Ben K.“', t5.title === 'Trainingsplanung' && t5.category === 'Beratung' && t5.status === 'PLANNED' && t5.member === 'Ben K.', JSON.stringify(t5));
  ok('15. pending = 0', r.json.pending === 0, r.json.pending);
  calls.length = 0;
  await get('employeeId=77&days=60');
  ok('16. zweiter Abruf ohne erneute Detail-Abrufe', calls.filter((c) => /^GET \/appointments\/booking\/\d+$/.test(c)).length === 0, JSON.stringify(calls));
  ok('17. days=20 -> Termin in 45 Tagen fehlt', JSON.stringify((await get('employeeId=77&days=20')).json.appointments.map((a) => a.bookingId)) === '["9001"]');

  // Kappe: 45 Altbestands-Einträge -> 40 nachgeladen, 5 pending
  for (let i = 0; i < 45; i++) { const id = String(9100 + i); detail(id, { startDateTime: iso(6, 10), endDateTime: iso(6, 11), instructors: [] }); await MlEvents.upsertAppointment({ bookingId: id, title: 'X', start: iso(6, 10), end: iso(6, 11), customerId: '501' }); }
  calls.length = 0;
  r = await get('employeeId=77&days=60');
  ok('18. max. 40 Nachladungen je Aufruf, Rest pending', calls.filter((c) => /^GET \/appointments\/booking\/91/.test(c)).length === 40 && r.json.pending === 5, calls.length + ' / ' + r.json.pending);
  r = await get('employeeId=77&days=60');
  ok('19. nächster Aufruf holt den Rest', r.json.pending === 0, r.json.pending);

  // ── ?email= liefert NUR die ID ──
  r = await get('email=chef@fit-inn.example');
  ok('20. ?email= -> nur employeeId', r.status === 200 && r.json.employeeId === '77' && Object.keys(r.json).sort().join(',') === 'employeeId,ok', JSON.stringify(r.json));
  ok('21. ?email= unbekannt -> 404', (await get('email=nobody@x.example')).status === 404);
  ok('22. ?email= ohne Schlüssel -> 401', (await get('email=chef@fit-inn.example', null)).status === 401);

  // ── Storno-Webhook entfernt ──
  await hook({ type: 'APPOINTMENT_BOOKING_CANCELLED', entityId: 9001 });
  r = await get('employeeId=77&days=60');
  ok('23. nach Storno nicht mehr in der Liste', r.json.appointments.every((a) => a.bookingId !== '9001'));

  // ── Nachlauf (vorbereitet) ──
  R.reset();
  const res = res0();
  await H({ method: 'POST', url: '/api/team/mitarbeiter-termine', headers: { authorization: 'Bearer ' + process.env.HUB_FEED_KEY }, _body: { action: 'nachlauf', customerIds: ['502', 'x'] } }, res);
  const nl = JSON.parse(res.body || '{}');
  ok('24. Nachlauf je Kunde (nur gültige IDs)', nl.ok && nl.kunden === 1 && nl.gespeichert >= 2 && JSON.stringify(R.json('mlx:appt:9005').instructorIds) === '["77"]', JSON.stringify(nl));

  // ── Hilfen + Mock-Modus ──
  ok('25. shortName', B.shortName('Anna Lena', 'Schmitz') === 'Anna S.' && B.shortName('Ben', '') === 'Ben' && B.shortName('', '') === null);
  process.env.MAGICLINE_MODE = 'mock';
  calls.length = 0;
  const md = await B.bookingDetail('123');
  ok('26. Mock-Modus: Detail ohne Netz', md.ok && md.data.instructorIds.length === 1 && calls.length === 0, JSON.stringify(md));
  delete process.env.MAGICLINE_MODE;

  console.log(pass ? 'MITARBEITER-TERMINE PASS' : 'MITARBEITER-TERMINE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
