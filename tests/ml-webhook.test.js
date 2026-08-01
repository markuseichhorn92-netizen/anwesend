'use strict';
// Magicline-Webhook-Dispatcher (api/webhooks/magicline.js) + Live-Feed (lib/mlEvents.js):
// Termin-Buchungen -> studioweiter Feed, Stornos entfernen, Check-ins -> Präsenz-Feed,
// Zahlungsablehnung -> Team-Benachrichtigung, Auth. In-Memory-KV (Sets/Lists).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

process.env.MAGICLINE_WEBHOOK_KEY = 'testsecret';

// In-Memory-Store: Strings, Sets, Lists.
const KV = new Map(), SETS = new Map(), LISTS = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (op === 'SET') { KV.set(k, typeof c[2] === 'string' ? c[2] : String(c[2])); return 'OK'; }
    if (op === 'DEL') { KV.delete(k); SETS.delete(k); LISTS.delete(k); return 1; }
    if (op === 'SADD') { if (!SETS.has(k)) SETS.set(k, new Set()); SETS.get(k).add(String(c[2])); return 1; }
    if (op === 'SREM') { if (SETS.has(k)) SETS.get(k).delete(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return SETS.has(k) ? Array.from(SETS.get(k)) : [];
    if (op === 'SCARD') return SETS.has(k) ? SETS.get(k).size : 0;
    if (op === 'LPUSH') { if (!LISTS.has(k)) LISTS.set(k, []); LISTS.get(k).unshift(typeof c[2] === 'string' ? c[2] : String(c[2])); return LISTS.get(k).length; }
    if (op === 'LTRIM') { if (LISTS.has(k)) { const a = LISTS.get(k), s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); LISTS.set(k, a.slice(s, e + 1)); } return 'OK'; }
    if (op === 'LRANGE') { const a = LISTS.get(k) || [], s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); return a.slice(s, e < 0 ? undefined : e + 1); }
    if (op === 'EXPIRE') return 1;
    return null;
  }),
});
inject('lib/welcome.js', { sendAccessInfoOnce: async () => ({ sent: false, reason: 'test' }) });
inject('lib/newMembers.js', { recordJoin: async () => {} });
inject('lib/members.js', { ml: async () => ({ status: 200, json: [] }), getMember: async (id) => ({ id: id, firstName: 'Max', lastName: 'Muster', customerNumber: '123', email: 'x@y.z' }) });
const notified = [];
inject('lib/studioReply.js', { notifyStudio: async (o) => { notified.push(o); } });

const H = require(path.join(ROOT, 'api/webhooks/magicline.js'));
const MlEvents = require(path.join(ROOT, 'lib/mlEvents.js'));

function mockReq(method, body, headers) {
  const s = JSON.stringify(body || {});
  const req = { method: method, url: '/api/webhooks/magicline', headers: headers || {}, query: {},
    on: function (ev, cb) { if (ev === 'data') cb(s); else if (ev === 'end') Promise.resolve().then(cb); return req; } };
  return req;
}
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function post(body, headers) { const res = res0(); await H(mockReq('POST', body, Object.assign({ 'x-api-key': 'testsecret' }, headers || {})), res); return { status: res.statusCode, json: JSON.parse(res.body || '{}') }; }

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── Auth ──
  const bad = res0(); await H(mockReq('POST', { type: 'X' }, { 'x-api-key': 'wrong' }), bad);
  ok('1. falscher Schlüssel -> 401', bad.statusCode === 401);

  // ── Termin-Buchung -> Feed ──
  let r = await post({ type: 'APPOINTMENT_BOOKING_CREATED', entityId: 'b1', content: { startDateTime: '2026-08-10T14:00:00', endDateTime: '2026-08-10T15:00:00', title: 'Einweisung', customerId: 'm1' } });
  ok('2. Buchung akzeptiert (appt_upsert)', r.status === 200 && r.json.summary[0].action === 'appt_upsert', JSON.stringify(r.json));
  let feed = await MlEvents.listAppointments('2026-08-10', '2026-08-10');
  ok('3. Termin im studioweiten Feed', feed.length === 1 && feed[0].bookingId === 'b1' && /Einweisung/.test(feed[0].title), JSON.stringify(feed));

  // Update verschiebt den Termin auf einen anderen Tag -> alter Tag leer, neuer Tag hat ihn.
  await post({ type: 'APPOINTMENT_BOOKING_UPDATED', entityId: 'b1', content: { startDateTime: '2026-08-12T09:00:00', title: 'Einweisung', customerId: 'm1' } });
  ok('4. Update: alter Tag leer', (await MlEvents.listAppointments('2026-08-10', '2026-08-10')).length === 0);
  ok('5. Update: neuer Tag hat den Termin', (await MlEvents.listAppointments('2026-08-12', '2026-08-12')).length === 1);

  // ── Storno entfernt den Termin ──
  await post({ type: 'APPOINTMENT_BOOKING_CANCELLED', entityId: 'b1' });
  ok('6. Storno entfernt Termin aus dem Feed', (await MlEvents.listAppointments('2026-08-01', '2026-08-31')).length === 0);

  // ── Check-in -> Präsenz-Feed ──
  r = await post({ type: 'CUSTOMER_CHECKIN', entityId: 'm1', content: {} });
  ok('7. Check-in akzeptiert', r.json.summary[0].action === 'checkin');
  await post({ type: 'CUSTOMER_CHECKIN', entityId: 'm2', content: {} });
  const recent = await MlEvents.recentCheckins(10);
  ok('8. Letzte Check-ins (neueste zuerst)', recent.length === 2 && recent[0].customerId === 'm2' && recent[1].customerId === 'm1', JSON.stringify(recent));
  ok('9. Präsenz-Zähler heute = 2', (await MlEvents.presentCount()) === 2);

  // ── Zahlungsablehnung -> Team-Benachrichtigung ──
  r = await post({ type: 'CUSTOMER_PAYMENT_REJECTED', entityId: 'm1' });
  ok('10. Zahlung abgelehnt -> Team alarmiert', r.json.summary[0].action === 'payment_alerted' && notified.length === 1 && /Zahlung abgelehnt/.test(notified[0].subject), JSON.stringify(notified.map((n) => n.subject)));

  // ── Unbekannter/quittierter Typ ──
  r = await post({ type: 'STUDIO_OPENING_HOURS_UPDATED' });
  ok('11. Öffnungszeiten-Event quittiert', r.status === 200 && r.json.summary[0].action === 'hours_noted');
  r = await post({ type: 'SOMETHING_ELSE' });
  ok('12. Unbekannter Typ -> ignored', r.json.summary[0].action === 'ignored');

  console.log(pass ? 'ML-WEBHOOK PASS' : 'ML-WEBHOOK FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
