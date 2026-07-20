'use strict';
// lib/loginCode.js – Zustell-Zuverlässigkeit:
//   * meldet nur ECHTE Zustellung (channel), kein "gesendet" bei Fehlschlag
//   * Cross-Fallback in BEIDE Richtungen (E-Mail ↔ WhatsApp)
// Gegen In-Memory-Mocks (kein echter Mail-/WhatsApp-Versand).
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fresh = (rel) => { const p = path.resolve(ROOT, rel); delete require.cache[p]; return require(p); };

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  let mailOk = true, waOk = true;
  const calls = { mail: 0, wa: 0 };

  inject('lib/members.js', {
    otpSave: async () => {}, mlinkSave: async () => {}, hashCode: (c) => 'h' + c,
    getMember: async () => ({ phonePrivate: '015112345678' }),
  });
  inject('lib/mail.js', { hasMail: true, sendMailRaw: async () => { calls.mail++; return { ok: mailOk }; } });
  inject('lib/whatsapp.js', { hasWaLogin: true, sendLoginTemplate: async () => { calls.wa++; return { ok: waOk }; } });
  inject('lib/emailTemplate.js', { renderEmail: () => ({ text: 't', html: 'h' }) });

  const { sendLoginCode } = fresh('lib/loginCode.js');
  const member = { id: 'M1', email: 'a@b.c', firstName: 'Max', phonePrivate: '015112345678' };
  const reset = () => { calls.mail = 0; calls.wa = 0; };

  // 1. E-Mail bevorzugt + OK -> channel=email, KEIN WhatsApp
  mailOk = true; waOk = true; reset();
  let r = await sendLoginCode(member, 'host', { channel: 'email' });
  ok('1. E-Mail OK -> channel=email + challenge, kein WA', r.channel === 'email' && !!r.challenge && calls.wa === 0);

  // 2. E-Mail bevorzugt, Mail scheitert -> Fallback WhatsApp
  mailOk = false; waOk = true; reset();
  r = await sendLoginCode(member, 'host', { channel: 'email' });
  ok('2. Mail scheitert -> Fallback WhatsApp', r.channel === 'whatsapp' && calls.mail === 1 && calls.wa === 1);

  // 3. WhatsApp bevorzugt + OK -> channel=whatsapp, KEINE Mail
  mailOk = true; waOk = true; reset();
  r = await sendLoginCode(member, 'host', { channel: 'whatsapp' });
  ok('3. WhatsApp OK -> channel=whatsapp, keine Mail', r.channel === 'whatsapp' && calls.mail === 0);

  // 4. WhatsApp bevorzugt, WA scheitert -> Fallback E-Mail
  mailOk = true; waOk = false; reset();
  r = await sendLoginCode(member, 'host', { channel: 'whatsapp' });
  ok('4. WA scheitert -> Fallback E-Mail', r.channel === 'email' && calls.wa === 1 && calls.mail === 1);

  // 5. Beide scheitern -> channel=null (ehrlich, kein falsches "gesendet")
  mailOk = false; waOk = false; reset();
  r = await sendLoginCode(member, 'host', { channel: 'email' });
  ok('5. Beide scheitern -> channel=null, challenge trotzdem da', r.channel === null && !!r.challenge);

  console.log(pass ? 'LOGIN-CODE PASS' : 'LOGIN-CODE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
