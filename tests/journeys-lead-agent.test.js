'use strict';
// FINN-Lead-Agent auf WhatsApp (FINN Journeys) – ganzes Gespräch über den echten
// Twilio-Webhook mit vorgegebenen Modellantworten:
// Erstkontakt -> Antwort in Sekunden (keine feste Begrüßung), Qualifizierung gespeichert,
// freie Termine, Buchung NUR nach „Ja" (Bestätigung), Rufnummer aus dem Webhook statt vom
// Modell, danach Lead-Pipeline + Einwilligung + Erinnerungen, Frage nach Tipps, „Ja, gern"
// ohne Modell. Website-Kanal sieht die Buchung nicht. Ohne JOURNEYS: alter Weg.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.TWILIO_SKIP_VALIDATION = '1';
delete process.env.JOURNEYS; delete process.env.JOURNEYS_MODE; delete process.env.JOURNEYS_TRACK; delete process.env.JOURNEYS_LEAD_AI;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);

// ── Modell mit Drehbuch ──
const calls = []; let script = [];
inject('lib/ai.js', {
  hasAI: true, MODEL: 'test', MODEL_PLAN: 'test', MODEL_ANALYSIS: 'test',
  async messagesRaw(o) {
    calls.push({ tools: (o.tools || []).map((t) => t.name), system: String(Array.isArray(o.system) ? o.system.map((s) => s.text).join('\n') : o.system || ''), scope: o.securityScope, last: o.messages[o.messages.length - 1] });
    const next = script.shift();
    if (!next) return { ok: true, content: [{ type: 'text', text: 'Alles klar.' }], stopReason: 'end_turn' };
    return { ok: true, content: next, stopReason: next.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  },
  cacheBlocks: (a, b) => [{ type: 'text', text: a }, { type: 'text', text: b }],
});
const TU = (name, input) => ({ type: 'tool_use', id: 'tu_' + name + '_' + Math.random().toString(36).slice(2, 7), name: name, input: input || {} });
const TX = (text) => ({ type: 'text', text: text });

// ── WhatsApp, Connect, Magicline ──
const sent = [];
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, {
  hasWhatsApp: true, hasTwilio: true, hasWaButtons: false,
  sendText: async (to, text) => { sent.push({ to: String(to), text: String(text) }); return { ok: true, id: 'SM' + sent.length }; },
  sendButtons: async () => ({ ok: false, error: 'no_buttons' }),
  verifyTwilioSignature: () => true,
}));
const DAY = 86400000;
const base = Math.floor(Date.now() / DAY) * DAY + 2 * DAY;          // übermorgen 00:00 UTC
const SLOT_EVE = new Date(base + 16 * 3600000).toISOString();     // 17/18 Uhr Berlin
const SLOT_MORN = new Date(base + 7 * 3600000).toISOString();     // 8/9 Uhr Berlin
const SLOT_EVE2 = new Date(base + DAY + 17 * 3600000).toISOString();
const bookings = [];
inject('lib/connect.js', {
  wantTrainer: () => true,
  getTrialSlots: async () => ({ status: 200, json: { slots: [{ startDateTime: SLOT_MORN }, { startDateTime: SLOT_EVE }, { startDateTime: SLOT_EVE2 }] } }),
  bookTrial: async (d) => { bookings.push(d); return { ok: true, status: 200, json: { customerId: 99001, customerNumber: 'L-99001' } }; },
});
inject('lib/members.js', { findByPhone: async () => null, searchByEmail: async () => [], getLeadConfig: async () => null, rateLimit: async () => true, getMember: async () => null, createLead: async () => ({ ok: false }) });
const legacy = [];
inject('lib/studioReply.js', { applyMemberReply: async (m, v, t) => { legacy.push(t); } });
inject('lib/waAssistant.js', { waLog: () => {}, handleInbound: async () => {} });
inject('lib/privacy.js', { recordConsent: async () => ({}) });
const teamPush = [];
inject('lib/push.js', { notifyMember: async () => {}, sendToMember: async () => {}, sendToTeam: async (o) => { teamPush.push(o); }, hasPush: true, allPushMembers: async () => [] });

const H = require(path.join(ROOT, 'api/whatsapp-twilio.js'));
const LF = require(path.join(ROOT, 'lib/leadflow.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const Channels = require(path.join(ROOT, 'lib/finn/channels.js'));
const Tools = require(path.join(ROOT, 'lib/finn/tools.js'));

function req(params) {
  const raw = new URLSearchParams(params).toString();
  const r = { method: 'POST', url: '/api/whatsapp-twilio', headers: { host: 'x' }, on(ev, cb) { if (ev === 'data') cb(raw); else if (ev === 'end') Promise.resolve().then(cb); return r; } };
  return r;
}
let sid = 0;
async function say(from, body, name) { const res = { statusCode: 0, setHeader() {}, end() {} }; await H(req({ From: 'whatsapp:+' + from, Body: body, MessageSid: 'SMin' + (++sid), ProfileName: name || '' }), res); return res.statusCode; }

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };
  const P = '4915177770001';

  // 0. Ohne JOURNEYS: alter Weg
  await say('4915177770999', 'Hallo, Probetraining?', 'Alt Weg');
  ok('0. ohne JOURNEYS: Team-Weg + feste Begrüßung, kein Modell', legacy.length === 1 && calls.length === 0 && sent.some((s) => /Vor- und Nachnamen/.test(s.text)));

  process.env.JOURNEYS = '1'; process.env.JOURNEYS_MODE = 'auto';
  // 1. Erstkontakt
  script = [[TX('Hi Lea, schön, dass du dich meldest! Was ist dein Ziel? [[antworten: Abnehmen | Muskelaufbau | Fitter werden]]')]];
  const s0 = sent.length;
  await say(P, 'Hi, ich würde gern ein Probetraining machen', 'Lea Neu');
  const c1 = calls[calls.length - 1];
  ok('1. Modell mit Lead-Werkzeugen, ohne Mitgliedswerkzeuge', c1 && c1.tools.indexOf('get_trial_slots') >= 0 && c1.tools.indexOf('book_trial') >= 0 && c1.tools.indexOf('get_contract') < 0 && c1.scope === 'member', JSON.stringify(c1 && c1.tools));
  ok('1a. Zweckbindung im System-Text (kein allgemeiner Chatbot)', /nur Fragen rund um Fit-Inn/.test(c1.system) && /Interessent/.test(c1.system));
  const replies = sent.slice(s0).map((x) => x.text);
  ok('1b. Antwort mit nummerierten Optionen, keine feste Begrüßung', replies.some((t) => /Was ist dein Ziel/.test(t) && /1\) Abnehmen/.test(t)) && !replies.some((t) => /Vor- und Nachnamen/.test(t)), JSON.stringify(replies));
  const lead = await LF.getLeadByPhone(P);
  ok('1c. Lead mit Quelle whatsapp, Lead-Journey gestartet', lead && lead.source === 'whatsapp' && (await Store.load(lead.id)).runs.lead);
  ok('1d. Team einmal informiert (Erstkontakt), nicht der alte Team-Weg', teamPush.length >= 1 && legacy.length === 1);
  const box = (await require(path.join(ROOT, 'lib/inbox.js')).list('wa' + P))[0];
  ok('1e. Gespräch im Vorgang (Nachricht + FINN-Antwort)', box && box.messages.some((m) => m.from === 'member') && box.messages.some((m) => m.author === 'FINN'));

  // 2. Qualifizierung + Termine
  script = [[TU('save_lead_profile', { goal: 'fitness', experience: 'einsteiger', daypart: 'abends' }), TU('get_trial_slots', { daypart: 'abends' })],
    [TX('Super! Frei wären: [[antworten: Termin 1 | Termin 2]]')]];
  await say(P, 'Fitter werden, bin Einsteiger, abends', 'Lea Neu');
  let st = await Store.load(lead.id);
  ok('2. Qualifizierung als feste Werte gespeichert', st.facts.profile && st.facts.profile.goal === 'fitness' && st.facts.profile.daypart === 'abends', JSON.stringify(st.facts.profile));
  const toolRes = calls[calls.length - 1].last;
  const resTxt = JSON.stringify(toolRes);
  ok('2a. Nur Abend-Termine an das Modell', resTxt.indexOf(SLOT_EVE) >= 0 && resTxt.indexOf(SLOT_MORN) < 0, resTxt.slice(0, 300));

  // 3. Buchungswunsch -> Bestätigung, noch KEINE Buchung
  script = [[TU('book_trial', { startDateTime: SLOT_EVE, firstname: 'Lea', lastname: 'Neu', dateOfBirth: '01.02.1990', telephone: '0000' })]];
  await say(P, 'Den ersten bitte. Lea Neu, 01.02.1990', 'Lea Neu');
  const conf = sent[sent.length - 1].text;
  ok('3. Bestätigung angezeigt (Erinnerung per WhatsApp steht drin), noch nicht gebucht', /Soll ich das so machen/.test(conf) && /erinnere dich hier per WhatsApp/.test(conf) && bookings.length === 0, conf);

  // 4. „Ja" -> Buchung
  const s4 = sent.length;
  await say(P, 'Ja', 'Lea Neu');
  ok('4. genau eine Buchung, Termin exakt, Geburtsdatum normiert', bookings.length === 1 && bookings[0].startDateTime === SLOT_EVE && bookings[0].dateOfBirth === '1990-02-01', JSON.stringify(bookings[0]));
  ok('4a. Rufnummer aus dem Webhook, nicht vom Modell', bookings[0].phone === '+' + P);
  ok('4b. Platzhalter-E-Mail + keine Werbe-Einwilligung in Magicline', /\+wa-/.test(bookings[0].email) && bookings[0].marketing === false);
  const l2 = await LF.getLead(lead.id);
  ok('4c. Pipeline: Stufe probetraining, Termin, Kunden-Id', l2.status === 'probetraining' && l2.trialAt === Date.parse(SLOT_EVE) && l2.customerId === '99001', JSON.stringify(l2));
  const con = await Consent.get(P);
  ok('4d. Einwilligung Terminerinnerung aus der Bestätigung, noch keine Werbung', con.service && !con.marketing);
  st = await Store.load(lead.id);
  ok('4e. Erinnerungen eingeplant (Termin im Zustand)', st.facts.trialAt === Date.parse(SLOT_EVE) && R.Z.get('jr:due').has(lead.id));
  const after4 = sent.slice(s4).map((x) => x.text);
  ok('4f. Erfolg + EINE Frage nach Tipps/Angeboten', after4.some((t) => /Erledigt/.test(t)) && after4.filter((t) => /Tipps und Angebote/.test(t)).length === 1, JSON.stringify(after4));

  // 5. „Ja, gern" -> Einwilligung ohne Modell
  const n5 = calls.length;
  await say(P, 'Ja, gern', 'Lea Neu');
  ok('5. Werbe-Einwilligung erteilt, kein Modellaufruf', (await Consent.get(P)).marketing && calls.length === n5);

  // 6. Website-Kanal: keine Buchung über das Modell
  const wsTools = await Tools.toolsFor({ actor: { kind: 'lead', id: 'v1' }, channel: 'public', agent: 'lead' });
  ok('6. Website sieht book_trial/get_trial_slots nicht', !wsTools.some((t) => t.name === 'book_trial' || t.name === 'get_trial_slots'));
  const direct = await Tools.execute({ actor: { kind: 'lead', id: 'v1' }, channel: 'public', agent: 'lead' }, 'book_trial', { startDateTime: SLOT_EVE, firstname: 'A', lastname: 'B', dateOfBirth: '01.01.1990' }, { confirmed: true });
  ok('6a. auch direkt ausgeführt: abgelehnt (not_allowed)', !direct.ok && direct.error === 'not_allowed');

  // 7. Folgenachricht nach Zuordnung zu Magicline-Kunde: bleibt beim Lead-Agenten
  await LF.linkPhone(P, { id: '99001', name: 'Lea Neu', nr: 'L-99001' });
  script = [[TX('Gern! Bring einfach Sportsachen mit.')]];
  const n7 = calls.length;
  await say(P, 'Was muss ich mitbringen?', 'Lea Neu');
  ok('7. verknüpfter Lead-Kunde: weiter Lead-Agent statt Mitglieder-Weg', calls.length === n7 + 1 && sent[sent.length - 1].text.indexOf('Sportsachen') >= 0);

  // 8. Modell nicht erreichbar -> alter Weg (Team) statt Schweigen
  script = [];
  const ai = require(path.join(ROOT, 'lib/ai.js'));
  const orig = ai.messagesRaw; ai.messagesRaw = async () => ({ ok: false, status: 500, error: 'boom' });
  const tp = teamPush.length;
  await say('4915177770002', 'Hallo?', 'Max Mustermann');
  ai.messagesRaw = orig;
  ok('8. Modellfehler: feste Begrüßung + Team informiert', sent.some((s) => s.to === '4915177770002' && /Vor- und Nachnamen/.test(s.text)) && teamPush.length > tp);

  // 9. Pilot: Die KI antwortet nur, wo auch gesendet werden dürfte.
  const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
  const pilot = async (from, label) => {
    script = [[TX('Hi! Was ist dein Ziel?')]];
    const c0 = calls.length, s0 = sent.length, l0 = legacy.length;
    await say(from, 'Hallo, Probetraining?', label);
    return { ai: calls.length > c0, greeting: sent.slice(s0).some((s) => s.to === from && /Vor- und Nachnamen/.test(s.text)), legacy: legacy.length > l0 };
  };
  delete process.env.JOURNEYS_MODE; process.env.JOURNEYS_TEST_NUMBERS = '+49 151 7777 0100';
  let pr = await pilot('4915177770100', 'Tina Test');
  ok('9. Probelauf + Testnummer: KI antwortet der Testnummer', pr.ai && !pr.greeting && Config.leadAiScope() === 'test', JSON.stringify(pr));
  pr = await pilot('4915177770101', 'Fremd Person');
  ok('9a. Probelauf, fremde Nummer: bisheriger Weg, keine KI', !pr.ai && pr.greeting && pr.legacy, JSON.stringify(pr));
  ok('9b. … und kein Lead-Gespräch für die KI vorgemerkt', !(await require(path.join(ROOT, 'lib/journeys/leadchat.js')).isLeadConversation('4915177770101')));
  process.env.JOURNEYS_MODE = 'auto';
  pr = await pilot('4915177770102', 'Noch Fremd');
  ok('9c. Echtbetrieb mit Testnummern: fremde Nummer weiter ohne KI', !pr.ai && pr.greeting, JSON.stringify(pr));
  pr = await pilot('4915177770100', 'Tina Test');
  ok('9d. … Testnummer mit KI', pr.ai);
  delete process.env.JOURNEYS_TEST_NUMBERS; delete process.env.JOURNEYS_MODE;
  pr = await pilot('4915177770103', 'Ohne Pilot');
  ok('9e. Probelauf ohne Testnummern: KI für niemanden', !pr.ai && pr.greeting && Config.leadAiScope() === 'off', JSON.stringify(pr));
  process.env.JOURNEYS_MODE = 'auto';
  pr = await pilot('4915177770104', 'Alle Dürfen');
  ok('9f. Echtbetrieb ohne Testnummern: KI für alle', pr.ai && Config.leadAiScope() === 'all', JSON.stringify(pr));

  console.log(pass ? 'JOURNEYS LEAD AGENT PASS' : 'JOURNEYS LEAD AGENT FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
