'use strict';
// Ausweis am Telefon, bevor Vertrags- oder Pausendaten genannt werden.
//
// Das ist die Stelle mit dem groessten Schaden bei einem Fehler: Wer hier
// durchrutscht, bekommt fremde Vertragsdaten vorgelesen. Deshalb laeuft der
// Speicher hier wirklich (In-Memory-Nachbildung) - geprueft wird das Verhalten,
// nicht der Quelltext.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ── Speicher-Nachbildung inkl. Ablaufzeit ──
const DB = new Map();
function run(cmd) {
  const op = String(cmd[0]).toUpperCase();
  const k = cmd[1];
  if (op === 'GET') { const e = DB.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { DB.delete(k); return null; } return e.v; }
  if (op === 'SET') { let exp = 0; for (let i = 2; i < cmd.length; i++) { if (String(cmd[i]).toUpperCase() === 'EX') exp = Date.now() + Number(cmd[i + 1]) * 1000; } DB.set(k, { v: cmd[2], exp: exp }); return 'OK'; }
  if (op === 'DEL') { return DB.delete(k) ? 1 : 0; }
  if (op === 'EXPIRE') { const e = DB.get(k); if (e) e.exp = Date.now() + Number(cmd[2]) * 1000; return 1; }
  return null;
}
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true,
  exports: { hasStore: true, redisPipeline: async (cmds) => cmds.map(run) } };

const M = require(path.join(ROOT, 'lib/members.js'));
const A = require(path.join(ROOT, 'lib/phoneAuth.js'));

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

const TEL = '015120442244';
// Den Code legt der Login-Weg ab; hier bilden wir genau dessen Ablage nach.
async function codeStellen(phone, code, memberId, ttl) {
  const chal = 'chal-' + Math.abs(code | 0);
  await M.otpSave(chal, { id: memberId, codeHash: M.hashCode(String(code)), exp: Date.now() + (ttl || 600) * 1000, tries: 0 }, ttl || 600);
  await A.saveChallenge(phone, chal);
  return chal;
}

(async function () {
  // ── 1. Ohne alles: nicht verifiziert ──
  let st = await A.status(TEL);
  ok('1. Eine unbekannte Nummer ist NICHT verifiziert', st.verified === false && st.memberId === null);

  // ── 2. Der Code-Weg ──
  await codeStellen(TEL, '123456', '4711');
  const falsch = await A.checkCode(TEL, '000000');
  ok('2. Falscher Code wird abgelehnt', falsch.ok === false, JSON.stringify(falsch));
  ok('2b. … und verifiziert dabei nichts', (await A.status(TEL)).verified === false);

  const richtig = await A.checkCode(TEL, '123456');
  ok('3. Richtiger Code wird angenommen', richtig.ok === true && richtig.memberId === '4711', JSON.stringify(richtig));

  // Der wichtigste Punkt: EINMAL gueltig. Ein mitgehoerter Code darf nicht
  // beim naechsten Anruf noch einmal funktionieren.
  const nochmal = await A.checkCode(TEL, '123456');
  ok('4. Derselbe Code ein zweites Mal -> abgelehnt', nochmal.ok === false, JSON.stringify(nochmal));

  // ── 3. Verifizierung setzen und lesen ──
  await A.setVerified(TEL, '4711', A.CONSENT_VERSION);
  st = await A.status(TEL);
  ok('5. Nach dem Setzen ist die Nummer verifiziert', st.verified === true && st.memberId === '4711');
  ok('5b. … mit festgehaltener Einwilligungsversion', st.consentVersion === A.CONSENT_VERSION, String(st.consentVersion));
  ok('5c. … und erkennbarer Quelle', st.quelle === 'telefon', String(st.quelle));

  // Andere Schreibweise derselben Nummer muss denselben Status ergeben - sonst
  // steht das Mitglied beim naechsten Anruf wieder ohne Ausweis da.
  ok('6. Andere Schreibweise, selbe Nummer', (await A.status('+49 151 2044 2244')).verified === true);
  ok('6b. … und eine FREMDE Nummer bleibt aussen vor',
    (await A.status('015199998888')).verified === false);

  await A.clearVerified(TEL);
  ok('7. Zuruecksetzen wirkt', (await A.status(TEL)).verified === false);

  // ── 4. Durchprobieren ──
  // Sechs Stellen sind am Telefon in Ruhe durchprobierbar, wenn man sie laesst.
  await codeStellen(TEL, '654321', '4711');
  for (let i = 0; i < A.CODE_MAX_VERSUCHE; i++) await A.checkCode(TEL, '111111');
  const nachher = await A.checkCode(TEL, '654321');
  ok('8. Nach zu vielen Fehlversuchen ist auch der RICHTIGE Code wertlos',
    nachher.ok === false, JSON.stringify(nachher));
  ok('8b. … und der Grund ist im Protokoll unterscheidbar',
    nachher.grund === 'zu_viele_versuche', String(nachher.grund));
  ok('8c. … es bleibt bei „nicht verifiziert"', (await A.status(TEL)).verified === false);

  // ── 5. Abgelaufener Code ──
  await codeStellen(TEL, '222333', '4711', 1);
  await new Promise(function (r) { setTimeout(r, 1100); });
  const alt = await A.checkCode(TEL, '222333');
  ok('9. Abgelaufener Code wird abgelehnt', alt.ok === false, JSON.stringify(alt));
  // Der Grund darf sich NICHT von „falsch" unterscheiden - sonst verraet die
  // Antwort, ob ueberhaupt ein Code unterwegs ist.
  ok('9b. … ununterscheidbar von einem falschen Code', alt.grund === 'ungueltig', String(alt.grund));

  // ── 6. Unsinnige Eingaben ──
  await codeStellen(TEL, '444555', '4711');
  ok('10. Zu kurze Eingabe trifft nie', (await A.checkCode(TEL, '4445')).ok === false);
  ok('10b. Buchstaben treffen nie', (await A.checkCode(TEL, 'abcdef')).ok === false);
  ok('10c. Leer trifft nie', (await A.checkCode(TEL, '')).ok === false && (await A.checkCode(TEL, null)).ok === false);
  // Gesprochene Codes kommen oft mit Leerzeichen an („vier vier vier fuenf...").
  ok('10d. Leerzeichen im Code stoeren nicht', (await A.checkCode(TEL, '444 555')).ok === true);

  // ── 7. Ohne Code gibt es keinen Weg hinein ──
  DB.clear();
  ok('11. Ohne hinterlegten Code trifft auch ein geratener nicht',
    (await A.checkCode(TEL, '123456')).ok === false);
  ok('11b. … und die Nummer bleibt unverifiziert', (await A.status(TEL)).verified === false);

  // ── 8. Die WhatsApp-Verifizierung zaehlt mit ──
  // Wer ueber WhatsApp schon zwei Faktoren erbracht hat, muss am Telefon nicht
  // noch einmal von vorn anfangen - es ist dieselbe Nummer.
  // So legt waAuth es ab: rohe Ziffern, wie WhatsApp sie liefert (international).
  // Der Anrufer nennt am Telefon die nationale Form - genau das muss zusammenfinden.
  DB.set('wa:verify:4915120442244',
    { v: JSON.stringify({ memberId: '9002', verifiedAt: Date.now(), consentVersion: 'wa-finn-2026-07' }), exp: 0 });
  st = await A.status(TEL);
  ok('12. Bestehende WhatsApp-Verifizierung gilt auch am Telefon',
    st.verified === true && st.memberId === '9002', JSON.stringify(st));
  ok('12b. … und ist als solche erkennbar', st.quelle === 'whatsapp');
  ok('12c. … samt der dort erfassten Einwilligung', st.consentVersion === 'wa-finn-2026-07');
  // Die eigene Telefon-Verifizierung hat Vorrang, wenn beide vorliegen.
  await A.setVerified(TEL, '4711', A.CONSENT_VERSION);
  ok('12d. Eigene Verifizierung geht vor', (await A.status(TEL)).memberId === '4711');

  // ── 9. Fail-closed: ohne Speicher gibt es keinen Ausweis ──
  // Faellt Upstash aus, darf NICHT jeder als verifiziert gelten. Das laesst sich
  // im selben Prozess nicht pruefen (der Speicher ist oben schon eingehaengt),
  // deshalb ein eigener Lauf mit abgeklemmtem Speicher.
  const ohneSpeicher = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const path = require('path');
    const sp = require.resolve(path.join(${JSON.stringify(ROOT)}, 'lib/store.js'));
    require.cache[sp] = { id: sp, filename: sp, loaded: true,
      exports: { hasStore: false, redisPipeline: async () => [null] } };
    const A = require(path.join(${JSON.stringify(ROOT)}, 'lib/phoneAuth.js'));
    (async function () {
      const s = await A.status('015120442244');
      const c = await A.checkCode('015120442244', '123456');
      const v = await A.setVerified('015120442244', '1');
      process.stdout.write(JSON.stringify({ verified: s.verified, code: c.ok, set: v }));
    })();
  `], { encoding: 'utf8', timeout: 15000 });
  let oS = {};
  try { oS = JSON.parse(String(ohneSpeicher.stdout || '{}')); } catch (e) { oS = {}; }
  ok('13. Ohne Speicher gilt niemand als verifiziert', oS.verified === false, String(ohneSpeicher.stdout));
  ok('13b. … und kein Code laesst sich einloesen', oS.code === false);
  ok('13c. … und es laesst sich auch nichts setzen', oS.set === false);

  console.log(pass ? 'PHONE-AUTH PASS' : 'PHONE-AUTH FAIL');
  process.exit(pass ? 0 : 1);
})();
