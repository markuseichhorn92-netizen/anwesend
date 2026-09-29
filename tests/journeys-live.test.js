'use strict';
// FINN Journeys – Sofortversand: ein fälliger Schritt geht direkt nach dem Ereignis raus
// (über waitUntil, ohne Durchlauf); Ruhezeit verschiebt; Durchlauf und Sofortversand
// gleichzeitig → genau eine Nachricht (Sperre je Person); verlorener „gesendet"-Vermerk
// → Einmal-Marke verhindert den zweiten Versand; ohne waitUntil nichts; Opt-in per
// START-Code → zurückgestellter Schritt sofort; Cron ruft den Durchlauf per GET.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.JOURNEYS = '1'; process.env.JOURNEYS_MODE = 'auto'; delete process.env.JOURNEYS_TEST_NUMBERS;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const PHONES = { 7001: '+49 151 11110001', 7002: '+49 151 11110002', 7003: '+49 151 11110003', 7004: '+49 151 11110004', 7005: '+49 151 11110005' };
inject('lib/members.js', { ml: async () => ({ status: 200, json: [] }), getMember: async (id) => ({ id: id, firstName: 'Mara', lastName: 'M', phoneMobile: PHONES[id] || null }),
  findByPhone: async () => null, searchByEmail: async () => [], rateLimit: async () => true, checkinHistory: async () => [] });
inject('lib/studioReply.js', { notifyStudio: async () => {} });
inject('lib/mail.js', { sendMail: async () => ({ ok: true }), hasMail: false });
const sends = [];
let seq = 0;
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
const reply = async (to) => { sends.push(String(to)); await new Promise((r) => setTimeout(r, 5)); return { ok: true, id: 'SM' + (++seq) }; };
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, hasTwilio: true, hasMeta: false, hasWaButtons: false,
  sendText: async (to) => reply(to), twilioSendTemplate: async (to) => reply(to) }));

const realNow = Date.now;
let NOW = Date.parse('2026-10-06T08:00:00Z');   // Dienstag, 10:00 Berlin
Date.now = () => NOW;

const Hooks = require(path.join(ROOT, 'lib/journeys/hooks.js'));
const Live = require(path.join(ROOT, 'lib/journeys/live.js'));
const Tick = require(path.join(ROOT, 'lib/journeys/tick.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Window = require(path.join(ROOT, 'lib/journeys/window.js'));
const Inbound = require(path.join(ROOT, 'lib/journeys/inbound.js'));
const SendLog = require(path.join(ROOT, 'lib/journeys/sendlog.js'));
const Phone = require(path.join(ROOT, 'lib/phone.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));

const pending = [];
const withWait = () => { globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => { pending.push(p); } }) }; };
const noWait = () => { delete globalThis[Symbol.for('@vercel/request-context')]; };
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const welcomeSent = async (cid) => (await KV.lrangeJSON(SendLog.KEY, 0, -1)).filter((e) => e.subj === cid && e.s === 'welcome').length;
async function ready(cid, opts) {
  const p = Phone.canon(PHONES[cid]);
  if (!opts || opts.consent !== false) await Consent.grant(p, ['service'], { src: 'test' });
  await Window.touch(p, NOW);
  return p;
}

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Vertrag kommt verspätet an (Willkommen schon fällig) → sofort, ohne Durchlauf
  withWait();
  await ready('7001');
  await Hooks.onContract({ cid: '7001' }, { timestamp: new Date(NOW - 15 * 60000).toISOString() });
  ok('1. Ereignis stößt den Sofortversand an (waitUntil)', pending.length >= 1);
  await settle();
  let st = await Store.load('7001');
  ok('1a. Willkommen gesendet – ohne Durchlauf', (await welcomeSent('7001')) === 1 && st.runs.onboarding.done.welcome.r === 'sent', JSON.stringify(st && st.runs.onboarding));
  ok('1b. Profil (Nummer, Vorname) im Sofortversand nachgeladen', st.phone === Phone.canon(PHONES['7001']) && st.firstName === 'Mara');
  const sc = await KV.zscore(Store.DUE, '7001');
  ok('1c. danach nicht sofort wieder fällig', sc == null || sc > NOW, String(sc));
  ok('1d. Einmal-Marke im Zustand vermerkt', /^jr:once:7001:onboarding:welcome:/.test(st.runs.onboarding.done.welcome.k || ''));

  // 2. Durchlauf und Sofortversand gleichzeitig → genau eine Nachricht
  await ready('7002');
  noWait();
  await Hooks.onContract({ cid: '7002' }, { timestamp: new Date(NOW - 15 * 60000).toISOString() });
  const before = sends.length;
  const [a, b] = await Promise.all([Live.run('7002', 'test'), Tick.processOne('7002', NOW, { ml: 2 })]);
  ok('2. parallel: einer arbeitet, einer ist gesperrt', (a.locked ? 1 : 0) + (b.locked ? 1 : 0) === 1, JSON.stringify([a, b]));
  ok('2a. genau eine Nachricht', sends.length - before === 1 && (await welcomeSent('7002')) === 1);

  // 3. Verlorener „gesendet"-Vermerk (Hook speichert alten Zustand) → kein zweiter Versand
  st = await Store.load('7002');
  delete st.runs.onboarding.done.welcome; await Store.save(st); await Store.schedule('7002', NOW);
  const before3 = sends.length;
  await Live.run('7002', 'test');
  st = await Store.load('7002');
  ok('3. Einmal-Marke verhindert Doppelversand', sends.length === before3 && st.runs.onboarding.done.welcome.r === 'dup', JSON.stringify(st.runs.onboarding.done.welcome));

  // 4. Ruhezeit (23:30 Berlin) → verschoben, nicht gesendet
  withWait();
  NOW = Date.parse('2026-10-06T21:30:00Z');
  await ready('7003');
  await Hooks.onContract({ cid: '7003' }, { timestamp: new Date(NOW - 15 * 60000).toISOString() });
  await settle();
  st = await Store.load('7003');
  const sc3 = await KV.zscore(Store.DUE, '7003');
  ok('4. Ruhezeit: nichts gesendet, auf den Morgen verschoben', (await welcomeSent('7003')) === 0 && !st.runs.onboarding.done.welcome && sc3 > NOW, JSON.stringify({ sc3: sc3, now: NOW }));
  NOW = Date.parse('2026-10-06T08:00:00Z');

  // 5. Ohne waitUntil: kein Anstoß
  noWait();
  ok('5. ohne waitUntil: kick liefert false', Live.kick('7001', 'x') === false && Live.afterConsent('4915100000000', '7001') === false);

  // 6. Opt-in per START-Code → zurückgestellter Willkommensschritt geht sofort raus
  withWait();
  const p5 = Phone.canon(PHONES['7005']);
  await Hooks.onContract({ cid: '7005' }, { timestamp: new Date(NOW - 15 * 60000).toISOString() });
  await settle();
  st = await Store.load('7005');
  ok('6. ohne Einwilligung: Willkommen zurückgestellt', (await welcomeSent('7005')) === 0 && st.runs.onboarding.defer && st.runs.onboarding.defer.welcome > NOW, JSON.stringify(st.runs.onboarding));
  const code = await Inbound.createCode('7005', ['service'], 1800, 'app');
  const ib = await Inbound.onInbound({ provider: 'twilio', phone: p5, text: 'START ' + code, msgId: 'in1', memberId: '7005' });
  await settle();
  ok('6a. Opt-in verarbeitet und Willkommen sofort gesendet', ib.consumed && ib.kind === 'code' && (await welcomeSent('7005')) === 1, JSON.stringify(ib));

  // 7. Cron: GET mit Bearer startet den Durchlauf (Quelle „cron"), ohne → 401
  noWait();
  process.env.CRON_SECRET = 'cron-secret-test'; process.env.RECORD_SECRET = 'record-secret-test';
  const H = require(path.join(ROOT, 'api/journeys-tick.js'));
  const call = async (method, auth) => { const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; await H({ method: method, url: '/api/journeys-tick', headers: auth ? { authorization: 'Bearer ' + auth } : {} }, res); return { status: res.statusCode, json: JSON.parse(res.body || '{}') }; };
  let r = await call('GET', null);
  ok('7. ohne Geheimnis: 401', r.status === 401);
  r = await call('GET', 'cron-secret-test');
  const last = await Tick.lastRun();
  ok('7a. Vercel-Cron (GET, CRON_SECRET): Durchlauf, Quelle cron', r.status === 200 && r.json.ok && last && last.src === 'cron', JSON.stringify({ r: r, last: last }));
  r = await call('POST', 'record-secret-test');
  ok('7b. GitHub-Workflow (POST, RECORD_SECRET) bleibt gültig', r.status === 200 && r.json.ok);

  Date.now = realNow;
  console.log(pass ? 'JOURNEYS LIVE PASS' : 'JOURNEYS LIVE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { Date.now = realNow; console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
