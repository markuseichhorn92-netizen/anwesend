'use strict';
// FINN Journeys – Onboarding-Einstiege: WhatsApp verbinden in der App (Double-Opt-in per
// START-Code), Link in der Willkommens-Mail, Einladungsaktion an bekannte Nummern
// (nur eingeschaltet, nur aktive Verträge, Tagesdeckel, nur einmal je Nummer).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
delete process.env.JOURNEYS; delete process.env.JOURNEYS_MODE; delete process.env.JOURNEYS_TEST_NUMBERS;
process.env.WA_PUBLIC_NUMBER = '+49 651 308524';
process.env.JOURNEYS_INVITE_PER_DAY = '2';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const out = [];
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, hasTwilio: true, hasMeta: false, hasWaButtons: false,
  sendText: async (to, text) => { out.push({ kind: 'text', to: String(to), text: String(text) }); return { ok: true, id: 'SMt' + out.length }; },
  twilioSendTemplate: async (to, sid, vars) => { out.push({ kind: 'tpl', to: String(to), sid: sid, vars: vars }); return { ok: true, id: 'SMp' + out.length }; } }));
const MEMBERS = { 7100: { firstName: 'Ina', phoneMobile: '0151 71000001', email: 'ina@x.de', customerNumber: '7100' }, 7200: { firstName: 'Ben', phoneMobile: '0151 72000002' }, 7300: { firstName: 'Cem', phoneMobile: '0151 73000003' }, 7400: { firstName: 'Dora', phoneMobile: '0151 74000004' }, 7500: { firstName: 'Eli', phoneMobile: '' } };
const CONTRACTS = { 7100: { active: true }, 7200: { active: true }, 7300: { active: false }, 7400: { active: true }, 7500: { active: true } };
let SESSION = { id: '7100' };
inject('lib/members.js', {
  getSession: async () => SESSION, bearer: () => 't', rateLimit: async () => true,
  readBody: async (req) => req.body || {},
  getMember: async (id) => MEMBERS[id] || null, publicProfile: (m) => m,
  getContract: async (id) => CONTRACTS[id] || null,
  checkinHistory: async () => [],
});
inject('lib/privacy.js', { recordConsent: async () => ({}) });
inject('lib/push.js', { notifyMember: async () => {}, sendToTeam: async () => {}, hasPush: false, allPushMembers: async () => [] });
const mails = [];
inject('lib/mail.js', { hasMail: true, sendMailRaw: async (o) => { mails.push(o); return { ok: true }; }, sendMail: async () => ({ ok: true }) });
inject('lib/magic.js', { memberLink: async () => 'https://x/app' });

const WAApi = require(path.join(ROOT, 'api/member/whatsapp.js'));
const Inbound = require(path.join(ROOT, 'lib/journeys/inbound.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
const Tick = require(path.join(ROOT, 'lib/journeys/tick.js'));
const Engine = require(path.join(ROOT, 'lib/journeys/engine.js'));
const Quiet = require(path.join(ROOT, 'lib/journeys/quiet.js'));
const Welcome = require(path.join(ROOT, 'lib/welcome.js'));

async function call(method, body) {
  const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } };
  await WAApi({ method: method, headers: {}, body: body, url: '/api/member/whatsapp' }, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}
function berlin(y, mo, d, h) { const g = Date.UTC(y, mo - 1, d, h); for (const off of [1, 2]) { const t = g - off * 3600000; if (Quiet.parts(t).hh === h) return t; } return g; }

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Ohne JOURNEYS: Karte aus, Willkommens-Mail ohne WhatsApp-Link
  let r = await call('GET');
  ok('1. ohne JOURNEYS: in der App nicht angeboten', r.status === 200 && r.json.enabled === false);
  await Welcome.sendAccessInfoMail('7100');
  ok('1a. Willkommens-Mail ohne WhatsApp-Link', mails.length === 1 && mails[0].text.indexOf('wa.me') < 0);

  process.env.JOURNEYS = '1';
  // 2. App: verbinden (nur Service) -> Code -> START von der eigenen Nummer
  r = await call('GET');
  ok('2. mit JOURNEYS: angeboten, noch nicht verbunden', r.json.enabled === true && r.json.connected === false);
  r = await call('POST', { action: 'connect', marketing: false });
  ok('2a. Code + wa.me-Link mit „START <CODE>"', r.json.ok && /^https:\/\/wa\.me\/49651308524\?text=START%20[A-Z0-9]{6}$/.test(r.json.link), r.json.link);
  const code = r.json.code;
  r = await call('GET');
  ok('2b. Einwilligung erst nach der Nachricht (Double-Opt-in)', r.json.connected === false);
  await Inbound.onInbound({ phone: '4915171000001', text: 'START ' + code, msgId: 'x1', name: 'Ina' });
  r = await call('GET');
  ok('2c. verbunden, nur Terminerinnerungen', r.json.connected && r.json.service && !r.json.marketing && r.json.number === '…01', JSON.stringify(r.json));
  r = await call('POST', { action: 'marketing', on: true });
  ok('2d. Motivation & Tipps in der App eingeschaltet', r.json.marketing === true && (await Consent.get('4915171000001')).marketing);
  r = await call('POST', { action: 'disconnect' });
  ok('2e. abbestellt: beide Einwilligungen weg', !r.json.service && !r.json.marketing && !(await Consent.get('4915171000001')).service);
  SESSION = { id: '9999' };
  r = await call('POST', { action: 'marketing', on: true });
  ok('2f. fremde/unverbundene Sitzung kann nichts einschalten', r.status === 400 && r.json.error === 'not_connected');
  SESSION = { id: '7100' };

  // 3. Willkommens-Mail mit Link (14 Tage gültiger Code, beide Einwilligungen)
  mails.length = 0;
  await Welcome.sendAccessInfoMail('7100');
  const m = mails[0] || { text: '' };
  const mm = /wa\.me\/49651308524\?text=START%20([A-Z0-9]{6})/.exec(m.text);
  ok('3. Willkommens-Mail mit „Per WhatsApp verbinden" + Hinweis auf STOP', !!mm && /STOP/.test(m.text) && /höchstens zwei Nachrichten/.test(m.text), m.text.slice(-600));
  const rec = mm ? R.json('jr:code:' + mm[1]) : null;
  ok('3a. Code aus der Mail: Service + Motivation, Quelle welcome', rec && rec.types.join() === 'service,marketing' && rec.src === 'welcome', JSON.stringify(rec));

  // 4. Einladungsaktion
  const TUE = berlin(2026, 10, 6, 10);
  for (const id of ['7200', '7300', '7400', '7500']) await Store.index(id, TUE - 3600000);
  await Config.save({ templates: { fi_invite: { sid: 'HX' + 'b'.repeat(32) } } });
  let inv = await Tick.invitePass(TUE, { ml: 50 }, Date.now() + 5000);
  ok('4. Einladung aus: nichts', inv.skipped === 'off');
  await Config.save({ journeys: { invite: { on: true } } });
  inv = await Tick.invitePass(TUE, { ml: 50 }, Date.now() + 5000);
  const s72 = await Store.load('7200'), s73 = await Store.load('7300'), s74 = await Store.load('7400'), s75 = await Store.load('7500');
  ok('4a. aktive Verträge mit Nummer eingeschrieben (Tagesdeckel 2)', s72 && s72.runs.invite && s74 && s74.runs.invite && inv.invited === 2, JSON.stringify(inv));
  ok('4b. inaktiver Vertrag nicht, ohne Nummer nicht', !(s73 && s73.runs.invite) && !(s75 && s75.runs.invite));
  process.env.JOURNEYS_MODE = 'auto';
  const n0 = out.length;
  await Engine.runSubject('7200', TUE);
  ok('4c. Einladung als Vorlage gesendet (ohne vorherige Einwilligung)', out.length === n0 + 1 && out[out.length - 1].sid === 'HX' + 'b'.repeat(32) && out[out.length - 1].vars['1'] === 'Ben');
  ok('4d. offene Frage gesetzt (Ja/Nein wird ohne KI ausgewertet)', !!(await Inbound.pendingAsk('4915172000002')));
  await Inbound.onInbound({ phone: '4915172000002', text: 'Ja, gern', msgId: 'x2' });
  ok('4e. „Ja, gern" -> Einwilligung Service + Motivation', (await Consent.get('4915172000002')).marketing);
  const st72 = await Store.load('7200');
  st72.runs.invite = null; delete st72.runs.invite; await Store.save(st72);
  await Consent.withdraw('4915172000002', null, { src: 'test' });
  Engine.enroll(st72, 'invite', TUE + 86400000); await Store.save(st72);
  const n1 = out.length;
  await Engine.runSubject('7200', TUE + 86400000);
  ok('4f. dieselbe Nummer wird nie zweimal eingeladen', out.length === n1);

  console.log(pass ? 'JOURNEYS ONBOARDING PASS' : 'JOURNEYS ONBOARDING FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
