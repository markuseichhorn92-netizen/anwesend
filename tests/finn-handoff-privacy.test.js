'use strict';
// FINN-Übergabe und Magicline-Automationen: interner Team-Kontext landet nur als Notiz
// (Inbox.addNote), das Mitglied sieht höchstens einen neutralen Betreff und eine
// Systemzeile – keine Team-Nachricht, keinen „Bestätigen"-Knopf. Die Mitglieder-
// Postfach-API liefert keine Notizen aus. Echte lib/inbox.js, KV im Speicher, kein Netz.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';
process.env.FINN_AUTOMATIONS = 'timeline,retention,vorgang';
global.fetch = async function () { throw new Error('NETZ VERBOTEN im Test'); };
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const pushes = [];
inject('lib/push.js', { hasPush: true, sendToTeam: async (o) => { pushes.push(o); }, sendToMember: async () => {} });
const notified = [];
inject('lib/studioReply.js', { notifyStudio: async (o) => { notified.push(o); return { ok: true }; } });
const mails = [];
inject('lib/mail.js', { hasMail: true, sendMail: async (s, t) => { mails.push({ s: s, t: t }); return { ok: true }; } });
let BODY = {};
let REQ_URL = '/api/member/inbox';
inject('lib/members.js', {
  bearer: () => 'tok', getSession: async (t) => (t === 'tok' ? { id: '1001' } : null),
  getMember: async (id) => (String(id) === '1001' ? { id: 1001, firstName: 'Test', lastName: 'Mitglied', email: 't@example.invalid' } : null),
  readBody: async () => BODY, rateLimit: async () => true,
});

const Inbox = require(path.join(ROOT, 'lib/inbox.js'));
const Handoff = require(path.join(ROOT, 'lib/finn/handoff.js'));
const Automations = require(path.join(ROOT, 'lib/finn/automations.js'));
const Events = require(path.join(ROOT, 'lib/finn/events.js'));
const memberInbox = require(path.join(ROOT, 'api/member/inbox.js'));

// Was das Mitglied sieht: Betreff + Nachrichten (so rendert mitglieder.html das Postfach).
const visible = (v) => JSON.stringify({ subject: v.subject, messages: v.messages });
const INTERNAL = /Grund:|Zusammenfassung:|Agentenpfad|Versuchte Aktionen|Kanal:|Agent:|FINN-Übergabe|Rückhol|Magicline|Beitragskonto/;

function call(method, url, body) {
  BODY = body || {}; REQ_URL = url;
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, json: JSON.parse(s) }); } };
    memberInbox({ method: method, url: REQ_URL, headers: { authorization: 'Bearer tok' } }, res);
  });
}

(async function () {
  // ── 1. Übergabe ohne bestehenden Vorgang (App/Web) ──
  const REASON = 'MARKER_GRUND Kündigungswunsch, Selbstservice nicht freigeschaltet';
  const SUMMARY = 'MARKER_SUMMARY Mitglied möchte zum nächstmöglichen Termin kündigen.';
  const ctx = { actor: { kind: 'member', id: '1001' }, channel: 'web', agent: 'contract', agentPath: ['concierge', 'contract'], attempted: [{ tool: 'get_contract', status: 'ok' }], traceId: 't1' };
  const h = await Handoff.create(ctx, { reason: REASON, summary: SUMMARY });
  ok('1. Übergabe ok mit Vorgang', h.ok && h.vorgangId, JSON.stringify(h));
  const v1 = await Inbox.get('1001', h.vorgangId);
  ok('1a. Mitglied sieht keinen internen Text', !/MARKER_/.test(visible(v1)) && !INTERNAL.test(visible(v1)), visible(v1));
  ok('1b. Keine Team-Nachricht, kein needsAction', v1.messages.every((m) => m.from !== 'team' && !m.needsAction), JSON.stringify(v1.messages));
  ok('1c. Genau eine neutrale Systemzeile', v1.messages.length === 1 && v1.messages[0].from === 'system' && /ans Team weitergegeben/.test(v1.messages[0].text));
  ok('1d. Betreff neutral (ohne Grund)', v1.subject === 'Dein Anliegen an das Team', v1.subject);
  ok('1e. Kontext als interne FINN-Notiz', v1.notes.length === 1 && v1.notes[0].author === 'FINN' && /MARKER_GRUND/.test(v1.notes[0].text) && /MARKER_SUMMARY/.test(v1.notes[0].text) && /Agentenpfad/.test(v1.notes[0].text));
  ok('1f. Team bleibt alarmiert (neu/ungelesen, Push, Studio-Mail mit Kontext)', v1.teamStatus === 'neu' && v1.teamUnread === true && pushes.length >= 1
    && notified.length === 1 && /MARKER_GRUND/.test(notified[0].subject) && /MARKER_SUMMARY/.test(notified[0].text));

  // ── 2. Übergabe in einem bestehenden (WhatsApp-)Vorgang ──
  const wa = await Inbox.addVorgang('1001', { type: 'whatsapp', subject: 'WhatsApp', channel: 'whatsapp', teamStatus: 'abgeschlossen', teamUnread: false, notifyTeam: false });
  const before = wa.messages.length;
  const h2 = await Handoff.create(Object.assign({}, ctx, { channel: 'whatsapp', vorgangId: wa.id }), { reason: REASON, summary: SUMMARY });
  const v2 = await Inbox.get('1001', wa.id);
  ok('2. Kein zweiter Vorgang, Team-Alarm gesetzt', h2.vorgangId === wa.id && v2.teamStatus === 'neu' && v2.teamUnread === true);
  ok('2a. Nur Notiz, keine neue Mitglieder-Nachricht', v2.messages.length === before && v2.notes.some((n) => n.author === 'FINN' && /MARKER_GRUND/.test(n.text)) && !/MARKER_/.test(visible(v2)));

  // ── 3. Magicline-Automationen (FINN_AUTOMATIONS=vorgang) ──
  Automations.register();
  await Events.emit({ type: 'CONTRACT_CANCELLED', cid: '1001' });
  await Events.emit({ type: 'CUSTOMER_PAYMENT_REJECTED', cid: '1001' });
  const all = await Inbox.list('1001');
  const cancel = all.find((v) => v.subject === 'Deine Kündigung');
  const pay = all.find((v) => v.subject === 'Deine Zahlung');
  ok('3. Automationen legen Vorgänge an', !!cancel && !!pay, JSON.stringify(all.map((v) => v.subject)));
  [['Kündigung', cancel], ['Zahlung', pay]].forEach(([l, v]) => {
    if (!v) return;
    ok('3a. ' + l + ': Mitglied sieht keinen internen Hinweis', !INTERNAL.test(visible(v)), visible(v));
    ok('3b. ' + l + ': keine Team-Nachricht, kein needsAction, neutrale Systemzeile', v.messages.length === 1 && v.messages[0].from === 'system' && !v.messages[0].needsAction);
    ok('3c. ' + l + ': Hinweis steht als FINN-Notiz', v.notes.length === 1 && v.notes[0].author === 'FINN' && /Magicline/.test(v.notes[0].text));
  });
  ok('3d. Rückhol-Hinweis nur intern', /Rückhol/.test(cancel.notes[0].text));

  // ── 4. Mitglieder-Postfach-API liefert keine Notizen ──
  const lst = await call('GET', '/api/member/inbox');
  ok('4. Liste ohne notes', lst.json.ok && lst.json.vorgaenge.length >= 4 && lst.json.vorgaenge.every((v) => !('notes' in v)), JSON.stringify(lst.json).slice(0, 200));
  ok('4a. Liste ohne internen Kontext', !/MARKER_|Rückhol|Beitragskonto/.test(JSON.stringify(lst.json)));
  const one = await call('GET', '/api/member/inbox?id=' + encodeURIComponent(h.vorgangId));
  ok('4b. Einzelabruf ohne notes', one.json.ok && one.json.vorgang && !('notes' in one.json.vorgang) && !/MARKER_/.test(JSON.stringify(one.json)));
  const rd = await call('POST', '/api/member/inbox', { action: 'read', id: h.vorgangId });
  ok('4c. read ohne notes', rd.json.ok && !('notes' in rd.json.vorgang));
  const rp = await call('POST', '/api/member/inbox', { action: 'reply', id: h.vorgangId, text: 'Danke!' });
  ok('4d. reply ohne notes', rp.json.ok && !('notes' in rp.json.vorgang) && !/MARKER_/.test(JSON.stringify(rp.json)));
  const rs = await call('POST', '/api/member/inbox', { action: 'resolve', id: h.vorgangId });
  ok('4e. resolve ohne notes', rs.json.ok && !('notes' in rs.json.vorgang));
  const stored = await Inbox.get('1001', h.vorgangId);
  ok('4f. Notizen bleiben fürs Team gespeichert', stored.notes.length === 1 && /MARKER_GRUND/.test(stored.notes[0].text));

  console.log(pass ? '\nALLE OK' : '\nFEHLER');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
