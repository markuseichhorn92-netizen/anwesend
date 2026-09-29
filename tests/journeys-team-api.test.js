'use strict';
// Team-Backend-Endpunkt der FINN Journeys: nur Admin (Übersicht, Schalter, Vorlagen,
// Testversand), Mitglieds-Status mit member.read; Content-SID wird geprüft; Testversand
// nur an JOURNEYS_TEST_NUMBERS; Antworten ohne Klarnummern.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.JOURNEYS = '1'; process.env.JOURNEYS_TEST_NUMBERS = '+49 151 99990001';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
let SESSION = null;
inject('lib/teamAuth.js', {
  requireTeam: async () => SESSION, roleOf: (s) => (s ? (s.role || 'admin') : null),
  isAdmin: (s) => !!s && (s.role || 'admin') === 'admin', bearer: () => 't', destroySession: async () => {},
});
const out = [];
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, hasTwilio: true, hasMeta: false,
  twilioSendTemplate: async (to, sid, vars) => { out.push({ to: to, sid: sid, vars: vars }); return { ok: true, id: 'SM1' }; },
  sendText: async (to, text) => { out.push({ to: to, text: text }); return { ok: true, id: 'SM2' }; } }));

const H = require(path.join(ROOT, 'api/team/journeys.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function call(method, url, body) {
  const res = res0();
  const req = { method: method, url: url, headers: {}, body: body || undefined, on() { return req; } };
  await H(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  let r = await call('GET', '/api/team/journeys');
  ok('1. ohne Sitzung 401', r.status === 401);
  SESSION = { role: 'trainer', name: 'Tina' };
  r = await call('GET', '/api/team/journeys');
  ok('2. Trainer: Übersicht 403', r.status === 403);
  r = await call('POST', '/api/team/journeys', { action: 'journey', key: 'lead', on: false });
  ok('2a. Trainer: Schalter 403', r.status === 403);

  const st = Store.blank('4444'); st.phone = '4915111112222'; st.firstName = 'Ida'; await Store.save(st);
  await Consent.grant('4915111112222', ['service'], { src: 'test' });
  r = await call('GET', '/api/team/journeys?view=member&customerId=4444');
  ok('3. Trainer: Mitglieds-Status mit member.read', r.status === 200 && r.json.ok && r.json.whatsapp.connected && r.json.whatsapp.service && !r.json.whatsapp.marketing, JSON.stringify(r.json));
  ok('3a. … ohne Rufnummer in der Antwort', JSON.stringify(r.json).indexOf('4915111112222') < 0);

  SESSION = { role: 'admin', name: 'Anna' };
  r = await call('GET', '/api/team/journeys');
  ok('4. Admin: Übersicht mit Journeys, Vorlagen, Kennzahlen', r.status === 200 && r.json.journeys.length === 5 && r.json.templates.length >= 15 && r.json.kpi && r.json.mode.on === true);
  ok('4a. Testnummern nur maskiert', JSON.stringify(r.json).indexOf('4915199990001') < 0 && r.json.mode.testNumbers[0] === '…01', JSON.stringify(r.json.mode));
  ok('4b. Einladung standardmäßig aus', r.json.journeys.find((j) => j.key === 'invite').on === false);

  r = await call('POST', '/api/team/journeys', { action: 'template', key: 'fi_trial_24h', sid: 'HX123' });
  ok('5. ungültige Content-SID abgelehnt', r.status === 400 && r.json.error === 'bad_sid');
  r = await call('POST', '/api/team/journeys', { action: 'template', key: 'fi_trial_24h', sid: 'HX' + 'a'.repeat(32) });
  ok('5a. gültige Content-SID gespeichert', r.status === 200 && r.json.ok);
  r = await call('GET', '/api/team/journeys');
  ok('5b. Vorlage als zugeordnet', r.json.templates.find((t) => t.key === 'fi_trial_24h').ready === true);

  r = await call('POST', '/api/team/journeys', { action: 'journey', key: 'invite', on: true });
  r = await call('GET', '/api/team/journeys');
  ok('6. Einladung eingeschaltet', r.json.journeys.find((j) => j.key === 'invite').on === true);
  r = await call('POST', '/api/team/journeys', { action: 'journey', key: 'hack', on: true });
  ok('6a. unbekannte Journey abgelehnt', r.status === 400);

  r = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_24h', phone: '0151 11112222' });
  ok('7. Testversand an fremde Nummer abgelehnt', r.status === 400 && r.json.error === 'not_test_number' && out.length === 0);
  r = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_24h', phone: '0151 99990001' });
  ok('7a. Testversand an Testnummer als Vorlage', r.status === 200 && r.json.ok && out.length === 1 && out[0].sid === 'HX' + 'a'.repeat(32) && out[0].vars['1'] === 'Test', JSON.stringify(out));
  r = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_2h', phone: '0151 99990001' });
  ok('7b. ohne Vorlage und ohne offenes Fenster: kein Versand', r.status === 400 && r.json.error === 'no_template' && out.length === 1);

  console.log(pass ? 'JOURNEYS TEAM API PASS' : 'JOURNEYS TEAM API FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
