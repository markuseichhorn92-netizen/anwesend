'use strict';
// FINN Journeys – Versandprotokoll: echter Versand und Fehler landen im Protokoll
// (ohne Text, Nummer maskiert), der Probelauf nicht; Zustellstand aus jr:out;
// Testversand erscheint, ohne Kennzahlen zu verfälschen; Löschung einer Person
// entfernt ihre Einträge; Deckel 500; nur Admins sehen es.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.JOURNEYS = '1'; process.env.JOURNEYS_MODE = 'auto'; delete process.env.JOURNEYS_TEST_NUMBERS;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
let SESSION = { role: 'admin', name: 'Anna' };
inject('lib/teamAuth.js', { requireTeam: async () => SESSION, roleOf: (s) => (s ? s.role : null), isAdmin: (s) => !!s && s.role === 'admin', bearer: () => 't', destroySession: async () => {} });
let nextFail = false, seq = 0;
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
const reply = () => { if (nextFail) { nextFail = false; return { ok: false, status: 400 }; } return { ok: true, id: 'SM' + (++seq) }; };
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, hasTwilio: true, hasMeta: false, hasWaButtons: false,
  sendText: async () => reply(), twilioSendTemplate: async () => reply() }));

const Sender = require(path.join(ROOT, 'lib/journeys/sender.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Window = require(path.join(ROOT, 'lib/journeys/window.js'));
const Status = require(path.join(ROOT, 'lib/journeys/status.js'));
const SendLog = require(path.join(ROOT, 'lib/journeys/sendlog.js'));
const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
const KPI = require(path.join(ROOT, 'lib/journeys/kpi.js'));
const LF = require(path.join(ROOT, 'lib/leadflow.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));
const H = require(path.join(ROOT, 'api/team/journeys.js'));

async function call(method, url, body) {
  const res = { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } };
  const req = { method: method, url: url, headers: {}, body: body || undefined, on() { return req; } };
  await H(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}'), raw: res.body || '' };
}
const AT = Date.parse('2026-10-06T08:00:00Z');   // Dienstag, 10:00 Berlin

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // Mitglied mit Einwilligung und offenem Fenster
  const P = '4915111110001';
  const st = Store.blank('7001'); st.phone = P; st.firstName = 'Mara'; await Store.save(st);
  await Consent.grant(P, ['service', 'marketing'], { src: 'test' });
  await Window.touch(P, AT);
  const o = { journey: 'onboarding', step: 'welcome', tpl: 'fi_onb_welcome', vars: { 1: 'Mara' } };

  // 1. Echter Versand
  let r = await Sender.send(st, o, AT);
  let log = await KV.lrangeJSON(SendLog.KEY, 0, -1);
  ok('1. echter Versand: ein Eintrag', r.status === 'sent' && log.length === 1, JSON.stringify(r));
  ok('1a. ohne Text, Nummer maskiert, mit Ablauf/Schritt/Vorlage', !('text' in log[0]) && log[0].pm === '…01' && JSON.stringify(log[0]).indexOf(P) < 0 && log[0].j === 'onboarding' && log[0].s === 'welcome' && log[0].tpl === 'fi_onb_welcome' && log[0].kind === 'member' && log[0].id === 'SM1', JSON.stringify(log[0]));

  // 2. Probelauf schreibt nichts
  delete process.env.JOURNEYS_MODE;
  r = await Sender.send(st, Object.assign({}, o, { step: 'induction', tpl: 'fi_onb_induction' }), AT + 3600000);
  ok('2. Probelauf: kein Protokolleintrag', r.status === 'dry' && (await KV.lrangeJSON(SendLog.KEY, 0, -1)).length === 1);
  process.env.JOURNEYS_MODE = 'auto';

  // 3. Anbieterfehler
  nextFail = true;
  r = await Sender.send(st, Object.assign({}, o, { step: 'induction', tpl: 'fi_onb_induction' }), AT + 2 * 3600000);
  log = await KV.lrangeJSON(SendLog.KEY, 0, -1);
  ok('3. Fehler beim Anbieter: Eintrag mit Fehler', r.status === 'failed' && log.length === 2 && /^provider/.test(log[0].err), JSON.stringify(log[0]));

  // 4. Zustellstand aus jr:out
  await Status.onStatus('SM1', 'read');
  let v = await SendLog.view({ limit: 10 });
  const rowWelcome = v.rows.find((x) => x.s === 'welcome');
  ok('4. Ansicht: Name, gelesen; Fehler als fehlgeschlagen', rowWelcome && rowWelcome.name === 'Mara' && rowWelcome.status === 'read' && v.rows[0].status === 'failed', JSON.stringify(v.rows));

  // 5. Interessent
  const lead = await LF.recordLead({ phone: '015155552222', name: 'Lea Lead', source: 'whatsapp' });
  const ls = Store.blank(lead.id); ls.phone = '4915155552222'; ls.firstName = 'Lea'; await Store.save(ls);
  await Consent.grant('4915155552222', ['service'], { src: 'test' });
  await Window.touch('4915155552222', AT);
  r = await Sender.send(ls, { journey: 'lead', step: 'trial_2h', tpl: 'fi_trial_2h', vars: { 1: 'Lea', 2: '18:00' } }, AT + 3 * 3600000);
  v = await SendLog.view({ limit: 10 });
  ok('5. Interessent mit Namen aus der Pipeline', r.status === 'sent' && v.rows[0].kind === 'lead' && v.rows[0].name === 'Lea Lead' && v.rows[0].subj === lead.id, JSON.stringify(v.rows[0]));

  // 6. Team-API: nur Admin, ohne Klarnummern
  SESSION = { role: 'trainer', name: 'Tina' };
  let a = await call('GET', '/api/team/journeys?view=log');
  ok('6. Trainer: 403', a.status === 403);
  SESSION = { role: 'admin', name: 'Anna' };
  a = await call('GET', '/api/team/journeys?view=log&limit=2');
  ok('6a. Admin: Einträge, blätterbar, ohne Klarnummer', a.status === 200 && a.json.rows.length === 2 && a.json.more === true && a.raw.indexOf(P) < 0 && a.raw.indexOf('4915155552222') < 0, a.raw.slice(0, 200));
  const b = await call('GET', '/api/team/journeys?view=log&limit=10&before=' + a.json.next);
  ok('6b. „Ältere laden" liefert den Rest', b.json.rows.length === 1 && b.json.rows[0].s === 'welcome');
  const ov = await call('GET', '/api/team/journeys');
  ok('6c. Übersicht enthält das Protokoll', ov.json.log && ov.json.log.rows.length === 3);

  // 7. Testversand
  process.env.JOURNEYS_TEST_NUMBERS = '+49 151 99990001';
  await Config.save({ templates: { fi_trial_24h: { sid: 'HX' + 'a'.repeat(32), status: 'approved', auto: true } } });
  a = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_24h', phone: '+4915199990001' });
  v = await SendLog.view({ limit: 1 });
  ok('7. Testversand im Protokoll', a.json.ok && v.rows[0].kind === 'test' && v.rows[0].tpl === 'fi_trial_24h' && v.rows[0].pm === '…01', JSON.stringify(v.rows[0]));
  const kpiBefore = JSON.stringify(await KPI.read(KPI.ym(), ['test']));
  await Status.onStatus('SM' + seq, 'delivered');
  v = await SendLog.view({ limit: 1 });
  ok('7a. Zustellstand des Tests sichtbar, Kennzahlen unberührt', v.rows[0].status === 'delivered' && JSON.stringify(await KPI.read(KPI.ym(), ['test'])) === kpiBefore);

  // 8. Löschung einer Person
  await Store.erase('7001');
  const left = await KV.lrangeJSON(SendLog.KEY, 0, -1);
  ok('8. Löschung entfernt ihre Einträge, andere bleiben', left.length === 2 && left.every((e) => e.subj !== '7001'), JSON.stringify(left.map((e) => e.subj)));

  // 9. Deckel
  for (let i = 0; i < 510; i++) await SendLog.add({ subj: '9' + i, j: 'habit', s: 'x', phone: '4915100000000' });
  ok('9. höchstens 500 Einträge', (await KV.lrangeJSON(SendLog.KEY, 0, -1)).length === 500);

  console.log(pass ? 'JOURNEYS SENDLOG PASS' : 'JOURNEYS SENDLOG FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
