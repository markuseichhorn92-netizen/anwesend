'use strict';
// Wie lange braucht ein Login-Code?
//
// "Der Code kommt spaet" hat zwei ganz verschiedene Ursachen: entweder braucht
// UNSER Aufruf lange, bis der Anbieter die Nachricht annimmt - oder der Anbieter
// nimmt sie sofort an und stellt sie spaet zu. Das eine koennen wir aendern, das
// andere nicht. Ohne getrennte Messung raet man.
//
// Und was gemessen wird, darf nicht in Logs landen, was dort nicht hingehoert:
// keine Rufnummer, keine Adresse, kein Code.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};

async function run() {
  let pass = true;
  const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(k); return 1; }
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline: redisPipeline });

  let waDauer = 20, waOk = true, waId = 'wamid.TEST1';
  const gesendet = [];
  inject('lib/whatsapp.js', {
    hasWaLogin: true,
    sendLoginTemplate: async (to, code) => {
      gesendet.push({ to: to, code: code });
      await new Promise((r) => setTimeout(r, waDauer));
      return waOk ? { ok: true, id: waId } : { ok: false, error: 'x' };
    },
  });
  inject('lib/mail.js', { hasMail: true, sendMailRaw: async () => ({ ok: true }) });
  inject('lib/emailTemplate.js', { renderEmail: () => ({ text: 't', html: '<p>t</p>' }) });
  inject('lib/members.js', {
    otpSave: async () => {}, mlinkSave: async () => {}, hashCode: (c) => 'h' + c,
    getMember: async () => null,
  });

  const LC = require(path.resolve(ROOT, 'lib/loginCode.js'));

  // Logzeilen mitschneiden.
  const zeilen = [];
  const echt = console.log;
  console.log = function () { zeilen.push(Array.prototype.slice.call(arguments).join(' ')); };
  const wiederher = () => { console.log = echt; };

  const mitglied = { id: 'm1', firstName: 'Adriane', email: 'a@example.invalid', phonePrivate: '+4915100000000', referralCode: 'ABC' };

  // ── 1. WhatsApp: die Uebergabe wird gemessen ──
  waDauer = 60;
  let r = await LC.sendLoginCode(mitglied, 'host.example', { channel: 'whatsapp', phone: '+4915100000000' });
  wiederher();
  ok('1. Der Code geht ueber WhatsApp raus', r && r.channel === 'whatsapp', JSON.stringify(r && r.channel));

  const handover = zeilen.filter((z) => z.indexOf('otp_handover') === 0)[0] || '';
  const hj = (() => { try { return JSON.parse(handover.slice('otp_handover '.length)); } catch (e) { return null; } })();
  ok('2. Die Uebergabe an den Anbieter wird mit Dauer festgehalten',
    hj && hj.via === 'whatsapp' && hj.ok === true && hj.ms >= 50, JSON.stringify(hj));

  // ── 2. Zustellung: die Zeit DANACH ist die des Anbieters ──
  console.log = function () { zeilen.push(Array.prototype.slice.call(arguments).join(' ')); };
  const sek = await LC.noteDelivery('wamid.TEST1', 'delivered');
  wiederher();
  ok('3. Zu einer gemeldeten Zustellung gibt es eine Dauer', typeof sek === 'number' && sek >= 0, String(sek));
  const del = zeilen.filter((z) => z.indexOf('otp_delivery') === 0)[0] || '';
  const dj = (() => { try { return JSON.parse(del.slice('otp_delivery '.length)); } catch (e) { return null; } })();
  ok('3b. … getrennt von der Uebergabe, mit Status',
    dj && dj.status === 'delivered' && dj.via === 'whatsapp' && typeof dj.sekunden === 'number' && typeof dj.api_ms === 'number',
    JSON.stringify(dj));

  // Fremde Nachrichten (Team-Chat) gehen uns hier nichts an.
  const fremd = await LC.noteDelivery('wamid.NICHTUNSER', 'delivered');
  ok('4. Fremde Nachrichten werden nicht mitgemessen', fremd === null, String(fremd));

  // ── 3. Nichts Sensibles in den Logs ──
  const alles = zeilen.join(' | ');
  const code = gesendet.length ? String(gesendet[0].code) : '';
  ok('5. Keine Rufnummer im Log', alles.indexOf('4915100000000') < 0 && alles.indexOf('+49151') < 0, alles);
  ok('5b. Keine E-Mail-Adresse im Log', alles.indexOf('example.invalid') < 0 && alles.indexOf('a@') < 0, alles);
  ok('5c. Und vor allem NICHT der Code selbst', !!code && alles.indexOf(code) < 0, 'Code ' + code + ' in: ' + alles);
  ok('5d. Auch kein Name', alles.indexOf('Adriane') < 0, alles);

  // ── 4. Schlaegt WhatsApp fehl, wird das als Fehlschlag gemessen ──
  zeilen.length = 0;
  waOk = false;
  console.log = function () { zeilen.push(Array.prototype.slice.call(arguments).join(' ')); };
  r = await LC.sendLoginCode(mitglied, 'host.example', { channel: 'whatsapp', phone: '+4915100000000' });
  wiederher();
  ok('6. Klappt WhatsApp nicht, greift der Weg per E-Mail', r && r.channel === 'email', JSON.stringify(r && r.channel));
  const beide = zeilen.filter((z) => z.indexOf('otp_handover') === 0)
    .map((z) => { try { return JSON.parse(z.slice('otp_handover '.length)); } catch (e) { return {}; } });
  ok('6b. … und beide Versuche stehen einzeln im Log',
    beide.length === 2 && beide[0].via === 'whatsapp' && beide[0].ok === false
      && beide[1].via === 'email' && beide[1].ok === true, JSON.stringify(beide));

  // ── 5. Speicher da, aber gerade kaputt ──
  // Der gefaehrliche Fall: die Nachricht ging RAUS, nur das Festhalten der Zeit
  // scheitert. Faellt der Fehler durch, halten wir den Versand faelschlich fuer
  // gescheitert und schicken hinterher noch eine E-Mail - zwei Codes fuer eine
  // Anmeldung, und der zweite macht den ersten ungueltig.
  delete require.cache[path.resolve(ROOT, 'lib/loginCode.js')];
  inject('lib/store.js', { hasStore: true, redisPipeline: async () => { throw new Error('Speicher gerade weg'); } });
  const LC3 = require(path.resolve(ROOT, 'lib/loginCode.js'));
  waOk = true; gesendet.length = 0;
  let mails = 0;
  inject('lib/mail.js', { hasMail: true, sendMailRaw: async () => { mails++; return { ok: true }; } });
  console.log = function () {};
  let r3 = null, geworfen3 = null;
  try { r3 = await LC3.sendLoginCode(mitglied, 'host.example', { channel: 'whatsapp', phone: '+4915100000000' }); }
  catch (e) { geworfen3 = String(e && e.message); }
  wiederher();
  ok('8. Ein Speicherfehler macht aus einem Versand keinen Fehlschlag',
    !geworfen3 && r3 && r3.channel === 'whatsapp', geworfen3 || JSON.stringify(r3));
  ok('8b. … und es geht KEIN zweiter Code per E-Mail raus', mails === 0, String(mails) + ' Mails');

  // ── 6. Ohne Speicher darf nichts kaputtgehen ──
  delete require.cache[path.resolve(ROOT, 'lib/loginCode.js')];
  inject('lib/store.js', { hasStore: false, redisPipeline: async () => { throw new Error('kein Speicher'); } });
  const LC2 = require(path.resolve(ROOT, 'lib/loginCode.js'));
  waOk = true;
  console.log = function () {};
  let r2 = null, geworfen = null;
  try { r2 = await LC2.sendLoginCode(mitglied, 'host.example', { channel: 'whatsapp', phone: '+4915100000000' }); }
  catch (e) { geworfen = String(e && e.message); }
  const ohneSpeicher = await LC2.noteDelivery('wamid.TEST1', 'delivered');
  wiederher();
  ok('9. Ohne Speicher wird trotzdem zugestellt', !geworfen && r2 && r2.channel === 'whatsapp', geworfen || JSON.stringify(r2));
  ok('9b. … und die Messung meldet einfach nichts', ohneSpeicher === null, String(ohneSpeicher));

  console.log(pass ? 'LOGIN-CODE-TIMING PASS' : 'LOGIN-CODE-TIMING FAIL');
  process.exit(pass ? 0 : 1);
}
run();
