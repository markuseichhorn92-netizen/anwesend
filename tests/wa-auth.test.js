'use strict';
// Prüft die WhatsApp-Verifizierung (lib/waAuth.js): Verifizierungsstatus (setzen/
// lesen/verlängern/löschen, Nummer-Normalisierung), Bestätigungs-Challenge
// (anlegen/lesen/wiederverwenden/verbrauchen), Webhook-Dedup (firstSeen) und
// fail-closed ohne Store. In-Memory-KV als lib/store; crypto ist echt.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── In-Memory-KV mit SET (inkl. NX), GET, DEL, EXPIRE ──
  const kv = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(); const k = String(c[1]);
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { const nx = c.slice(3).some((x) => String(x).toUpperCase() === 'NX'); if (nx && kv.has(k)) return null; kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { const had = kv.has(k); kv.delete(k); return had ? 1 : 0; }
    if (op === 'EXPIRE') return kv.has(k) ? 1 : 0;
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline });
  const WAAuth = require('../lib/waAuth');

  // ── Verifizierungsstatus ──
  ok('1. Unbekannte Nummer ist nicht verifiziert', (await WAAuth.getVerified('491510000')) === null);
  ok('2. setVerified speichert die Zuordnung', (await WAAuth.setVerified('+49 151 2345678', '9001')) === true);
  const v = await WAAuth.getVerified('49151 2345678');   // andere Schreibweise, gleiche Ziffern
  ok('3. getVerified findet sie schreibweisen-unabhängig', v && v.memberId === '9001', JSON.stringify(v));
  ok('4. Einwilligungsversion ist vermerkt', v && v.consentVersion === WAAuth.CONSENT_VERSION);
  ok('5. touch wirft nicht und hält den Eintrag', (await WAAuth.touch('491512345678')) === undefined && !!(await WAAuth.getVerified('491512345678')));
  await WAAuth.clearVerified('491512345678');
  ok('6. clearVerified entfernt die Verifizierung', (await WAAuth.getVerified('491512345678')) === null);

  // ── Bestätigungs-Challenge ──
  const c1 = await WAAuth.createChallenge('015199999', '9002');
  ok('7. createChallenge liefert einen Token', c1 && typeof c1.token === 'string' && c1.token.length >= 16, JSON.stringify(c1));
  const chal = await WAAuth.getChallenge(c1.token);
  ok('8. getChallenge bindet Token an Nummer + Mitglied', chal && chal.memberId === '9002' && chal.phone === '015199999', JSON.stringify(chal));
  const c2 = await WAAuth.createChallenge('015199999', '9002');
  ok('9. Zweite Challenge derselben Nummer wird wiederverwendet (kein Link-Spam)', c2 && c2.token === c1.token && c2.reused === true, JSON.stringify(c2));
  await WAAuth.consumeChallenge(c1.token);
  ok('10. consumeChallenge macht den Token ungültig', (await WAAuth.getChallenge(c1.token)) === null);
  ok('11. Nach Verbrauch ist wieder eine NEUE Challenge möglich', (await WAAuth.createChallenge('015199999', '9002')).token !== c1.token);

  // ── Dedup ──
  ok('12. firstSeen ist beim ersten Mal true', (await WAAuth.firstSeen('wamid.ABC')) === true);
  ok('13. …und beim zweiten Mal false (kein Doppel-Antworten)', (await WAAuth.firstSeen('wamid.ABC')) === false);
  ok('14. firstSeen ohne ID blockiert nicht', (await WAAuth.firstSeen('')) === true);

  // ── Fail-closed ohne Store ──
  delete require.cache[path.resolve(ROOT, 'lib/waAuth.js')];
  inject('lib/store.js', { hasStore: false, redisPipeline: async () => { throw new Error('no store'); } });
  const WAAuth2 = require('../lib/waAuth');
  ok('15. Ohne Store: nicht verifiziert', (await WAAuth2.getVerified('x')) === null);
  ok('16. Ohne Store: setVerified schlägt sauber fehl', (await WAAuth2.setVerified('x', 'y')) === false);
  ok('17. Ohne Store: keine Challenge', (await WAAuth2.createChallenge('x', 'y')) === null);
  ok('18. Ohne Store: firstSeen blockiert nicht', (await WAAuth2.firstSeen('id')) === true);

  console.log(pass ? 'WA-AUTH PASS' : 'WA-AUTH FAIL');
  process.exit(pass ? 0 : 1);
}
run();
