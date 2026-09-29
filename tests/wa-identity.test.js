'use strict';
// WhatsApp: Mitglied an der Nummer erkennen (lib/waIdentity) und Gesundheitsdaten nur nach
// „Ja" (lib/waHealth). Eindeutige Nummer + laufender Vertrag → Antwort ohne Link; die
// Telefon-Hotline bleibt streng (kein wa:verify); geteilte Nummer → Geburtsdatum (Server
// prüft, nie im Log/Modell); drei Fehlversuche → Team; ehemaliges Mitglied → Geburtsdatum;
// unbekannt → Interessent; Gesundheitsfrage → Rückfrage, Ja/Nein/Widerruf mit Nachweis.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const PEOPLE = {
  4711: { id: 4711, firstName: 'Max', lastName: 'Muster', customerNumber: 'K1', dateOfBirth: '1990-05-24', phoneMobile: '+4915100000001' },
  4712: { id: 4712, firstName: 'Mia', lastName: 'Muster', customerNumber: 'K2', dateOfBirth: '2008-02-03', phoneMobile: '+4915100000002' },
  4713: { id: 4713, firstName: 'Ben', lastName: 'Muster', customerNumber: 'K3', dateOfBirth: '1988-11-11', phoneMobile: '+4915100000002' },
  4714: { id: 4714, firstName: 'Eva', lastName: 'Alt', customerNumber: 'K4', dateOfBirth: '1970-01-01', phoneMobile: '+4915100000003' },
};
const BYPHONE = { '4915100000001': [4711], '4915100000002': [4712, 4713], '4915100000003': [4714] };
const ACTIVE = { 4711: true, 4712: true, 4713: true, 4714: false };
inject('lib/members.js', {
  findAllByPhone: async (p) => (BYPHONE[String(p).replace(/\D/g, '')] || []).map((id) => PEOPLE[id]),
  findByPhone: async (p) => (BYPHONE[String(p).replace(/\D/g, '')] || []).map((id) => PEOPLE[id])[0] || null,
  getMember: async (id) => PEOPLE[id] || null,
  getContract: async (id) => ({ active: !!ACTIVE[id] }),
  createSession: async () => 't', destroySession: async () => {}, rateLimit: async () => true,
  normDePhone: (x) => { let d = String(x || '').replace(/\D/g, ''); if (d.indexOf('00') === 0) d = d.slice(2); if (d.indexOf('0') === 0) d = '49' + d.slice(1); return d; },
});
const LINKED = {};
inject('lib/leadflow.js', { resolveKnownLead: async (p) => LINKED[String(p)] || null });
const replies = [], logs = [], alerts = [];
inject('lib/studioReply.js', { applyOwnerReply: async (m, v, text) => { replies.push({ m: String(m), text: String(text) }); return { ok: true, channel: 'whatsapp' }; }, notifyStudio: async (o) => { alerts.push(o); } });
inject('lib/inbox.js', { reply: async (m, v, text) => { logs.push(String(text)); return {}; }, resolve: async () => ({}), alertTeam: async (m) => { alerts.push({ alert: String(m) }); } });
const waCalls = [];
inject('lib/finn/channels.js', { agentsOn: () => true, whatsapp: async (o) => { waCalls.push(o); return { handled: true, text: 'Dein nächster Termin ist am Freitag.' }; } });
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
inject('lib/whatsapp.js', Object.assign({}, realWA, { hasWhatsApp: true, sendText: async () => ({ ok: true }) }));

const lines = [];
const origLog = console.log;
console.log = function () { lines.push(Array.prototype.slice.call(arguments).join(' ')); };

const WAI = require(path.join(ROOT, 'lib/waIdentity.js'));
const WAH = require(path.join(ROOT, 'lib/waHealth.js'));
const WAA = require(path.join(ROOT, 'lib/waAssistant.js'));
const PhoneAuth = require(path.join(ROOT, 'lib/phoneAuth.js'));
const Privacy = require(path.join(ROOT, 'lib/privacy.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));

let mid = 0;
const inbound = (from, text, memberId) => WAA.handleInbound({ req: { headers: { host: 'mitglieder.fit-inn-trier.de', 'x-forwarded-proto': 'https' } }, memberId: memberId, msg: { from: from, text: text, id: 'm' + (++mid) }, vorgang: { id: 'v1', messages: [] } });

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; origLog((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Zuordnung
  let w = await WAI.resolve({ from: '4915100000001', name: 'Max' });
  ok('1. eindeutige Nummer + laufender Vertrag → Mitglied', w.memberId === '4711' && w.via === 'phone' && !w.isLead && !w.pick);
  w = await WAI.resolve({ from: '4915100000002' });
  ok('1a. geteilte Nummer → nachfragen (keine Person geraten)', w.via === 'choose' && w.pick && w.pick.reason === 'shared' && w.pick.candidates.length === 2 && /^wa/.test(w.memberId) && !w.isLead);
  w = await WAI.resolve({ from: '4915100000003' });
  ok('1b. kein laufender Vertrag → nachfragen', w.via === 'choose' && w.pick.reason === 'former');
  w = await WAI.resolve({ from: '4915199999999', name: 'Neu' });
  ok('1c. unbekannt → Interessent', w.isLead && w.via === 'lead');
  LINKED['4915100000009'] = { id: '4799', name: 'Verknüpft' };
  w = await WAI.resolve({ from: '4915100000009' });
  ok('1d. gemerkte Verknüpfung hat Vorrang', w.memberId === '4799' && w.via === 'linked');

  // 2. Antwort ohne Link, Hotline bleibt streng
  replies.length = 0;
  await inbound('4915100000001', 'Wann ist mein nächster Termin?', '4711');
  ok('2. erkanntes Mitglied: Antwort von FINN, kein Bestätigungs-Link', replies.some((r) => /Freitag/.test(r.text)) && !replies.some((r) => /wa-verify/.test(r.text)), JSON.stringify(replies));
  ok('2a. KI-Hinweis nennt die Erkennung per Nummer', /Handynummer aus deinem Mitgliedskonto/.test(require(path.join(ROOT, 'lib/waIntro.js')).DISCLOSURE_MEMBER));
  const st = await PhoneAuth.status('015100000001');
  ok('2b. Telefon-Hotline: Nummer gilt NICHT als verifiziert', st.verified === false && !(await require(path.join(ROOT, 'lib/waAuth.js')).getVerified('4915100000001')));
  ok('2c. ohne Einwilligung: FINN ohne Gesundheitskontext', waCalls.length === 1 && waCalls[0].noHealth === true);

  // 3. Geteilte Nummer: Geburtsdatum
  replies.length = 0; logs.length = 0;
  const who = await WAI.resolve({ from: '4915100000002' });
  let pr = await WAI.pickTurn({ msg: { from: '4915100000002', text: 'Wie lange läuft mein Vertrag?' }, memberId: who.memberId, vorgang: { id: 'p1' }, pick: who.pick });
  ok('3. erste Nachricht: Frage nach dem Geburtsdatum', pr.done && replies.length === 1 && replies[0].text === WAI.TXT.askShared);
  pr = await WAI.pickTurn({ msg: { from: '4915100000002', text: 'Hallo?' }, memberId: who.memberId, vorgang: { id: 'p1' }, pick: who.pick });
  ok('3a. kein Datum → nochmal fragen', pr.done && replies[replies.length - 1].text === WAI.TXT.again);
  pr = await WAI.pickTurn({ msg: { from: '4915100000002', text: '01.01.2000' }, memberId: who.memberId, vorgang: { id: 'p1' }, pick: who.pick });
  ok('3b. falsches Datum → kein Treffer', pr.done && replies[replies.length - 1].text === WAI.TXT.nomatch);
  pr = await WAI.pickTurn({ msg: { from: '4915100000002', text: '11.11.1988' }, memberId: who.memberId, vorgang: { id: 'p1' }, pick: who.pick });
  ok('3c. richtiges Datum → Ben gewählt, ursprüngliche Frage wird beantwortet', pr.picked === '4713' && pr.replay === 'Wie lange läuft mein Vertrag?' && /Ben/.test(replies[replies.length - 1].text), JSON.stringify(pr));
  ok('3d. Geburtsdatum nicht im Posteingang und nicht im Log', !logs.some((t) => /1988|01\.01\.2000/.test(t)) && logs.indexOf('(Geburtsdatum angegeben)') >= 0 && !lines.some((l) => /1988/.test(l)), JSON.stringify(logs));
  w = await WAI.resolve({ from: '4915100000002' });
  ok('3e. gemerkt: nächste Nachricht direkt als Ben', w.memberId === '4713' && w.via === 'pick');
  BYPHONE['4915100000002'] = [4712];   // Nummer hängt nicht mehr an Ben
  w = await WAI.resolve({ from: '4915100000002' });
  ok('3f. Wahl gilt nur, solange die Nummer noch am Konto hängt', w.memberId === '4712' && w.via === 'phone');

  // 4. Drei Fehlversuche → Team
  replies.length = 0; alerts.length = 0;
  const w4 = await WAI.resolve({ from: '4915100000003' });
  await WAI.pickTurn({ msg: { from: '4915100000003', text: 'Frage' }, memberId: w4.memberId, vorgang: { id: 'p2' }, pick: w4.pick });
  for (const d of ['01.01.1971', '02.01.1970', '03.01.1970']) await WAI.pickTurn({ msg: { from: '4915100000003', text: d }, memberId: w4.memberId, vorgang: { id: 'p2' }, pick: w4.pick });
  ok('4. drei falsche Daten → Übergabe ans Team', replies[replies.length - 1].text === WAI.TXT.handoff && alerts.length >= 1);

  // 5. Geburtsdatum-Formate
  ok('5. Formate', WAI.parseDob('24.05.1990') === '1990-05-24' && WAI.parseDob('24.5.90') === '1990-05-24' && WAI.parseDob('1990-05-24') === '1990-05-24'
    && WAI.parseDob('24/05/1990') === '1990-05-24' && WAI.parseDob('31.02.1990') === null && WAI.parseDob('hallo') === null);

  // 6. Gesundheitsdaten nur nach „Ja"
  replies.length = 0; waCalls.length = 0;
  await inbound('4915100000001', 'Wie hat sich mein Körperfett laut InBody entwickelt?', '4711');
  ok('6. Gesundheitsfrage ohne Einwilligung → feste Rückfrage, keine KI', replies.some((r) => r.text === WAH.CONSENT_TEXT) && waCalls.length === 0);
  await inbound('4915100000001', 'Ja', '4711');
  const cons = await Privacy.listConsents('4711');
  ok('6a. „Ja" → ursprüngliche Frage mit Gesundheitskontext + Nachweis', waCalls.length === 1 && waCalls[0].noHealth === false && /Körperfett/.test(waCalls[0].text)
    && cons.some((c) => c.type === 'wa_ai_health' && c.granted === true), JSON.stringify(waCalls));
  await inbound('4915100000001', 'Und meine Werte vom letzten Monat?', '4711');
  ok('6b. danach ohne erneute Rückfrage', waCalls.length === 2 && waCalls[1].noHealth === false);
  replies.length = 0;
  await inbound('4915100000001', 'Gesundheitsdaten aus', '4711');
  ok('6c. Widerruf im Chat', replies.some((r) => r.text === WAH.TXT.off) && !(await WAH.has('4915100000001', '4711')) && (await Privacy.listConsents('4711'))[0].granted === false);
  waCalls.length = 0;
  await inbound('4915100000001', 'Wie ist mein BMI?', '4711');
  await inbound('4915100000001', 'Nein', '4711');
  ok('6d. „Nein" → Antwort ohne Gesundheitskontext', waCalls.length === 1 && waCalls[0].noHealth === true && /BMI/.test(waCalls[0].text));
  await require(path.join(ROOT, 'lib/waAuth.js')).setVerified('4915100000004', '4715', 'wa-finn-2026-07');
  waCalls.length = 0;
  await inbound('4915100000004', 'Wie ist mein BMI?', '4715');
  ok('6e. früher per Link bestätigt → Gesundheitskontext ohne Rückfrage', waCalls.length === 1 && waCalls[0].noHealth === false);

  // 7. Logs ohne Nachrichtentext
  ok('7. [wa-assist]-Zeilen ohne Nachrichtentext', !lines.filter((l) => /\[wa-assist\]/.test(l)).some((l) => /Körperfett|Termin|Vertrag/.test(l)));

  console.log = origLog;
  await KV.del('x');
  console.log(pass ? 'WA IDENTITY PASS' : 'WA IDENTITY FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log = origLog; console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
