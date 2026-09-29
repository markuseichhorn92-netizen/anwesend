'use strict';
// Team-Antwort per WhatsApp (lib/studioReply.applyOwnerReply) mit 24-h-Fenster:
// offen -> Freitext · zu -> Vorlage (sonst Mail) · unbekannt -> Vorlage, wenn vorhanden.
// Vorher meldete der Anbieter Freitext außerhalb des Fensters als „ok" und die Vorlage kam nie dran.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const R = require('./_memredis').create();
inject('lib/store.js', R.store);
const calls = [];
let hasText = true;
const realWA = require(path.join(ROOT, 'lib/whatsapp.js'));
const WA = Object.assign({}, realWA, {
  hasWhatsApp: true,
  sendText: async () => { calls.push('text'); return { ok: true, id: 'SMt' }; },
  sendFreeText: async () => { calls.push('template'); return { ok: true, id: 'SMf' }; },
  sendButtons: async () => ({ ok: false }),
});
Object.defineProperty(WA, 'hasWaText', { get: () => hasText });
inject('lib/whatsapp.js', WA);
inject('lib/members.js', { getMember: async () => ({ firstName: 'Max', email: 'max@x.de' }) });
const mails = [];
inject('lib/mail.js', { hasMail: true, sendMail: async () => ({ ok: true }), sendMailRaw: async (o) => { mails.push(o.to); return { ok: true, id: 'm1' }; } });
inject('lib/push.js', { notifyMember: async () => {}, sendToMember: async () => {}, sendToTeam: async () => {}, hasPush: false });
inject('lib/magic.js', { memberLink: async () => 'https://x/postfach' });

const Inbox = require(path.join(ROOT, 'lib/inbox.js'));
const SR = require(path.join(ROOT, 'lib/studioReply.js'));
const Window = require(path.join(ROOT, 'lib/journeys/window.js'));

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };
  const P = '4915188880001';
  const v = await Inbox.addVorgang('900', { type: 'whatsapp', channel: 'whatsapp', phone: P, subject: 'WA', notifyTeam: false });

  await Window.touch(P, Date.now() - 3600000);
  calls.length = 0; let r = await SR.applyOwnerReply('900', v.id, 'Hallo 1');
  ok('1. Fenster offen: Freitext', r.channel === 'whatsapp' && calls.join() === 'text', calls.join());

  await Window.touch(P, Date.now() - 30 * 3600000);
  calls.length = 0; r = await SR.applyOwnerReply('900', v.id, 'Hallo 2');
  ok('2. Fenster zu: genehmigte Vorlage, kein Freitext', r.channel === 'whatsapp' && calls.join() === 'template', calls.join());

  hasText = false; calls.length = 0; mails.length = 0;
  r = await SR.applyOwnerReply('900', v.id, 'Hallo 3');
  ok('3. Fenster zu, keine Vorlage: Mail statt Freitext ins Leere', r.channel === 'email' && calls.length === 0 && mails.length === 1, JSON.stringify({ c: calls, ch: r.channel }));

  const P2 = '4915188880002';
  const v2 = await Inbox.addVorgang('901', { type: 'whatsapp', channel: 'whatsapp', phone: P2, subject: 'WA', notifyTeam: false });
  hasText = true; calls.length = 0;
  r = await SR.applyOwnerReply('901', v2.id, 'Hallo 4');
  ok('4. Fenster unbekannt + Vorlage: Vorlage (kommt immer an)', calls.join() === 'template', calls.join());
  hasText = false; calls.length = 0;
  r = await SR.applyOwnerReply('901', v2.id, 'Hallo 5');
  ok('5. Fenster unbekannt, keine Vorlage: wie bisher Freitext', calls.join() === 'text', calls.join());

  console.log(pass ? 'STUDIO REPLY WINDOW PASS' : 'STUDIO REPLY WINDOW FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
