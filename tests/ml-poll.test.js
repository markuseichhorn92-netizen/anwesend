'use strict';
// Rollierende Magicline-Abfrage (lib/mlPoll) für den Magicline-Kalender: Kundenliste MEMBER/
// FORMER_MEMBER/PROSPECT (Interessenten nur der letzten 60 Tage), Cursor über Aufrufe, Details nur
// für neue/geänderte Buchungen, Absagen/Verschwundenes, Rate-Limit, Lock, nur GET, Feed-Anbindung.
// In-Memory-KV (tests/_memredis.js), Magicline per require.cache ersetzt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.HUB_FEED_KEY = 'hub-feed-test-key-123';
delete process.env.MAGICLINE_MODE;
delete process.env.ML_POLL;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);

const NOW = Date.now();
function iso(daysAhead, h) { const d = new Date(NOW + daysAhead * 86400000); const p = (n) => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(h || 10) + ':00:00+01:00'; }
const created = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

// Kunden: 150 Mitglieder (2 Seiten), 1 Ehemaliger, 3 Interessenten (einer zu alt)
const CUST = { MEMBER: [], FORMER_MEMBER: [{ id: 3001, firstName: 'Eva', lastName: 'Alt' }], PROSPECT: [
  { id: 4001, firstName: 'Paul', lastName: 'Probe', createdDateTime: created(3) },
  { id: 4002, firstName: 'Olga', lastName: 'Old', createdDateTime: created(200) },
  { id: 4003, firstName: 'Nina', lastName: 'Neu', createdDateTime: created(10) },
] };
for (let i = 0; i < 150; i++) CUST.MEMBER.push({ id: 1000 + i, firstName: 'M' + i, lastName: 'Nachname' + i, email: 'm' + i + '@example.org' });
const BOOK = {};      // customerId -> [list items]
const DETAILS = {};   // bookingId -> detail
function book(cid, bid, o) {
  const d = Object.assign({ bookingId: bid, title: 'Trainingsplanung', category: 'Beratung', bookingStatus: 'BOOKED', appointmentStatus: 'PLANNED', customerId: cid,
    startDateTime: iso(2, 10), endDateTime: iso(2, 11), instructors: [{ id: 77, firstName: 'Markus', lastName: 'E' }] }, o || {});
  DETAILS[bid] = d;
  (BOOK[cid] = BOOK[cid] || []).push({ bookingId: bid, title: d.title, startDateTime: d.startDateTime, endDateTime: d.endDateTime });
}
let calls = []; let rlRemaining = 900; let failList = false;
const MEM = {
  ml: async (method, p) => {
    calls.push(method + ' ' + p);
    const rl = { remaining: rlRemaining };
    let m = /^\/customers\?sliceSize=100&customerStatus=([A-Z_]+)(?:&offset=(\d+))?$/.exec(p);
    if (m) {
      if (failList) return { status: 500, json: null, rl };
      const all = CUST[m[1]] || []; const off = parseInt(m[2] || '0', 10); const sl = all.slice(off, off + 100);
      return { status: 200, json: { result: sl, hasNext: off + 100 < all.length, offset: off + 100 }, rl };
    }
    m = /^\/appointments\/booking\?customerId=(\d+)$/.exec(p);
    if (m) return { status: 200, json: (BOOK[m[1]] || []).slice(), rl };
    m = /^\/appointments\/booking\/(\d+)$/.exec(p);
    if (m) return DETAILS[m[1]] ? { status: 200, json: DETAILS[m[1]], rl } : { status: 404, json: null, rl };
    return { status: 404, json: null, rl };
  },
  getMember: async () => null,
  readBody: async (req) => req._body || {},
};
inject('lib/members.js', MEM);

const P = require(path.join(ROOT, 'lib/mlPoll.js'));
const H = require(path.join(ROOT, 'api/team/mitarbeiter-termine.js'));

function res0() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, body: null, end(x) { this.body = x; } }; }
async function feed() { const res = res0(); await H({ method: 'GET', url: '/api/team/mitarbeiter-termine?employeeId=77&days=60', headers: { authorization: 'Bearer ' + process.env.HUB_FEED_KEY } }, res); return { status: res.statusCode, json: JSON.parse(res.body || '{}') }; }
const detailCalls = () => calls.filter((c) => /^GET \/appointments\/booking\/\d+$/.test(c));

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  book(1005, 7001);                                                       // Mitglied, Markus
  book(1010, 7002, { instructors: [{ id: 78 }] });                        // anderer Trainer
  book(4001, 7003, { title: 'Probetraining', startDateTime: iso(1, 6), endDateTime: iso(1, 7) });   // Interessent (Testtermin)
  book(4002, 7004);                                                       // zu alter Interessent → nie geprüft
  book(1020, 7005, { startDateTime: iso(-3, 10), endDateTime: iso(-3, 11) });   // vergangen → kein Detail

  // ── 1. Aufruf: Liste laden + Kunden prüfen (alle 153 passen) ──
  calls = [];
  let s = await P.step();
  ok('1. Liste: 150 Mitglieder, 1 Ehemaliger, 2 Interessenten (60 Tage)', s.mitglieder === 150 && s.ehemalige === 1 && s.interessenten === 2 && s.kunden === 153, JSON.stringify(s));
  ok('2. Kundenlisten-Seiten je Status (2 + 1 + 1)', calls.filter((c) => /^GET \/customers/.test(c)).length === 4, calls.filter((c) => /customers/.test(c)).join(' | '));
  ok('3. alle Kunden geprüft, Durchlauf komplett', s.geprueft === 153 && s.fertig === true && s.komplett === 1, JSON.stringify(s));
  ok('4. alter Interessent nicht abgefragt', calls.indexOf('GET /appointments/booking?customerId=4002') < 0);
  ok('5. Details nur für künftige Buchungen (3)', detailCalls().length === 3 && calls.indexOf('GET /appointments/booking/7005') < 0, JSON.stringify(detailCalls()));
  ok('6. nur GET an Magicline', calls.every((c) => /^GET /.test(c)));
  const a3 = R.json('mlx:appt:7003');
  ok('7. Interessenten-Termin im Feed mit Trainer + „Vorname N.“', a3 && JSON.stringify(a3.instructorIds) === '["77"]' && a3.memberName === 'Paul P.' && a3.title === 'Probetraining', JSON.stringify(a3));
  ok('8. kein Nachname/keine E-Mail im KV', !R.keys().some((k) => /Nachname|example\.org/.test(String(R.S.get(k) || ''))));

  // ── 2. Aufruf: nichts geändert → keine Details ──
  calls = [];
  s = await P.step();
  ok('9. Liste frisch → keine Listenabfrage, neuer Durchlauf', calls.filter((c) => /customers\?/.test(c)).length === 0 && s.durchlauf === 2, JSON.stringify(s));
  ok('10. unveränderte Buchungen → 0 Details', detailCalls().length === 0, JSON.stringify(detailCalls()));

  // ── Feed liefert Markus' Termine (Mitglied + Interessent), ohne fremde ──
  let f = await feed();
  const ids = (f.json.appointments || []).map((a) => a.bookingId).sort();
  ok('11. Feed: 7001 + 7003, poll-Zusammenfassung dabei', f.status === 200 && JSON.stringify(ids) === '["7001","7003"]' && f.json.poll && typeof f.json.poll.kunden === 'number', JSON.stringify(f.json));
  ok('11b. poll ohne Namen/IDs', !/Paul|Nachname|"list"/.test(JSON.stringify(f.json.poll)), JSON.stringify(f.json.poll));

  // ── Änderung (verschoben) → Detail neu; Absage über Status in der Liste ──
  DETAILS[7001].startDateTime = iso(3, 9); DETAILS[7001].endDateTime = iso(3, 10);
  BOOK[1005] = [{ bookingId: 7001, title: 'Trainingsplanung', startDateTime: iso(3, 9), endDateTime: iso(3, 10) }];
  DETAILS[7003].bookingStatus = 'CANCELED';
  BOOK[4001] = [{ bookingId: 7003, title: 'Probetraining', startDateTime: iso(1, 6), endDateTime: iso(1, 7), bookingStatus: 'CANCELED' }];
  calls = [];
  await P.step();
  ok('12. verschoben + abgesagt → je 1 Detail', detailCalls().sort().join(',') === 'GET /appointments/booking/7001,GET /appointments/booking/7003', JSON.stringify(detailCalls()));
  f = await feed();
  ok('13. Feed: verschobener Termin neu, abgesagter raus', JSON.stringify(f.json.appointments.map((a) => a.bookingId)) === '["7001"]' && f.json.appointments[0].start === iso(3, 9), JSON.stringify(f.json.appointments));

  // ── Verschwunden: Detail 404 → aus dem Feed; Detail ok → übernommen ──
  book(1030, 7006);
  await P.step();
  ok('14. neuer Termin 7006 im Feed', !!R.json('mlx:appt:7006'));
  BOOK[1030] = []; delete DETAILS[7006];
  BOOK[1005] = []; DETAILS[7001].bookingStatus = 'CANCELED';
  s = await P.step();
  ok('15. verschwunden + 404 → gelöscht', !R.json('mlx:appt:7006') && s.entfernt === 1, JSON.stringify(s));
  ok('16. verschwunden + Detail CANCELED → Status übernommen', R.json('mlx:appt:7001') && R.json('mlx:appt:7001').bookingStatus === 'CANCELED' && s.geaendert === 1, JSON.stringify(R.json('mlx:appt:7001')));
  f = await feed();
  ok('17. Feed jetzt leer für Markus', f.json.appointments.length === 0, JSON.stringify(f.json.appointments));

  // ── Kunde NICHT geprüft (Fehler) → nichts löschen ──
  book(1040, 7007);
  await P.step();
  const saveMl = MEM.ml;
  MEM.ml = async (m, p) => (/customerId=1040$/.test(p) ? { status: 503, json: null } : saveMl(m, p));
  BOOK[1040] = [];
  s = await P.step();
  ok('18. Listenfehler beim Kunden → Termin bleibt', !!R.json('mlx:appt:7007') && s.fehler >= 1, JSON.stringify(s));
  MEM.ml = saveMl;

  // ── Cursor: perCall begrenzt, nächster Aufruf macht weiter ──
  s = await P.step({ perCall: 100 });
  ok('19. perCall 100 → pos 100, nicht fertig', s.pos === 100 && s.fertig === false, JSON.stringify(s));
  s = await P.step({ perCall: 100 });
  ok('20. nächster Aufruf → Rest, Durchlauf komplett', s.pos === 153 && s.fertig === true, JSON.stringify(s));

  // ── Rate-Limit: Rest unter 150 → Abbruch nach den ersten (parallelen) Abrufen ──
  rlRemaining = 100; calls = [];
  s = await P.step();
  ok('21. Rate-Limit knapp → stoppt sofort', s.stop === 'ratelimit' && calls.length <= 4, JSON.stringify(s) + ' ' + calls.length);
  rlRemaining = 900;

  // ── Lock: paralleler Lauf wird übersprungen ──
  R.S.set('mlx:poll:lock', 'fremd');
  s = await P.step();
  ok('22. Lock belegt → übersprungen', s.skipped === 'laeuft');
  R.S.delete('mlx:poll:lock');

  // ── Abrufe je Aufruf gedeckelt (≤ 350) ──
  R.reset(); for (let i = 0; i < 600; i++) CUST.MEMBER.push({ id: 20000 + i, firstName: 'X', lastName: 'Y' });
  for (let i = 0; i < 40; i++) book(20000 + i, 80000 + i);
  calls = [];
  s = await P.step();
  ok('23. ≤ 350 Magicline-Abrufe je Aufruf', calls.length <= 350 && s.abrufe <= 350 && s.pos > 0, calls.length + ' / ' + JSON.stringify(s));

  // ── Listenfehler → kein Durchlauf, später fortgesetzt ──
  R.reset(); failList = true;
  s = await P.step();
  ok('24. Kundenliste 500 → listeFehler, nichts geprüft', s.listeFehler === 500 && s.geprueft === 0, JSON.stringify(s));
  failList = false;
  s = await P.step();
  ok('25. danach Liste geladen', s.kunden > 0 && !s.listeLaedt, JSON.stringify(s));

  // ── Schalter ──
  process.env.ML_POLL = 'off';
  ok('26. ML_POLL=off → aus', (await P.step()).skipped === 'aus');
  delete process.env.ML_POLL;

  console.log(pass ? 'ML-POLL PASS' : 'ML-POLL FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
