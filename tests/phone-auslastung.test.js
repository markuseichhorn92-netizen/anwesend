'use strict';
// „Ist gerade viel los?" am Telefon.
//
// Zwei Dinge koennen hier schiefgehen, und beide merkt man erst im Gespraech:
// 1. Es ist geschlossen, und der Assistent sagt trotzdem „wenig los" - dann
//    faehrt jemand vor verschlossener Tuer vor.
// 2. Der Assistent liest die genaue Personenzahl vor. Das ist eine Betriebszahl,
//    und am Telefon sitzt nicht nur Kundschaft.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
}

// ── Aufbau ──
let live = { count: 28, max: 40, percent: 70, status: 'busy' };
let offen = { open: true, text: 'Wir haben bis 23 Uhr geöffnet.', todayText: '06:00–23:00' };
let typischSlot = { typicalCount: 20, samples: 12 };
// Tageskurve: nachmittags voll, ab 20:00 (Slot 40) deutlich ruhiger.
let tagesKurve = (function () {
  const d = new Array(48).fill(0);
  for (let s = 12; s < 40; s++) d[s] = 20 + (s > 32 ? 8 : 0);
  for (let s = 40; s < 46; s++) d[s] = 8;
  return d;
})();
let jetztSlot = 36;   // 18:00

const echtesP = require(path.join(ROOT, 'lib/phoneApi.js'));
stub('lib/phoneApi.js', {
  json: (res, code, body) => { res._code = code; res._body = body; return body; },
  guard: async () => ({ ok: true }),
  openStatus: () => offen,
  loadText: echtesP.loadText,
});
stub('lib/utilization.js', { fetchUtilization: async () => live });
stub('lib/studioHours.js', { fetchHours: async () => ({ available: true }), TTL_MS: 30000 });
function storeStub(mitSpeicher) {
  return {
    hasStore: mitSpeicher,
    getTypicalSlot: async () => typischSlot,
    getTypicalDay: async () => ({ day: tagesKurve }),
    localParts: () => ({ weekday: 3, slot: jetztSlot, hour: 18, minute: 0 }),
    redisPipeline: async () => [],
  };
}
stub('lib/store.js', {
  hasStore: true,
  getTypicalSlot: async () => typischSlot,
  getTypicalDay: async () => ({ day: tagesKurve }),
  localParts: () => ({ weekday: 3, slot: jetztSlot, hour: 18, minute: 0 }),
  redisPipeline: async () => [],
});

const handler = require(path.join(ROOT, 'api/phone/auslastung.js'));

let ruf = async function () {
  const req = { method: 'GET', url: '/api/phone/auslastung', headers: {} };
  const res = { setHeader: () => {}, end: () => {} };
  await handler(req, res);
  return res._body || {};
};

(async function () {
  // ── 1. Der Normalfall ──
  let r = await ruf();
  ok('1. Auskunft gelingt', r.ok === true, JSON.stringify(r));
  ok('1b. Eine Einschaetzung steht im Text', /viel los|voll|wenig/.test(r.text || ''), r.text);

  // Der eigentliche Mehrwert: nicht „voll", sondern „voller als sonst" und
  // „ab wann ruhiger". Danach fragt der Anrufer eigentlich.
  ok('2. Der Text ordnet gegen die uebliche Zeit ein',
    /sonst um diese Zeit/.test(r.text || ''), r.text);
  ok('2b. … und nennt, ab wann es ruhiger wird',
    /Ruhiger wird es/.test(r.text || '') && /20:00/.test(r.text || ''), r.text);
  ok('2c. … auch strukturiert', r.ruhigerAb === 'ab 20:00', String(r.ruhigerAb));

  // ── 3. Betriebszahlen bleiben drinnen ──
  // 28 Personen, 70 Prozent - beides darf NICHT im vorgelesenen Satz stehen.
  ok('3. Die Personenzahl steht nicht im Text', !/\b28\b/.test(r.text || ''), r.text);
  ok('3b. Der Prozentwert steht nicht im Text',
    !/70|Prozent|%/.test(r.text || ''), r.text);
  ok('3c. … der Assistent wird ausdruecklich davon abgehalten',
    /Niemals die Personenzahl/.test(r.naechsterSchritt || ''), r.naechsterSchritt);
  // Fuer die KI selbst darf der Wert dabei sein - sie liest ihn nur nicht vor.
  ok('3d. Fuer den Assistenten liegt der Wert bereit', r.prozent === 70);

  // ── 4. Geschlossen ──
  // Der gefaehrlichste Fall: „wenig los" waehrend geschlossen ist. Dann faehrt
  // jemand hin.
  offen = { open: false, text: 'Wir haben gerade geschlossen. Morgen ab 6 Uhr.', todayText: '' };
  live = { count: 0, max: 40, percent: 0, status: 'empty' };
  r = await ruf();
  ok('4. Bei geschlossen kommt KEINE Auslastung', !/wenig los|voll/.test(r.text || ''), r.text);
  ok('4b. … sondern die Oeffnungszeit', /geschlossen/.test(r.text || ''), r.text);
  ok('4c. … und der Assistent wird entsprechend angewiesen',
    /geschlossen/i.test(r.naechsterSchritt || ''), r.naechsterSchritt);
  offen = { open: true, text: 'Wir haben bis 23 Uhr geöffnet.', todayText: '06:00–23:00' };
  live = { count: 28, max: 40, percent: 70, status: 'busy' };

  // ── 5. Duenne Datenlage ──
  // Wenige Messwerte duerfen keinen Vergleich erzeugen - „mehr als sonst" auf
  // Basis von zwei Tagen waere geraten.
  typischSlot = { typicalCount: 20, samples: 2 };
  r = await ruf();
  ok('5. Zu wenige Messwerte -> kein Vergleich',
    !/sonst um diese Zeit/.test(r.text || ''), r.text);
  ok('5b. … und die Datenlage ist ablesbar', r.datenlage.typisch === false);
  typischSlot = { typicalCount: 20, samples: 12 };

  // Ohne Speicher gibt es nur die Live-Zahl - das ist kein Fehler.
  // hasStore wird beim Laden EINMAL ausgelesen (in Produktion eine Konstante aus
  // der Umgebung). Also das Modul frisch laden, statt am laufenden umzuschalten.
  delete require.cache[require.resolve(path.join(ROOT, 'api/phone/auslastung.js'))];
  stub('lib/store.js', storeStub(false));
  const ohneSpeicher = require(path.join(ROOT, 'api/phone/auslastung.js'));
  const resO = { setHeader: () => {}, end: () => {} };
  await ohneSpeicher({ method: 'GET', url: '/x', headers: {} }, resO);
  r = resO._body || {};
  ok('6. Ohne Speicher bleibt die Live-Auskunft', r.ok === true && /viel los|voll/.test(r.text || ''), r.text);
  ok('6b. … ohne erfundenen Vergleich', !/sonst um diese Zeit/.test(r.text || ''), r.text);
  ok('6c. … und ohne erfundenen Ausweichzeitpunkt', r.ruhigerAb === null, String(r.ruhigerAb));
  delete require.cache[require.resolve(path.join(ROOT, 'api/phone/auslastung.js'))];
  stub('lib/store.js', storeStub(true));
  const handler2 = require(path.join(ROOT, 'api/phone/auslastung.js'));
  ruf = async function () {
    const res2 = { setHeader: () => {}, end: () => {} };
    await handler2({ method: 'GET', url: '/x', headers: {} }, res2);
    return res2._body || {};
  };

  // ── 7. Keine Live-Zahl ──
  live = null;
  r = await ruf();
  ok('7. Ohne Live-Zahl wird nichts behauptet',
    /keine Zahl/.test(r.text || ''), r.text);
  ok('7b. … und die Datenlage sagt es', r.datenlage.live === false);
  live = { count: 28, max: 40, percent: 70, status: 'busy' };

  // ── 8. Ist es ohnehin leer, braucht niemand einen Ausweichzeitpunkt ──
  live = { count: 5, max: 40, percent: 12, status: 'quiet' };
  r = await ruf();
  ok('8. Bei wenig Betrieb kein „ruhiger ab"', r.ruhigerAb === null, String(r.ruhigerAb));
  ok('8b. … der Satz bleibt trotzdem brauchbar', /wenig los/.test(r.text || ''), r.text);

  // ── 9. Spaet am Abend gibt es kein „ruhiger ab" mehr ──
  live = { count: 28, max: 40, percent: 70, status: 'busy' };
  jetztSlot = 45;   // 22:30
  r = await ruf();
  ok('9. Kurz vor Schluss wird kein Zeitpunkt erfunden', r.ruhigerAb === null, String(r.ruhigerAb));

  console.log(pass ? 'PHONE-AUSLASTUNG PASS' : 'PHONE-AUSLASTUNG FAIL');
  process.exit(pass ? 0 : 1);
})();
