'use strict';
// FINN Journeys – eingehende WhatsApp: STOP/START, Opt-in-Code, Ja/Nein auf offene
// Frage, 24-h-Fenster, Doppelzustellung, Twilio-Status mit Fehlercode. Über den echten
// Twilio-Webhook: STOP geht NICHT an Lead-Automatik/KI, landet still im Vorgang.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
delete process.env.JOURNEYS; delete process.env.JOURNEYS_TRACK;
process.env.TWILIO_SKIP_VALIDATION = '1';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const sent = [];
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, {
  hasWhatsApp: true, hasTwilio: true, hasWaButtons: false,
  sendText: async (to, text) => { sent.push({ to: String(to), text: String(text) }); return { ok: true, id: 'SM' + sent.length }; },
  verifyTwilioSignature: () => true,
}));
const leadCalls = [], memberReplies = [], consents = [];
const MAX = { id: 4711, firstName: 'Max', lastName: 'Muster', customerNumber: 'K1' };
inject('lib/members.js', { findByPhone: async (p) => (String(p).endsWith('777') ? MAX : null), findAllByPhone: async (p) => (String(p).endsWith('777') ? [MAX] : []),
  getContract: async () => ({ active: true }), rateLimit: async () => true });
inject('lib/studioReply.js', { applyMemberReply: async (m, v, t) => { memberReplies.push({ m, t }); } });
inject('lib/leadflow.js', { resolveKnownLead: async () => null, linkPhone: async () => {}, onLeadMessage: async (o) => { leadCalls.push(o); return { created: false }; } });
inject('lib/ai.js', { hasAI: false });
inject('lib/waAssistant.js', { waLog: () => {}, handleInbound: async () => {} });
inject('lib/privacy.js', { recordConsent: async (id, type, g, meta) => { consents.push({ id: String(id), type, g, src: meta && meta.source }); return {}; } });
inject('lib/push.js', { notifyMember: async () => {}, sendToTeam: async () => {}, hasPush: false });

const Inbound = require(path.join(ROOT, 'lib/journeys/inbound.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Window = require(path.join(ROOT, 'lib/journeys/window.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Inbox = require(path.join(ROOT, 'lib/inbox.js'));
const Receipts = require(path.join(ROOT, 'lib/receipts.js'));
const H = require(path.join(ROOT, 'api/whatsapp-twilio.js'));

function req(params) {
  const raw = new URLSearchParams(params).toString();
  const r = { method: 'POST', url: '/api/whatsapp-twilio', headers: { host: 'x' }, on(ev, cb) { if (ev === 'data') cb(raw); else if (ev === 'end') Promise.resolve().then(cb); return r; } };
  return r;
}
function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function tw(params) { const res = res0(); await H(req(params), res); return res; }

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };
  const P = '4915100000001';

  // 1. STOP direkt
  await Consent.grant(P, ['service', 'marketing'], { src: 'test' });
  let r = await Inbound.onInbound({ phone: P, text: 'STOP', msgId: 'a1' });
  let c = await Consent.get(P);
  ok('1. STOP wird verbraucht', r.consumed && r.kind === 'stop');
  ok('1a. beide Einwilligungen weg + Sperrliste', !c.service && !c.marketing && c.suppressed, JSON.stringify(c));
  ok('1b. Bestätigung mit Hinweis auf START', sent.length === 1 && /START/.test(sent[0].text));
  ok('1c. Fenster gemerkt', await Window.isOpen(P));
  ok('1d. Sperrliste ohne Klarnummer im Schlüssel', R.keys().filter((k) => k.indexOf('jr:sup:') === 0).every((k) => k.indexOf(P) < 0) && R.keys().some((k) => k.indexOf('jr:sup:') === 0));
  ok('1e. „stopp !" und „Abmelden" werden erkannt', Inbound.STOP_RE.test('stopp !') && Inbound.STOP_RE.test('Abmelden') && !Inbound.STOP_RE.test('stop mal kurz, ich hab ne frage'));

  // 2. START hebt auf
  r = await Inbound.onInbound({ phone: P, text: 'Start', msgId: 'a2' });
  c = await Consent.get(P);
  ok('2. START: wieder angemeldet, Sperre weg', r.consumed && c.service && c.marketing && !c.suppressed, JSON.stringify(c));

  // 3. Opt-in-Code aus der App
  const code = await Inbound.createCode('4711', ['service', 'marketing'], 600, 'app');
  ok('3. Code: 6 Zeichen ohne 0/O/1/I', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
  const P2 = '4915100000002';
  r = await Inbound.onInbound({ phone: P2, text: 'START ' + code.toLowerCase(), msgId: 'a3', name: 'Mara Beispiel' });
  c = await Consent.get(P2);
  ok('3a. Code eingelöst, Einwilligung für die Nummer', r.consumed && r.kind === 'code' && c.marketing && c.service, JSON.stringify(r));
  ok('3b. Nummer dem Mitglied zugeordnet', (await Store.forPhone(P2)) === '4711');
  const st = await Store.load('4711');
  ok('3c. Zustand mit Nummer und Vorname', st && st.phone === P2 && st.firstName === 'Mara');
  ok('3d. Nachweis im Datenschutz-Protokoll (wa_service + wa_marketing)', consents.filter((x) => x.id === '4711' && x.g).map((x) => x.type).sort().join() === 'wa_marketing,wa_service', JSON.stringify(consents));
  r = await Inbound.onInbound({ phone: P2, text: 'START ' + code, msgId: 'a4' });
  ok('3e. Code nur einmal einlösbar', r.kind === 'code_bad');

  // 4. Offene Frage (Einladung): Ja / Nein
  const P3 = '4915100000003';
  r = await Inbound.onInbound({ phone: P3, text: 'Ja', msgId: 'a5' });
  ok('4. „Ja" ohne offene Frage wird NICHT verbraucht', !r.consumed);
  await Inbound.ask(P3, ['service', 'marketing'], 'invite', '9');
  r = await Inbound.onInbound({ phone: P3, text: 'Ja, gern', msgId: 'a6' });
  ok('4a. „Ja, gern" mit offener Frage -> Einwilligung', r.consumed && r.kind === 'optin' && (await Consent.get(P3)).marketing);
  const P4 = '4915100000004';
  await Inbound.ask(P4, ['marketing'], 'invite');
  r = await Inbound.onInbound({ phone: P4, text: 'Nein, danke', msgId: 'a7' });
  ok('4b. „Nein, danke" -> keine Einwilligung', r.consumed && r.kind === 'optin_no' && !(await Consent.get(P4)).marketing);

  // 5. Twilio-Webhook: STOP von unbekannter Nummer geht NICHT in die Lead-Automatik
  const n0 = leadCalls.length, m0 = memberReplies.length;
  let res = await tw({ From: 'whatsapp:+4915100000005', Body: 'STOP', MessageSid: 'SMx1', ProfileName: 'Neu' });
  ok('5. Webhook 200', res.statusCode === 200);
  ok('5a. keine Lead-Automatik, kein Team-Alarm bei STOP', leadCalls.length === n0 && memberReplies.length === m0);
  const list = await Inbox.list('wa4915100000005');
  ok('5b. STOP still im Vorgang protokolliert (+ Notiz)', list.length === 1 && list[0].messages.some((x) => x.from === 'member' && x.text === 'STOP') && (list[0].notes || []).some((n) => /STOP/.test(n.text)), JSON.stringify(list[0] && list[0].messages));
  // 5c. Doppelte Zustellung derselben Nachricht
  const before = sent.length;
  res = await tw({ From: 'whatsapp:+4915100000006', Body: 'Hallo, Probetraining?', MessageSid: 'SMdup', ProfileName: 'Lea' });
  res = await tw({ From: 'whatsapp:+4915100000006', Body: 'Hallo, Probetraining?', MessageSid: 'SMdup', ProfileName: 'Lea' });
  ok('5c. Doppelzustellung nur einmal verarbeitet', leadCalls.length === n0 + 1, String(leadCalls.length - n0));
  ok('5d. Fenster auch im normalen Lead-Weg gemerkt', await Window.isOpen('4915100000006') && sent.length === before);
  // 5e. Bekanntes Mitglied (Nummer ...777): normaler Weg, Fenster offen
  res = await tw({ From: 'whatsapp:+4915100000777', Body: 'Wann habt ihr offen?', MessageSid: 'SMm1' });
  ok('5e. Mitglied ohne Journeys: Team-Weg wie bisher', memberReplies.some((x) => x.m === '4711' && /offen/.test(x.t)));

  // 6. Status-Callback mit Fehlercode landet an der Team-Nachricht
  const v = (await Inbox.list('4711'))[0];
  const tv = await Inbox.teamReply('4711', v.id, 'Test');
  const at = tv.messages[tv.messages.length - 1].at;
  await Receipts.track('SMfail', { m: '4711', v: v.id, at: at });
  res = await tw({ MessageSid: 'SMfail', MessageStatus: 'undelivered', ErrorCode: '63016' });
  const v2 = await Inbox.get('4711', v.id);
  const msg = v2.messages.find((x) => x.from === 'team' && x.at === at);
  ok('6. Fehlercode 63016 an der Nachricht (st=failed, err)', msg && msg.st === 'failed' && msg.err === '63016', JSON.stringify(msg));

  // 7. Fenster schließen (Anbieter meldet „zu")
  await Window.close(P);
  ok('7. Window.close -> nicht mehr offen', !(await Window.isOpen(P)));

  console.log(pass ? 'JOURNEYS INBOUND PASS' : 'JOURNEYS INBOUND FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
