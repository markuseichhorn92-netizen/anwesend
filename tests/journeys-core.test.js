'use strict';
// FINN Journeys – reine Bausteine: Nummernform, Ruhezeiten (Sommerzeit, Feiertage RLP),
// Check-in-Kennzahlen + Einstufung (inkl. Wochenserie wie lib/social.checkinVitals),
// Vorlagen-Texte, KV-Speicher-Fallback für sortierte Mengen und Hashes.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
delete process.env.VERCEL_ENV; process.env.NODE_ENV = 'test';

const Phone = require(path.join(ROOT, 'lib/phone.js'));
const Quiet = require(path.join(ROOT, 'lib/journeys/quiet.js'));
const Eng = require(path.join(ROOT, 'lib/journeys/engagement.js'));
const T = require(path.join(ROOT, 'lib/journeys/templates.js'));
const KV = require(path.join(ROOT, 'lib/finn/kv.js'));
const Social = require(path.join(ROOT, 'lib/social.js'));

// Berlin-Ortszeit -> ms (Sommerzeit UTC+2 bis 25.10.2026, danach UTC+1)
function berlin(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi || 0);
  for (const off of [1, 2]) { const t = guess - off * 3600000; const p = Quiet.parts(t); if (p.hh === h && p.mm === (mi || 0) && p.d === d) return t; }
  return guess;
}
const DAY = 86400000;

(async function () {
  let pass = true; const ok = (l, c, x) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (x || ''))); };

  // 1. Nummernform
  ok('1. 0151… -> 49151…', Phone.canon('0151 234 56789') === '4915123456789');
  ok('1a. +49 / 0049 / whatsapp: gleich', Phone.canon('+49 151 23456789') === '4915123456789' && Phone.canon('0049151 23456789') === '4915123456789' && Phone.canon('whatsapp:+4915123456789') === '4915123456789');
  ok('1b. zu kurz -> leer', Phone.canon('123') === '');
  ok('1c. Varianten enthalten alte Schreibweisen', ['4915123456789', '015123456789', '004915123456789'].every((v) => Phone.variants('0151 23456789').indexOf(v) >= 0));
  ok('1d. same()', Phone.same('0151-23456789', '+4915123456789') && !Phone.same('0151', '0151'));

  // 2. Ruhezeiten
  ok('2. Service Di 07:30 erlaubt', Quiet.allowed(berlin(2026, 9, 29, 7, 30), 'service'));
  ok('2a. Service 21:05 nicht erlaubt', !Quiet.allowed(berlin(2026, 9, 29, 21, 5), 'service'));
  ok('2b. Marketing Di 08:30 nicht, 09:00 ja', !Quiet.allowed(berlin(2026, 9, 29, 8, 30), 'marketing') && Quiet.allowed(berlin(2026, 9, 29, 9, 0), 'marketing'));
  ok('2c. Marketing Sonntag nie', !Quiet.allowed(berlin(2026, 10, 4, 12, 0), 'marketing'));
  ok('2d. Service Sonntag mittags erlaubt', Quiet.allowed(berlin(2026, 10, 4, 12, 0), 'service'));
  ok('2e. Tag der Deutschen Einheit (Sa 3.10.) kein Marketing', !Quiet.allowed(berlin(2026, 10, 3, 12, 0), 'marketing'));
  ok('2f. Fronleichnam 2026 (4.6.) Feiertag RLP', Quiet.holidays(2026).has('20260604'));
  const sat1930 = berlin(2026, 10, 10, 19, 45);
  const nx = Quiet.nextAllowed(sat1930, 'marketing');
  const pnx = Quiet.parts(nx);
  ok('2g. Sa 19:45 -> nächster Marketing-Slot Mo 09:00 (So ausgelassen)', pnx.wd === 1 && pnx.hh === 9 && pnx.mm === 0, JSON.stringify(pnx));
  const dst = Quiet.nextAllowed(berlin(2026, 10, 25, 1, 30), 'service');
  ok('2h. Zeitumstellung (25.10.): Service ab 07:00 Ortszeit', Quiet.parts(dst).hh === 7 && Quiet.parts(dst).d === 25, JSON.stringify(Quiet.parts(dst)));
  ok('2i. nextDayStart ist 00:xx des Folgetags', Quiet.parts(Quiet.nextDayStart(berlin(2026, 9, 29, 15, 0))).d === 30);

  // 3. Kennzahlen + Einstufung
  const now = berlin(2026, 9, 29, 12, 0);
  const h = { tot: '40', bf: '1', last: String(now - 2 * DAY), lastYmd: Eng.ymd(now - 2 * DAY) };
  // letzte 4 Wochen: 2 Besuche pro Woche (Mo + Do), heute Di
  for (let w = 0; w < 6; w++) { [0, 3].forEach((dd) => { const t = berlin(2026, 9, 28, 12, 0) - w * 7 * DAY + dd * DAY; if (t <= now) { h['d:' + Eng.ymd(t)] = '1'; const wk = 'w:' + Eng.weekKey(t); h[wk] = String((Number(h[wk]) || 0) + 1); } }); }
  const m = Eng.metrics(h, now, 2);
  ok('3. v28 zählt Besuchstage der letzten 28 Tage', m.v28 >= 7 && m.v28 <= 8, JSON.stringify(m));
  ok('3a. Tage seit letztem Besuch', m.daysSince === 2);
  ok('3b. Wochenserie ≥ 5', m.weekStreak >= 5, String(m.weekStreak));
  ok('3c. Einstufung auf_kurs (Ziel 2/Woche)', Eng.classify(m, {}, now) === 'auf_kurs', Eng.classify(m, {}, now));
  ok('3d. Ziel 4/Woche -> rutscht_ab', Eng.classify(Eng.metrics(h, now, 4), {}, now) === 'rutscht_ab', Eng.classify(Eng.metrics(h, now, 4), {}, now));
  ok('3e. 12 Tage weg -> inaktiv10', Eng.classify(Eng.metrics(Object.assign({}, h, { last: String(now - 12 * DAY) }), now, 2), {}, now) === 'inaktiv10');
  ok('3f. 30 Tage weg -> inaktiv28', Eng.classify(Eng.metrics(Object.assign({}, h, { last: String(now - 30 * DAY) }), now, 2), {}, now) === 'inaktiv28');
  ok('3g. gekündigt schlägt alles', Eng.classify(m, { cancelled: now }, now) === 'gekuendigt');
  ok('3h. neu in den ersten 90 Tagen', Eng.classify(m, { joinAt: now - 20 * DAY }, now) === 'neu');
  ok('3i. ohne Daten: unbekannt', Eng.classify(Eng.metrics({}, now, 2), {}, now) === 'unbekannt');
  ok('3j. visitsSince', Eng.visitsSince(h, now - 7 * DAY) === m.v7 || Eng.visitsSince(h, now - 7 * DAY) === m.v7 + 1);

  // 3k. Wochenserie wie lib/social.checkinVitals (Mittagszeiten -> keine Zeitzonen-Grenzfälle)
  const realNow = Date.now();
  const cis = []; for (let w = 1; w <= 5; w++) cis.push({ in: new Date(realNow - w * 7 * DAY).toISOString().slice(0, 10) + 'T11:00:00Z' });
  const hh = {}; cis.forEach((c) => { const t = Date.parse(c.in); hh['d:' + Eng.ymd(t)] = '1'; const wk = 'w:' + Eng.weekKey(t); hh[wk] = String((Number(hh[wk]) || 0) + 1); });
  hh.last = String(Date.parse(cis[0].in)); hh.bf = '1';
  ok('3k. Wochenserie = social.checkinVitals().weekStreak', Eng.metrics(hh, realNow, 2).weekStreak === Social.checkinVitals(cis, 2).weekStreak, Eng.metrics(hh, realNow, 2).weekStreak + ' vs ' + Social.checkinVitals(cis, 2).weekStreak);

  // 4. Vorlagen
  ok('4. render ersetzt Variablen', T.render('fi_trial_2h', { 1: 'Mara', 2: '18:30' }).indexOf('Hi Mara, gleich') === 0 && T.render('fi_trial_2h', { 1: 'Mara', 2: '18:30' }).indexOf('18:30 Uhr') > 0);
  ok('4a. ohne Namen kein „Hi ,"', T.render('fi_lead_followup', {}).indexOf('Hi,') === 0, T.render('fi_lead_followup', {}));
  ok('4b. Twilio-Variablen nie leer', T.twilioVars('fi_trial_24h', { 1: '' })['1'] === 'du' && T.twilioVars('fi_trial_24h', {})['3'] === '–');
  ok('4c. jede Vorlage hat Kategorie + Einwilligung', T.keys().every((k) => /^(UTILITY|MARKETING)$/.test(T.get(k).category) && /^(service|marketing|invite)$/.test(T.get(k).consent)));
  ok('4d. Terminerinnerungen sind UTILITY/service, Motivation MARKETING', T.get('fi_trial_24h').category === 'UTILITY' && T.get('fi_habit_below').consent === 'marketing');
  ok('4e. keine Vorlage verlangt Gesundheitsangaben', T.keys().every((k) => !/gewicht|körperfett|puls|gesundheit|diagnose/i.test(T.get(k).text)));

  // 5. KV-Fallback (ohne Store, nicht Produktion)
  KV._reset();
  await KV.zadd('z', 30, 'c'); await KV.zadd('z', 10, 'a'); await KV.zadd('z', 20, 'b');
  ok('5. zrangeByScore aufsteigend mit Limit', JSON.stringify(await KV.zrangeByScore('z', '-inf', '25', 5)) === '["a","b"]');
  ok('5a. zrevrange neueste zuerst', JSON.stringify(await KV.zrevrange('z', 0, 1)) === '["c","b"]');
  await KV.zrem('z', 'b'); ok('5b. zrem + zcard', (await KV.zcard('z')) === 2);
  await KV.ztrimTop('z', 1); ok('5c. ztrimTop behält den höchsten', JSON.stringify(await KV.zrevrange('z', 0, -1)) === '["c"]');
  await KV.hset('h', { a: 1 }); await KV.hincrby('h', 'n', 2); await KV.hincrby('h', 'n', 3);
  const hv = await KV.hgetall('h'); ok('5d. hset/hincrby/hgetall', hv.a === '1' && hv.n === '5');
  await KV.hdel('h', ['a']); ok('5e. hdel', !('a' in (await KV.hgetall('h'))));

  // 6. Push-Anstoß und WhatsApp stimmen sich ab (lib/nudge.js fragt recentlyContacted)
  const J = require(path.join(ROOT, 'lib/journeys/index.js'));
  process.env.JOURNEYS = '1';
  await KV.set('jr:st:123', { subj: '123', sent: [{ at: Date.now() - 3 * DAY, cat: 'marketing', via: 'template' }], runs: {} });
  await KV.set('jr:st:124', { subj: '124', sent: [{ at: Date.now() - 3 * DAY, cat: 'marketing', via: 'dry' }], runs: {} });
  await KV.set('jr:st:125', { subj: '125', sent: [], runs: { comeback: { startedAt: Date.now() - DAY, done: {}, exit: null } } });
  ok('6. vor 3 Tagen per WhatsApp motiviert -> kein Push', await J.recentlyContacted('123', 7));
  ok('6a. nur Probelauf zählt nicht', !(await J.recentlyContacted('124', 7)));
  ok('6b. laufendes Comeback -> kein Push', await J.recentlyContacted('125', 7));
  delete process.env.JOURNEYS;
  ok('6c. ohne JOURNEYS nie', !(await J.recentlyContacted('123', 7)));

  console.log(pass ? 'JOURNEYS CORE PASS' : 'JOURNEYS CORE FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log('FAIL Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
