'use strict';
// FINN Journeys – Vorlagen bei Twilio einreichen (Content API, nachgebaut):
// Metas Regeln vor dem Einreichen, Anlegen + Einreichen ohne Doppelte, Stand
// abgleichen, nur freigegebene Vorlagen werden gesendet, Neu einreichen nach
// Ablehnung, verlorener Zustand, Fehler nach dem Anlegen, von Hand zugeordnete SID,
// Rechte und keine Zugangsdaten in Antworten.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.JOURNEYS = '1'; process.env.JOURNEYS_TEST_NUMBERS = '+49 151 99990001';
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN;

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

// ── Twilio Content API im Speicher ──
const AC = 'AC' + 'a'.repeat(32), TOKEN = 'geheimes-token-123';
const TW = { contents: new Map(), calls: [], failApprovalOnce: false, deny: false, seq: 0 };
function hx() { TW.seq++; return 'HX' + ('0'.repeat(32) + TW.seq.toString(16)).slice(-32); }
function jres(status, obj) { return { ok: status >= 200 && status < 300, status: status, text: async () => (obj == null ? '' : JSON.stringify(obj)) }; }
global.fetch = async (url, init) => {
  const u = new URL(url); const m = (init && init.method) || 'GET';
  TW.calls.push(m + ' ' + u.pathname);
  if (u.host !== 'content.twilio.com') return jres(404, { message: 'unbekannt' });
  const auth = (init.headers || {}).Authorization;
  if (TW.deny || auth !== 'Basic ' + Buffer.from(AC + ':' + TOKEN).toString('base64')) return jres(401, { code: 20003, message: 'Authenticate' });
  const body = init.body ? JSON.parse(init.body) : null;
  let mm;
  if (m === 'POST' && u.pathname === '/v1/Content') {
    const sid = hx();
    TW.contents.set(sid, { sid: sid, friendly_name: body.friendly_name, language: body.language, variables: body.variables, types: body.types, approval: null });
    return jres(201, { sid: sid, friendly_name: body.friendly_name, language: body.language, variables: body.variables, types: body.types });
  }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})\/ApprovalRequests\/whatsapp$/.exec(u.pathname)) && m === 'POST') {
    if (TW.failApprovalOnce) { TW.failApprovalOnce = false; return jres(500, { message: 'kurz weg' }); }
    const c = TW.contents.get(mm[1]); if (!c) return jres(404, {});
    for (const o of TW.contents.values()) if (o.approval && o.approval.name === body.name) return jres(400, { code: 63042, message: 'name already exists' });
    c.approval = { name: body.name, category: body.category, status: 'received', rejection_reason: '', content_type: c.types['twilio/quick-reply'] ? 'twilio/quick-reply' : 'twilio/text' };
    return jres(201, c.approval);
  }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})\/ApprovalRequests$/.exec(u.pathname)) && m === 'GET') {
    const c = TW.contents.get(mm[1]); if (!c) return jres(404, {});
    return jres(200, { sid: c.sid, whatsapp: c.approval ? Object.assign({ type: 'whatsapp' }, c.approval) : undefined });
  }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})$/.exec(u.pathname)) && m === 'DELETE') { TW.contents.delete(mm[1]); return jres(204, null); }
  if (u.pathname === '/v2/ContentAndApprovals' && m === 'GET') {
    const re = new RegExp(u.searchParams.get('ContentName') || '.*');
    return jres(200, { contents: Array.from(TW.contents.values()).filter((c) => re.test(c.friendly_name)).map((c) => ({ sid: c.sid, friendly_name: c.friendly_name, approval_requests: c.approval ? Object.assign({ type: 'whatsapp' }, c.approval) : null })) });
  }
  return jres(404, {});
};
const creates = () => TW.calls.filter((c) => c === 'POST /v1/Content').length;

const H = require(path.join(ROOT, 'api/team/journeys.js'));
const Templates = require(path.join(ROOT, 'lib/journeys/templates.js'));
const TC = require(path.join(ROOT, 'lib/journeys/twilioContent.js'));
const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
const Sender = require(path.join(ROOT, 'lib/journeys/sender.js'));
const Store = require(path.join(ROOT, 'lib/journeys/store.js'));
const Consent = require(path.join(ROOT, 'lib/journeys/consent.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));

function res0() { return { statusCode: 0, setHeader() {}, body: null, end(x) { this.body = x; } }; }
async function call(method, url, body) {
  const res = res0();
  const req = { method: method, url: url, headers: {}, body: body || undefined, on() { return req; } };
  await H(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}'), raw: res.body || '' };
}
const tpl = async (k) => (await Config.load(true)).templates[k] || {};

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Metas Regeln
  const bad = Templates.keys().filter((k) => Templates.lint(k).length);
  ok('1. alle Vorlagen erfüllen Metas Regeln', !bad.length, bad.map((k) => k + ': ' + Templates.lint(k).join(', ')).join(' | '));
  const probe = (text, vars, buttons) => { Templates.T.__probe = { category: 'MARKETING', consent: 'marketing', journey: 'habit', text: text, vars: vars, buttons: buttons || [] }; const p = Templates.lint('__probe'); delete Templates.T.__probe; return p; };
  ok('1a. Variable am Anfang erkannt', probe('{{1}}, du trainierst seit {{2}} Wochen bei uns! 🔥 Weiter so!', ['Vorname', 'Wochen']).indexOf('Variable am Anfang') >= 0);
  ok('1b. Variable am Ende erkannt (auch mit Punkt/Emoji)', probe('Hallo, dein nächster Termin bei uns ist am {{1}}. 💪', ['Datum']).indexOf('Variable am Ende') >= 0);
  ok('1c. Variablen nebeneinander erkannt', probe('Hi {{1}} {{2}}, schön dass du wieder da bist bei uns.', ['Vorname', 'Nachname']).indexOf('Variablen direkt nebeneinander') >= 0);
  ok('1d. zu wenig Text erkannt', probe('Hi {{1}}, Tor {{2}}. Danke', ['a', 'b']).indexOf('zu wenig Text für die Zahl der Variablen') >= 0);
  ok('1e. Knopf zu lang / mit Emoji erkannt', probe('Hi {{1}}, wie war dein Training heute bei uns?', ['Vorname'], ['Das war richtig richtig super', 'Super 💪']).length === 2);
  ok('1f. Zeilenumbruch erkannt', probe('Hi {{1}},\nwie geht es dir heute bei uns?', ['Vorname']).length === 1);

  // 2. Anfrage an Twilio
  const name24 = TC.nameFor('fi_trial_24h', 0);
  const p24 = TC.payload('fi_trial_24h', name24);
  ok('2. Name: Schlüssel + Fingerabdruck', /^fi_trial_24h_[0-9a-f]{6}$/.test(name24), name24);
  ok('2a. Deutsch, Beispielwerte für alle Variablen', p24.language === 'de' && p24.variables['1'] === 'Lena' && p24.variables['3'] === '18:00');
  ok('2b. Knöpfe als Quick-Reply, Text als Rückfall', p24.types['twilio/quick-reply'].actions.length === 2 && p24.types['twilio/quick-reply'].actions[0].title === 'Ich komme' && p24.types['twilio/text'].body === Templates.get('fi_trial_24h').text);
  ok('2c. ohne Knöpfe nur Text', !TC.payload('fi_trial_2h', 'x').types['twilio/quick-reply']);
  ok('2d. Angebot: Tarif-Link fest im Text, eine Variable', Templates.get('fi_trial_offer').text.indexOf(Templates.JOIN_URL) > 0 && Templates.get('fi_trial_offer').vars.length === 1);

  // 3. Rechte und fehlender Zugang
  SESSION = { role: 'trainer', name: 'Tina' };
  let r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  ok('3. Trainer darf nicht einreichen', r.status === 403);
  SESSION = { role: 'admin', name: 'Anna' };
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  ok('3a. ohne Twilio-Zugang: klare Meldung, kein Aufruf', r.status === 400 && r.json.error === 'no_twilio' && TW.calls.length === 0);
  r = await call('GET', '/api/team/journeys');
  ok('3b. Übersicht meldet fehlenden Zugang', r.json.twilio && r.json.twilio.configured === false);

  // 4. Alle einreichen
  process.env.TWILIO_ACCOUNT_SID = AC; process.env.TWILIO_AUTH_TOKEN = TOKEN;
  r = await call('GET', '/api/team/journeys');
  const n = Templates.keys().length;
  ok('4. Übersicht: alle offen', r.json.twilio.configured && r.json.twilio.open === n, JSON.stringify(r.json.twilio));
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  ok('4a. alle angelegt und eingereicht', r.status === 200 && r.json.ok && r.json.submitted === n && !r.json.remaining.length, JSON.stringify(r.json).slice(0, 300));
  ok('4b. je Vorlage genau ein Anlegen', creates() === n && TW.contents.size === n);
  const e24 = await tpl('fi_trial_24h');
  ok('4c. gespeichert: SID, Name, Status „received"', /^HX[0-9a-f]{32}$/.test(e24.sid) && e24.name === name24 && e24.status === 'received' && e24.auto === true);
  ok('4d. Kategorie wie vorgesehen eingereicht', TW.contents.get(e24.sid).approval.category === 'UTILITY' && TW.contents.get((await tpl('fi_invite')).sid).approval.category === 'MARKETING');
  ok('4e. keine Zugangsdaten in der Antwort', r.raw.indexOf(TOKEN) < 0 && r.raw.indexOf(AC) < 0);
  r = await call('GET', '/api/team/journeys');
  ok('4f. in Prüfung: noch nicht verwendbar', r.json.twilio.open === 0 && r.json.templates.every((t) => !t.ready && t.status === 'received'));

  // 5. Sender nimmt nur freigegebene Vorlagen
  const st = Store.blank('5555'); st.phone = '4915122223333'; st.firstName = 'Mara'; await Store.save(st);
  await Consent.grant('4915122223333', ['service'], { src: 'test' });
  const at = Date.parse('2026-10-06T08:00:00Z'); // Dienstag 10:00 Berlin
  let s = await Sender.send(st, { journey: 'lead', step: 'trial_24h', tpl: 'fi_trial_24h', vars: { 1: 'Mara', 2: 'Mittwoch', 3: '18:00' } }, at);
  ok('5. in Prüfung + Fenster zu: überspringen („no_template")', s.status === 'skipped' && s.reason === 'no_template', JSON.stringify(s));
  r = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_24h', phone: '+4915199990001' });
  ok('5a. Testversand vor Freigabe: klare Meldung', r.status === 400 && r.json.error === 'not_approved' && !out.length);

  // 6. Nochmal einreichen legt nichts doppelt an
  const before = creates();
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  ok('6. „Alle einreichen" ohne offene: nichts passiert', r.json.ok && r.json.results.length === 0 && creates() === before);
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit', keys: ['fi_trial_24h'] });
  ok('6a. gezielt nochmal: übersprungen', r.json.results[0].skipped === true && creates() === before);

  // 7. Meta entscheidet – Abgleich
  for (const c of TW.contents.values()) c.approval.status = 'approved';
  const inv = TW.contents.get((await tpl('fi_invite')).sid);
  inv.approval.status = 'rejected'; inv.approval.rejection_reason = 'INVALID_FORMAT';
  const onb = TW.contents.get((await tpl('fi_onb_welcome')).sid); onb.approval.category = 'MARKETING';
  r = await call('POST', '/api/team/journeys', { action: 'twilio_sync' });
  ok('7. Status abgerufen', r.json.ok && r.json.checked === n && r.json.changed === n, JSON.stringify(r.json));
  r = await call('GET', '/api/team/journeys');
  const cat = (k) => r.json.templates.find((t) => t.key === k);
  ok('7a. freigegeben = verwendbar', cat('fi_trial_24h').ready && cat('fi_trial_24h').status === 'approved');
  ok('7b. abgelehnt mit Grund, nicht verwendbar', !cat('fi_invite').ready && cat('fi_invite').status === 'rejected' && cat('fi_invite').reason === 'INVALID_FORMAT');
  ok('7c. Metas Kategorie sichtbar', cat('fi_onb_welcome').metaCategory === 'MARKETING');
  s = await Sender.send(st, { journey: 'lead', step: 'trial_24h', tpl: 'fi_trial_24h', vars: { 1: 'Mara', 2: 'Mittwoch', 3: '18:00' } }, at);
  ok('7d. Sender nimmt die freigegebene Vorlage (Probelauf)', s.status === 'dry' && s.via === 'template', JSON.stringify(s));
  r = await call('POST', '/api/team/journeys', { action: 'test', tpl: 'fi_trial_24h', phone: '+4915199990001' });
  ok('7e. Testversand nutzt die eingereichte SID', r.json.ok && out.length === 1 && out[0].sid === e24.sid && out[0].vars['1'] === 'Test');

  // 8. Neu einreichen
  r = await call('POST', '/api/team/journeys', { action: 'twilio_resubmit', key: 'fi_trial_24h' });
  ok('8. freigegebene Fassung: kein Neu einreichen', r.status === 400 && r.json.error === 'not_resubmittable');
  const oldInv = (await tpl('fi_invite')).sid;
  r = await call('POST', '/api/team/journeys', { action: 'twilio_resubmit', key: 'fi_invite' });
  const ni = await tpl('fi_invite');
  ok('8a. abgelehnt: alte Fassung gelöscht, neue mit _r1 eingereicht', r.json.ok && !TW.contents.has(oldInv) && ni.sid !== oldInv && /_r1$/.test(ni.name) && ni.status === 'received' && TW.calls.indexOf('DELETE /v1/Content/' + oldInv) >= 0, JSON.stringify(ni));

  // 9. Verlorener Zustand: vorhandene Vorlage wird wiedergefunden
  const oldStreak = (await tpl('fi_streak')).sid;
  await Config.save({ templates: { fi_streak: {} } });
  const b9 = creates();
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit', keys: ['fi_streak'] });
  const s9 = await tpl('fi_streak');
  ok('9. bei Twilio wiedergefunden, nichts doppelt', r.json.ok && creates() === b9 && s9.sid === oldStreak && s9.status === 'approved', JSON.stringify(s9));

  // 10. Text geändert + Einreichen scheitert nach dem Anlegen
  const orig = Templates.T.fi_milestone.text;
  Templates.T.fi_milestone.text = 'Glückwunsch, {{1}}! 🎉 Das war schon dein {{2}}. Besuch bei Fit-Inn Trier. Stark, dass du dranbleibst!';
  r = await call('GET', '/api/team/journeys');
  ok('10. geänderter Text: als veraltet markiert und offen', r.json.templates.find((t) => t.key === 'fi_milestone').outdated && r.json.twilio.open === 1);
  TW.failApprovalOnce = true;
  const b10 = creates();
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  const m1 = await tpl('fi_milestone');
  ok('10a. Einreichen scheitert: Meldung, angelegte SID bleibt gespeichert', !r.json.ok && /fi_milestone/.test(r.json.message) && m1.status === 'created' && /^HX/.test(m1.sid) && creates() === b10 + 1);
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  const m2 = await tpl('fi_milestone');
  ok('10b. zweiter Versuch reicht dieselbe Vorlage ein', r.json.ok && creates() === b10 + 1 && m2.sid === m1.sid && m2.status === 'received');
  Templates.T.fi_milestone.text = orig;

  // 11. Von Hand zugeordnete SID bleibt unangetastet
  await call('POST', '/api/team/journeys', { action: 'template', key: 'fi_lead_last', sid: 'HX' + 'b'.repeat(32) });
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit', keys: ['fi_lead_last'] });
  ok('11. manuelle SID: nicht eingereicht', r.json.results[0].error === 'manual' && (await tpl('fi_lead_last')).sid === 'HX' + 'b'.repeat(32));
  ok('11a. manuelle SID ohne Status bleibt verwendbar', Templates.sidUsable(await tpl('fi_lead_last')));

  // 12. Zugang abgelehnt: verständliche Meldung
  await Config.save({ templates: { fi_lead_followup: {} } });
  TW.deny = true;
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit', keys: ['fi_lead_followup'] });
  ok('12. 401 von Twilio: Hinweis auf die Zugangsdaten', !r.json.ok && /Zugang/.test(r.json.message) && r.raw.indexOf(TOKEN) < 0, r.json.message);
  TW.deny = false;

  // 13. Durchlauf gleicht nur offene Prüfungen ab, höchstens alle 20 Minuten
  await KV.set('jr:tplsync', '0');
  const g0 = TW.calls.filter((c) => /^GET \/v1\/Content\/HX[0-9a-f]+\/ApprovalRequests$/.test(c)).length;
  const t1 = await TC.syncIfDue(Date.now());
  const g1 = TW.calls.filter((c) => /^GET \/v1\/Content\/HX[0-9a-f]+\/ApprovalRequests$/.test(c)).length;
  ok('13. nur offene geprüft', t1 && t1.checked === 2 && g1 - g0 === 2, JSON.stringify(t1));
  ok('13a. zweiter Aufruf gleich danach: nichts', (await TC.syncIfDue(Date.now())) === null);

  console.log(pass ? 'JOURNEYS TWILIO CONTENT PASS' : 'JOURNEYS TWILIO CONTENT FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
