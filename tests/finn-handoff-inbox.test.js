'use strict';
// FINN-Übergabe ans Team: der interne Kontext (Grund, Zusammenfassung, Agentenpfad) gehört
// in die Team-Notiz, nie als Team-Nachricht mit „Bestätigen" ins Postfach des Mitglieds.
// Und api/member/inbox.js gibt keine Notizen aus. Echte lib/inbox.js auf dem Redis-Nachbau.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.MAGICLINE_MODE = 'mock';
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
global.fetch = async function () { throw new Error('NETZ VERBOTEN im Test'); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const teamPushes = [];
inject('lib/push.js', { hasPush: true, sendToTeam: async (o) => { teamPushes.push(o); }, sendToMember: async () => {}, notifyMember: async () => {} });
const studio = [];
inject('lib/studioReply.js', { notifyStudio: async (o) => { studio.push(o); return { ok: true }; } });
let SESSION = { id: '1001' }; let BODY = {};
inject('lib/members.js', {
  getMember: async (id) => (String(id) === '1001' ? { id: 1001, firstName: 'Test', lastName: 'Mitglied' } : null),
  getSession: async (t) => (t === 'tok' ? SESSION : null), bearer: () => 'tok',
  readBody: async () => BODY, rateLimit: async () => true,
});
inject('lib/mail.js', { hasMail: false, sendMail: async () => ({ ok: true }) });
inject('lib/handled.js', { record: async () => {} });

const Inbox = require(path.join(ROOT, 'lib/inbox.js'));
const Handoff = require(path.join(ROOT, 'lib/finn/handoff.js'));
const api = require(path.join(ROOT, 'api/member/inbox.js'));

function res0() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, body: null, end(s) { this.body = s; } }; }
async function call(method, body, url) { const res = res0(); BODY = body || {}; await api({ method: method, url: url || '/api/member/inbox', headers: {} }, res); let j = null; try { j = JSON.parse(res.body); } catch (e) {} return { status: res.statusCode, json: j }; }

const REASON = 'Kündigungswunsch GEHEIMGRUND';
const SUMMARY = 'Mitglied GEHEIMZUSAMMENFASSUNG möchte kündigen.';
// Was das Mitglied im Postfach zu sehen bekommt: Betreff und Nachrichten.
const visible = (v) => JSON.stringify({ subject: v.subject, messages: v.messages });

(async function () {
  // ── 1. Neue Übergabe aus dem App-Chat ──
  const ctx = { actor: { kind: 'member', id: '1001' }, channel: 'web', agent: 'contract', agentPath: ['concierge', 'contract'], attempted: [{ tool: 'get_contract', status: 'ok' }], traceId: 't1' };
  const r = await Handoff.create(ctx, { reason: REASON, summary: SUMMARY });
  ok('1. Übergabe erzeugt einen Vorgang', r.ok && r.vorgangId, JSON.stringify(r));
  const v = await Inbox.get('1001', r.vorgangId);
  const msgs = (v && v.messages) || [];
  ok('1a. Keine Team-Nachricht im Mitglieder-Thread', msgs.every((m) => m.from !== 'team'), JSON.stringify(msgs));
  ok('1b. Kein needsAction („Bestätigen")', msgs.every((m) => !m.needsAction));
  ok('1c. Genau ein neutraler System-Satz', msgs.length === 1 && msgs[0].from === 'system' && msgs[0].text === Handoff.MEMBER_TEXT, JSON.stringify(msgs));
  ok('1d. Betreff und Nachrichten ohne internen Kontext', !/GEHEIM|Agentenpfad|get_contract|übergeben\./.test(visible(v)) && v.subject.indexOf('FINN-Übergabe') < 0, visible(v));
  const note = (v.notes || [])[0] || {};
  ok('1e. Kontextpaket als FINN-Notiz (nur Team)', v.notes.length === 1 && note.author === 'FINN' && note.text.indexOf(Handoff.INTERNAL_PREFIX) === 0
    && /GEHEIMGRUND/.test(note.text) && /GEHEIMZUSAMMENFASSUNG/.test(note.text) && /Agentenpfad: concierge → contract/.test(note.text), JSON.stringify(v.notes));
  ok('1f. Team wird wie bisher alarmiert (neu, ungelesen, Push)', v.teamStatus === 'neu' && v.teamUnread === true && teamPushes.length === 1);
  ok('1g. Studio-Mail mit vollem Kontext', studio.length === 1 && /GEHEIMGRUND/.test(studio[0].subject) && /GEHEIMZUSAMMENFASSUNG/.test(studio[0].text));

  // ── 2. Übergabe in einem bestehenden WhatsApp-Vorgang ──
  const wa = await Inbox.addVorgang('1001', { type: 'whatsapp', subject: 'WhatsApp', channel: 'whatsapp', notifyTeam: false, teamStatus: 'bearbeitung', teamUnread: false });
  await Inbox.reply('1001', wa.id, 'Ich will kündigen', null, { notifyTeam: false });
  const before = (await Inbox.get('1001', wa.id)).messages.length;
  teamPushes.length = 0;
  const r2 = await Handoff.create(Object.assign({}, ctx, { channel: 'whatsapp', vorgangId: wa.id }), { reason: REASON, summary: SUMMARY });
  const w = await Inbox.get('1001', wa.id);
  ok('2. WhatsApp: kein zweiter Vorgang, Notiz + Team-Alarm', r2.vorgangId === wa.id && (await Inbox.list('1001')).length === 2
    && w.notes.length === 1 && w.notes[0].author === 'FINN' && w.teamStatus === 'neu' && w.teamUnread === true && teamPushes.length === 1);
  ok('2a. WhatsApp: keine neue Mitgliedernachricht', w.messages.length === before && !/GEHEIM/.test(visible(w)));

  // ── 3. Mitglieder-API gibt keine Notizen aus ──
  const list = await call('GET');
  ok('3. GET-Liste ohne notes', list.status === 200 && list.json.ok && list.json.vorgaenge.length === 2 && list.json.vorgaenge.every((x) => !('notes' in x)), JSON.stringify(list.json).slice(0, 300));
  ok('3a. GET-Liste ohne internen Kontext', !/GEHEIM|Agentenpfad/.test(JSON.stringify(list.json)));
  const one = await call('GET', null, '/api/member/inbox?id=' + encodeURIComponent(r.vorgangId));
  ok('3b. GET ?id ohne notes', one.json.ok && one.json.vorgang && !('notes' in one.json.vorgang) && !/GEHEIM/.test(JSON.stringify(one.json)));
  const rd = await call('POST', { action: 'read', id: wa.id });
  ok('3c. read ohne notes', rd.json.ok && !('notes' in rd.json.vorgang));
  const rp = await call('POST', { action: 'reply', id: wa.id, text: 'Danke' });
  ok('3d. reply ohne notes', rp.json.ok && !('notes' in rp.json.vorgang) && !/GEHEIM/.test(JSON.stringify(rp.json)));
  const rs = await call('POST', { action: 'resolve', id: r.vorgangId });
  ok('3e. resolve ohne notes', rs.json.ok && !('notes' in rs.json.vorgang));
  ok('3f. Notizen bleiben fürs Team gespeichert', (await Inbox.get('1001', r.vorgangId)).notes.length === 1 && (await Inbox.get('1001', wa.id)).notes.length === 1);

  // ── 4. Altfall: Kontext wurde früher als teamText mit needsAction gespeichert ──
  const old = await Inbox.addVorgang('1001', { type: 'allgemein', subject: 'Altfall', systemText: 'System', teamText: Handoff.contextText(ctx, { reason: REASON, summary: SUMMARY }), needsAction: true, notifyTeam: false });
  const legacy = await call('GET', null, '/api/member/inbox?id=' + encodeURIComponent(old.id));
  const lm = legacy.json.vorgang.messages;
  ok('4. Altfall: kein „Bestätigen", kein interner Text', lm.every((m) => !m.needsAction) && !/GEHEIM|Agentenpfad/.test(JSON.stringify(lm)) && lm.some((m) => m.text === Handoff.MEMBER_TEXT), JSON.stringify(lm));
  const stored = await Inbox.get('1001', old.id);
  ok('4a. Altfall: Speicher unverändert (nur Ausgabe entschärft)', stored.messages.some((m) => m.needsAction && /GEHEIMGRUND/.test(m.text)));
  const normal = await Inbox.addVorgang('1001', { type: 'kontakt', subject: 'Kontakt', teamText: 'Bitte bestätige den Termin.', needsAction: true, notifyTeam: false });
  const nm = (await call('GET', null, '/api/member/inbox?id=' + normal.id)).json.vorgang.messages;
  ok('4b. Normale Team-Nachricht mit „Bestätigen" bleibt unverändert', nm.length === 1 && nm[0].needsAction === true && nm[0].text === 'Bitte bestätige den Termin.');

  console.log(pass ? 'FINN-HANDOFF-INBOX PASS' : 'FINN-HANDOFF-INBOX FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
