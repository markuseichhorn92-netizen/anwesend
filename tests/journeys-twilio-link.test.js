'use strict';
// FINN Journeys – Vorlagen, die woanders angelegt wurden (Twilio-Konsole, Claude in
// Chrome), sicher mit der App verknüpfen: Abgleich über Namen oder gleichen Text,
// über mehrere Listenseiten, legt nie etwas an. Danach reicht „Fehlende einreichen"
// nur die wirklich fehlende ein; eine anders benannte, verknüpfte Vorlage wird nicht
// doppelt angelegt. Abweichender Text wird markiert und kann neu eingereicht werden.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.JOURNEYS = '1';
const AC = 'AC' + 'c'.repeat(32), TOKEN = 'noch-ein-geheimes-token';
process.env.TWILIO_ACCOUNT_SID = AC; process.env.TWILIO_AUTH_TOKEN = TOKEN;

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
inject('lib/teamAuth.js', {
  requireTeam: async () => ({ role: 'admin', name: 'Anna' }), roleOf: () => 'admin',
  isAdmin: () => true, bearer: () => 't', destroySession: async () => {},
});
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, hasTwilio: true, hasMeta: false,
  twilioSendTemplate: async () => ({ ok: true, id: 'SM1' }), sendText: async () => ({ ok: true, id: 'SM2' }) }));

const Templates = require(path.join(ROOT, 'lib/journeys/templates.js'));
const TC = require(path.join(ROOT, 'lib/journeys/twilioContent.js'));

// ── Twilio im Speicher, Liste in Seiten zu 7 ──
const TW = { contents: [], calls: [], deny: false, seq: 0 };
function hx() { TW.seq++; return 'HX' + ('0'.repeat(32) + TW.seq.toString(16)).slice(-32); }
function jres(status, obj) { return { ok: status >= 200 && status < 300, status: status, text: async () => (obj == null ? '' : JSON.stringify(obj)) }; }
function add(name, body, buttons, status, category) {
  const types = { 'twilio/text': { body: body } };
  if (buttons && buttons.length) types['twilio/quick-reply'] = { body: body, actions: buttons.map((b, i) => ({ title: b, id: 'b' + i })) };
  const c = { sid: hx(), friendly_name: name, language: 'de', types: types, approval: status ? { name: name, category: category || 'MARKETING', status: status, rejection_reason: status === 'rejected' ? 'INVALID_FORMAT' : '' } : null };
  TW.contents.push(c); return c;
}
global.fetch = async (url, init) => {
  const u = new URL(url); const m = (init && init.method) || 'GET';
  TW.calls.push(m + ' ' + u.pathname);
  if (TW.deny || (init.headers || {}).Authorization !== 'Basic ' + Buffer.from(AC + ':' + TOKEN).toString('base64')) return jres(401, { code: 20003, message: 'Authenticate' });
  const body = init.body ? JSON.parse(init.body) : null;
  let mm;
  if (m === 'GET' && u.pathname === '/v2/ContentAndApprovals') {
    const re = u.searchParams.get('ContentName') ? new RegExp(u.searchParams.get('ContentName')) : null;
    const all = TW.contents.filter((c) => !re || re.test(c.friendly_name));
    const size = Math.min(parseInt(u.searchParams.get('PageSize') || '50', 10), 7);
    const page = parseInt(u.searchParams.get('PageToken') || '0', 10);
    const slice = all.slice(page * size, page * size + size);
    const next = (page + 1) * size < all.length ? 'https://content.twilio.com/v2/ContentAndApprovals?PageSize=' + size + '&PageToken=' + (page + 1) : null;
    return jres(200, { contents: slice.map((c) => ({ sid: c.sid, friendly_name: c.friendly_name, language: c.language, types: c.types, approval_requests: c.approval ? Object.assign({ type: 'whatsapp' }, c.approval) : null })), meta: { next_page_url: next } });
  }
  if (m === 'POST' && u.pathname === '/v1/Content') { const c = { sid: hx(), friendly_name: body.friendly_name, language: body.language, types: body.types, approval: null }; TW.contents.push(c); return jres(201, { sid: c.sid }); }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})\/ApprovalRequests\/whatsapp$/.exec(u.pathname)) && m === 'POST') {
    const c = TW.contents.find((x) => x.sid === mm[1]); if (!c) return jres(404, {});
    if (TW.contents.some((o) => o.approval && o.approval.name === body.name)) return jres(400, { code: 63042, message: 'name already exists' });
    c.approval = { name: body.name, category: body.category, status: 'received', rejection_reason: '' };
    return jres(201, c.approval);
  }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})\/ApprovalRequests$/.exec(u.pathname)) && m === 'GET') {
    const c = TW.contents.find((x) => x.sid === mm[1]); if (!c) return jres(404, {});
    return jres(200, { sid: c.sid, whatsapp: c.approval ? Object.assign({ type: 'whatsapp' }, c.approval) : undefined });
  }
  if ((mm = /^\/v1\/Content\/(HX[0-9a-f]{32})$/.exec(u.pathname)) && m === 'DELETE') { TW.contents = TW.contents.filter((x) => x.sid !== mm[1]); return jres(204, null); }
  return jres(404, {});
};
const count = (re) => TW.calls.filter((c) => re.test(c)).length;
const CREATE = /^POST \/v1\/Content$/, APPROVE = /^POST \/v1\/Content\/HX[0-9a-f]+\/ApprovalRequests\/whatsapp$/, DELETE = /^DELETE /;

// ── Was die Chrome-Erweiterung angelegt hat ──
const keys = Templates.keys();
const T = (k) => Templates.get(k);
add('login_code', 'Dein Code lautet {{1}}. Gib ihn nicht weiter, bitte.', [], 'approved', 'AUTHENTICATION');   // fremde Vorlage
for (const k of keys) {
  if (k === 'fi_invite') continue;                                                        // fehlt ganz
  if (k === 'fi_streak') { add('fi_streak_chrome', T(k).text, T(k).buttons, 'approved'); continue; }   // anderer Name, gleicher Text
  if (k === 'fi_trial_24h') { add(TC.nameFor(k, 0), T(k).text.replace(' 💪', ''), T(k).buttons, 'approved', 'UTILITY'); continue; }   // Text weicht ab
  if (k === 'fi_comeback_2') add(TC.nameFor(k, 0), T(k).text, T(k).buttons, 'rejected');  // alte, abgelehnte Fassung vor der freigegebenen
  add(TC.nameFor(k, 0), T(k).text, T(k).buttons, k === 'fi_week_nudge' ? 'pending' : 'approved', T(k).category);
}

const H = require(path.join(ROOT, 'api/team/journeys.js'));
const Config = require(path.join(ROOT, 'lib/journeys/config.js'));
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
  const n = keys.length;

  // 1. Seite öffnen: der Abgleich läuft von selbst, legt nichts an
  let r = await call('GET', '/api/team/journeys');
  const cat = (k) => r.json.templates.find((t) => t.key === k);
  ok('1. Übersicht verknüpft automatisch (über alle Listenseiten)', cat('fi_lead_last').sid && cat('fi_habit_below').sid && count(/^GET \/v2\/ContentAndApprovals$/) >= 3, JSON.stringify(r.json.twilio));
  ok('1a. nichts angelegt, nichts eingereicht, nichts gelöscht', count(CREATE) === 0 && count(APPROVE) === 0 && count(DELETE) === 0);
  ok('1b. freigegebene sind sofort verwendbar', cat('fi_trial_2h').ready && cat('fi_trial_2h').status === 'approved' && cat('fi_trial_2h').linked);
  ok('1c. in Prüfung: verknüpft, noch nicht verwendbar', cat('fi_week_nudge').sid && cat('fi_week_nudge').status === 'pending' && !cat('fi_week_nudge').ready);
  ok('1d. anderer Name, gleicher Text: über den Text gefunden', cat('fi_streak').ready && cat('fi_streak').name === 'fi_streak_chrome' && !cat('fi_streak').bodyDiff);
  ok('1e. gleicher Name, abweichender Text: verknüpft und markiert', cat('fi_trial_24h').ready && cat('fi_trial_24h').bodyDiff);
  ok('1f. bei zwei Fassungen gewinnt die freigegebene', cat('fi_comeback_2').status === 'approved');
  ok('1g. fehlende bleibt offen, fremde Vorlage bleibt unbeachtet', !cat('fi_invite').sid && r.json.twilio.open === 1 && !Object.values((await Config.load(true)).templates).some((c) => c && c.name === 'login_code'));
  ok('1h. Abgleich ist vermerkt (Einreichen jetzt freigegeben)', !!r.json.twilio.lastSync);
  ok('1i. keine Zugangsdaten in der Antwort', r.raw.indexOf(TOKEN) < 0 && r.raw.indexOf(AC) < 0);

  // 2. „Mit Twilio abgleichen" meldet den Stand
  r = await call('POST', '/api/team/journeys', { action: 'twilio_sync' });
  ok('2. Abgleich meldet: fi_invite fehlt, nichts neu verknüpft, Zahl der Freigegebenen', r.json.ok && r.json.missing.join() === 'fi_invite' && r.json.linked.length === 0 && r.json.approved === n - 2, JSON.stringify(r.json));
  ok('2a. weiterhin nichts angelegt', count(CREATE) === 0 && count(APPROVE) === 0);

  // 3. Fehlende einreichen: genau eine
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit' });
  ok('3. nur fi_invite angelegt und eingereicht', r.json.ok && r.json.submitted === 1 && r.json.results.map((x) => x.key).join() === 'fi_invite' && count(CREATE) === 1 && count(APPROVE) === 1, JSON.stringify(r.json));
  ok('3a. fi_streak (anderer Name) nicht doppelt angelegt', TW.contents.filter((c) => c.types['twilio/text'].body === T('fi_streak').text).length === 1);
  r = await call('POST', '/api/team/journeys', { action: 'twilio_submit', keys: ['fi_streak', 'fi_trial_24h'] });
  ok('3b. gezielt: verknüpfte werden übersprungen', r.json.results.every((x) => x.skipped) && count(CREATE) === 1);

  // 4. Abweichenden Text neu einreichen
  const old24 = (await tpl('fi_trial_24h')).sid;
  r = await call('POST', '/api/team/journeys', { action: 'twilio_resubmit', key: 'fi_trial_24h' });
  const n24 = await tpl('fi_trial_24h');
  ok('4. neue Fassung _r1 eingereicht, freigegebene alte bleibt stehen', r.json.ok && n24.sid !== old24 && /_r1$/.test(n24.name) && n24.status === 'received' && !n24.bodyDiff && TW.contents.some((c) => c.sid === old24) && count(DELETE) === 0, JSON.stringify(n24));
  r = await call('POST', '/api/team/journeys', { action: 'twilio_resubmit', key: 'fi_trial_2h' });
  ok('4a. freigegebene, gleiche Fassung: kein Neu einreichen', r.status === 400 && r.json.error === 'not_resubmittable');

  // 5. Liste nicht abrufbar: klare Meldung, nichts angelegt
  await Config.save({ templates: { fi_lead_last: {} } });
  TW.deny = true;
  r = await call('POST', '/api/team/journeys', { action: 'twilio_link' });
  ok('5. Twilio lehnt ab: Meldung, nichts verknüpft', r.status === 502 && !r.json.ok && /nicht abrufbar/.test(r.json.message) && !(await tpl('fi_lead_last')).sid);
  TW.deny = false;
  r = await call('POST', '/api/team/journeys', { action: 'twilio_link' });
  ok('5a. danach wieder verknüpft', r.json.ok && r.json.linked.join() === 'fi_lead_last' && count(CREATE) === 2);

  // 6. ohne Zugang
  delete process.env.TWILIO_AUTH_TOKEN;
  const l = await TC.link();
  ok('6. ohne Twilio-Zugang: no_twilio', !l.ok && l.error === 'no_twilio');
  process.env.TWILIO_AUTH_TOKEN = TOKEN;

  console.log(pass ? 'JOURNEYS TWILIO LINK PASS' : 'JOURNEYS TWILIO LINK FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
