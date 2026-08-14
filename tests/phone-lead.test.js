'use strict';
// Rufnummer -> Kunde. Der Weg, ueber den ein Anrufer seinen bereits gebuchten
// Termin wiederfindet.
//
// Gebucht wird ueber verschiedene Kanaele: Telefon, Website, Team, oder direkt
// in Magicline. Abgesagt wird gern telefonisch - dann liegt nur die Rufnummer
// vor. Genau daran ist es gescheitert: ein Probetraining legt in Magicline einen
// LEAD an, und /customers/search findet vor allem Mitglieder.
//
// Hier laeuft der Speicher wirklich (kleine In-Memory-Nachbildung), damit die
// Zuordnung nicht nur im Quelltext, sondern im Verhalten geprueft wird.
process.env.PHONE_KEY = 'test-key-1234567890';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ── Speicher-Nachbildung: nur die Befehle, die hier gebraucht werden ──
const DB = new Map();
function run(cmd) {
  const op = String(cmd[0]).toUpperCase();
  if (op === 'GET') return DB.has(cmd[1]) ? DB.get(cmd[1]) : null;
  if (op === 'SET') { DB.set(cmd[1], cmd[2]); return 'OK'; }
  if (op === 'DEL') { const had = DB.delete(cmd[1]); return had ? 1 : 0; }
  if (op === 'INCR') { const v = (Number(DB.get(cmd[1])) || 0) + 1; DB.set(cmd[1], String(v)); return v; }
  return null;   // EXPIRE, ZADD, LPUSH … interessieren hier nicht
}
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { hasStore: true, redisPipeline: async (cmds) => cmds.map(run) } };

// Magicline wird nicht angefasst - members.js braucht hier nur normDePhone.
const P = require(path.join(ROOT, 'lib/phoneApi.js'));
const Leads = require(path.join(ROOT, 'lib/leadflow.js'));

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// Dieselbe Nummer, wie sie am Telefon, im Formular und aus Magicline ankommt.
const SCHREIBWEISEN = ['0151 2044 2244', '015120442244', '+4915120442244',
  '004915120442244', '+49 151 2044 2244'];

(async function () {
  // ── 1. Merker aus der Buchung ──
  await P.rememberLead('015120442244', { customerId: 4711, customerNumber: 'M-1177' });

  const treffer = [];
  for (const v of SCHREIBWEISEN) {
    const r = await P.lookupLead(v);
    treffer.push(r && r.customerId);
  }
  ok('1. Jede Schreibweise findet denselben Kunden',
    treffer.every(function (t) { return t === '4711'; }), JSON.stringify(treffer));
  ok('1b. Die Kundennummer kommt mit', (await P.lookupLead('+4915120442244')).customerNumber === 'M-1177');

  // Eine ANDERE Nummer darf nichts finden - sonst waere die Zuordnung wertlos.
  ok('2. Fremde Nummer findet nichts', (await P.lookupLead('015199999999')) === null);
  ok('2b. Unsinn findet nichts und wirft nicht',
    (await P.lookupLead('')) === null && (await P.lookupLead('abc')) === null);

  // Gespeichert wird NUR die Zuordnung. Kein Name, kein Geburtsdatum.
  const roh = Array.from(DB.entries()).filter(function (e) { return e[0].indexOf('phone:lead:') === 0; });
  ok('3. Genau ein Eintrag pro Nummer', roh.length === 1, JSON.stringify(roh));
  ok('3b. Der Eintrag enthaelt keine personenbezogenen Inhalte',
    !/name|gebur|birth|mail|stra|adress/i.test(roh[0][1]), roh[0][1]);

  // Ohne customerId gibt es nichts zu merken.
  const vorher = DB.size;
  await P.rememberLead('015133333333', { customerNumber: 'M-9' });
  ok('4. Ohne Kunden-ID wird nichts gespeichert', DB.size === vorher);

  // ── 2. Interessenten-Bestand (aus den Magicline-Webhooks) ──
  // Deckt die Faelle ab, die NIE ueber uns liefen: Buchung direkt in Magicline
  // oder ueber einen anderen Kanal. Der Webhook legt den Lead an - in der
  // Schreibweise, die Magicline liefert.
  DB.set('leadp:phone:4915177778888', 'L42');
  DB.set('leadp:v:L42', JSON.stringify({ id: 'L42', customerId: '9001', name: 'Test Person' }));

  const l1 = await Leads.getLeadByPhone('+4915177778888');
  ok('5. Lead wird ueber die internationale Form gefunden', !!l1 && l1.customerId === '9001');
  const l2 = await Leads.getLeadByPhone('015177778888');
  ok('5b. … und ueber die nationale Schreibweise genauso',
    !!l2 && l2.customerId === '9001', JSON.stringify(l2));
  const l3 = await Leads.getLeadByPhone('0151 7777 8888');
  ok('5c. … auch mit Leerzeichen', !!l3 && l3.customerId === '9001');
  ok('6. Fremde Nummer findet keinen Lead', (await Leads.getLeadByPhone('015100000000')) === null);
  ok('6b. Zu kurze Eingabe wird abgewiesen', (await Leads.getLeadByPhone('123')) === null);

  // Umgekehrt: national indiziert, international gefragt.
  DB.set('leadp:phone:015166665555', 'L43');
  DB.set('leadp:v:L43', JSON.stringify({ id: 'L43', customerId: '9002' }));
  const l4 = await Leads.getLeadByPhone('+4915166665555');
  ok('7. National gespeichert, international gefragt', !!l4 && l4.customerId === '9002', JSON.stringify(l4));

  // Ein Index ohne passenden Datensatz darf nicht als Treffer gelten.
  DB.set('leadp:phone:4915100001111', 'L99');
  ok('8. Verwaister Index liefert keinen halben Treffer',
    (await Leads.getLeadByPhone('+4915100001111')) === null);

  console.log(pass ? 'PHONE-LEAD PASS' : 'PHONE-LEAD FAIL');
  process.exit(pass ? 0 : 1);
})();
