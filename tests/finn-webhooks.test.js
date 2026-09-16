'use strict';
// FINN Event Bus um den Magicline-Webhook: gültiges Event -> Bestandsaktion + Timeline,
// Duplikat -> keine zweite Aktion, ohne Zeitmerkmal KEIN Dedup, unbekannt -> ignored/unknown,
// korrupt -> 200 ohne Absturz, health=1 behält stats/feed und bekommt einen finn-Block.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.MAGICLINE_WEBHOOK_KEY = 'testsecret';
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test'; delete process.env.FINN_AUTOMATIONS;

// In-Memory-Store MIT NX-Unterstützung (der Replay-Schutz hängt daran).
const KV = new Map(), SETS = new Map(), LISTS = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (op === 'SET') { const nx = c.slice(3).map((x) => String(x).toUpperCase()).indexOf('NX') >= 0; if (nx && KV.has(k)) return null; KV.set(k, String(c[2])); return 'OK'; }
    if (op === 'INCR') { const n = (parseInt(KV.get(k), 10) || 0) + 1; KV.set(k, String(n)); return n; }
    if (op === 'DEL') { KV.delete(k); SETS.delete(k); LISTS.delete(k); return 1; }
    if (op === 'SADD') { if (!SETS.has(k)) SETS.set(k, new Set()); SETS.get(k).add(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return SETS.has(k) ? Array.from(SETS.get(k)) : [];
    if (op === 'SCARD') return SETS.has(k) ? SETS.get(k).size : 0;
    if (op === 'LPUSH') { if (!LISTS.has(k)) LISTS.set(k, []); LISTS.get(k).unshift(String(c[2])); return LISTS.get(k).length; }
    if (op === 'LTRIM') { if (LISTS.has(k)) { const a = LISTS.get(k), s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); LISTS.set(k, a.slice(s, e + 1)); } return 'OK'; }
    if (op === 'LRANGE') { const a = LISTS.get(k) || [], s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10); return a.slice(s, e < 0 ? undefined : e + 1); }
    if (op === 'EXPIRE') return 1;
    return null;
  }),
});
const welcomes = [];
inject('lib/welcome.js', { sendAccessInfoOnce: async (id) => { welcomes.push(id); return { sent: true }; } });
inject('lib/newMembers.js', { recordJoin: async () => {} });
inject('lib/members.js', { ml: async () => ({ status: 200, json: [] }), getMember: async (id) => ({ id: id, firstName: 'Max', lastName: 'Muster', customerNumber: '123', email: 'x@y.z' }) });
const notified = [];
inject('lib/studioReply.js', { notifyStudio: async (o) => { notified.push(o); } });
inject('lib/leadflow.js', { recordLead: async (o) => o });
inject('lib/mail.js', { sendMail: async () => ({ ok: true }), hasMail: false });

const H = require(path.join(ROOT, 'api/webhooks/magicline.js'));
const MlEvents = require(path.join(ROOT, 'lib/mlEvents.js'));
const Timeline = require(path.join(ROOT, 'lib/finn/timeline.js'));
const Automations = require(path.join(ROOT, 'lib/finn/automations.js'));
const Events = require(path.join(ROOT, 'lib/finn/events.js'));

function mockReq(method, raw, headers) {
  const req = { method: method, url: '/api/webhooks/magicline', headers: headers || {}, query: {},
    on: function (ev, cb) { if (ev === 'data') cb(raw); else if (ev === 'end') Promise.resolve().then(cb); return req; } };
  return req;
}
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function postRaw(raw) { const res = res0(); await H(mockReq('POST', raw, { 'x-api-key': 'testsecret' }), res); return { status: res.statusCode, json: JSON.parse(res.body || '{}') }; }
const post = (body) => postRaw(JSON.stringify(body));
async function health() { const res = res0(); const req = { method: 'GET', url: '/api/webhooks/magicline?health=1', headers: { 'x-api-key': 'testsecret' }, query: {}, on: function () { return req; } }; await H(req, res); return JSON.parse(res.body || '{}'); }

(async function () {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // 1. Gültiges Event mit Id: Bestandsaktion läuft, Timeline-Eintrag entsteht
  let r = await post({ id: 'evt-1', type: 'CUSTOMER_PAYMENT_REJECTED', entityId: 'm1', timestamp: '2026-09-16T10:00:00Z' });
  ok('1. Zahlungsablehnung: Bestandsaktion (Team-Mail) läuft', r.status === 200 && r.json.summary[0].action === 'payment_alerted' && notified.length === 1, JSON.stringify(r.json));
  let tl = await Timeline.list('m1');
  ok('1a. Timeline-Eintrag aus dem Webhook', tl.length === 1 && tl[0].kind === 'payment' && tl[0].source === 'webhook', JSON.stringify(tl));
  ok('1b. Retention-Signal gesetzt', (await Automations.signals('m1')).some((s) => s.kind === 'payment'));

  // 2. Dasselbe Event noch einmal (Retry des Absenders): keine zweite Mail, kein zweiter Eintrag
  r = await post({ id: 'evt-1', type: 'CUSTOMER_PAYMENT_REJECTED', entityId: 'm1', timestamp: '2026-09-16T10:00:00Z' });
  ok('2. Duplikat erkannt: action=duplicate, keine zweite Mail', r.status === 200 && r.json.summary[0].action === 'duplicate' && notified.length === 1, JSON.stringify(r.json));
  tl = await Timeline.list('m1');
  ok('2a. Kein zweiter Timeline-Eintrag', tl.length === 1);

  // 3. Ohne Id, aber mit Zeitstempel: Hash-Dedup
  r = await post({ type: 'CONTRACT_CREATED', entityId: 'm2', content: { contractId: 77 }, timestamp: '2026-09-16T11:00:00Z' });
  const r2 = await post({ type: 'CONTRACT_CREATED', entityId: 'm2', content: { contractId: 77 }, timestamp: '2026-09-16T11:00:00Z' });
  ok('3. Hash-Dedup (Typ+Entität+Zeit): Willkommensmail nur einmal angestoßen', r.json.summary[0].action === 'welcome_sent' && r2.json.summary[0].action === 'duplicate' && welcomes.length === 1, JSON.stringify([r.json, r2.json]));

  // 4. Ohne jedes Zeitmerkmal: KEIN Dedup (zwei echte Check-ins)
  await post({ type: 'CUSTOMER_CHECKIN', entityId: 'm3', content: {} });
  r = await post({ type: 'CUSTOMER_CHECKIN', entityId: 'm3', content: {} });
  ok('4. Ohne Id/Zeit wird nicht dedupliziert', r.json.summary[0].action === 'checkin' && (await MlEvents.recentCheckins(10)).filter((c) => String(c.customerId) === 'm3').length === 2);

  // 5. Termin-Event: entityId ist die Buchung – Timeline nur über content.customerId
  r = await post({ id: 'evt-appt', type: 'APPOINTMENT_BOOKING_CREATED', entityId: 'b9', content: { customerId: 'm4', startDateTime: '2026-10-01T10:00:00', title: 'Einweisung' } });
  ok('5. Termin: Feed + Timeline beim Kunden, nicht bei der Buchungs-Id', r.json.summary[0].action === 'appt_upsert' && (await Timeline.list('m4')).length === 1 && (await Timeline.list('b9')).length === 0);

  // 6. Unbekannter Typ und korrupter Body
  r = await post({ id: 'evt-x', type: 'SOMETHING_NEW', entityId: 'm5' });
  ok('6. Unbekannter Typ -> ignored (Bestand) und als unknown protokolliert', r.json.summary[0].action === 'ignored');
  r = await postRaw('{"kaputt": ');
  ok('6a. Korruptes JSON -> 200, kein Absturz', r.status === 200 && r.json.ok === true);
  r = await post({ foo: 'bar' });
  ok('6b. Event ohne Typ -> 200, ignored', r.status === 200 && r.json.summary[0].action === 'ignored');
  const st = await Events.stats(20);
  ok('6c. Statistik zählt handled/duplicate/unknown/corrupt', st.handled >= 5 && st.duplicate === 2 && st.unknown >= 1 && st.corrupt >= 1, JSON.stringify(st));

  // 7. Health behält alles Bisherige und bekommt den finn-Block
  const h = await health();
  ok('7. health=1: stats + feed unverändert, finn ergänzt', h.ok && h.health && h.stats && h.feed && h.finn && h.finn.events && typeof h.finn.events.duplicate === 'number' && h.finn.capabilities && Array.isArray(h.finn.capabilities.forbidden), JSON.stringify(h).slice(0, 300));

  // 8. Automationen abschaltbar
  process.env.FINN_AUTOMATIONS = '';
  r = await post({ id: 'evt-off', type: 'CUSTOMER_PAYMENT_REJECTED', entityId: 'm6' });
  ok('8. FINN_AUTOMATIONS leer: Bestand läuft, keine Timeline', r.json.summary[0].action === 'payment_alerted' && (await Timeline.list('m6')).length === 0);
  process.env.FINN_AUTOMATIONS = 'timeline,vorgang';
  r = await post({ id: 'evt-vg', type: 'CUSTOMER_PAYMENT_REJECTED', entityId: 'm7' });
  ok('8a. Mit „vorgang" entsteht zusätzlich ein Postfach-Vorgang', r.json.summary[0].action === 'payment_alerted' && (await require(path.join(ROOT, 'lib/inbox.js')).list('m7')).length === 1);

  console.log(pass ? 'FINN-WEBHOOKS PASS' : 'FINN-WEBHOOKS FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
