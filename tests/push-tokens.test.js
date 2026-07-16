'use strict';
// Push-Token-Zuordnung (lib/push.js): Kontowechsel bindet den Token atomar um
// (kein Doppel-Empfang), Registrierung/Abmeldung sind idempotent, Team<->Mitglied
// Wechsel räumen die jeweils andere Zuordnung auf.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// In-Memory-Redis mit Set-Unterstützung
const kv = new Map(); const sets = new Map();
const S = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
async function redisPipeline(cmds) {
  return cmds.map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return kv.has(c[1]) ? kv.get(c[1]) : null;
    if (op === 'SET') { kv.set(c[1], String(c[2])); return 'OK'; }
    if (op === 'DEL') { kv.delete(c[1]); return 1; }
    if (op === 'SADD') { S(c[1]).add(String(c[2])); return 1; }
    if (op === 'SREM') { S(c[1]).delete(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return Array.from(S(c[1]));
    return null;
  });
}
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
inject('lib/store.js', { hasStore: true, redisPipeline, TZ: 'Europe/Berlin' });
inject('lib/apns.js', { hasApns: false, sendApns: async () => ({ ok: false }) });

const Push = require(path.join(ROOT, 'lib/push.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1) Normale Registrierung
  await Push.registerToken('A', 'dev1', 'ios');
  ok('1. Token bei Mitglied A', (await Push.tokensFor('A')).includes('dev1'));

  // 2) Kontowechsel A -> B auf demselben Gerät: A verliert den Token VOLLSTÄNDIG
  await Push.registerToken('B', 'dev1', 'ios');
  ok('2. Token jetzt bei B', (await Push.tokensFor('B')).includes('dev1'));
  ok('2b. Token NICHT mehr bei A (kein Doppel-Empfang)', !(await Push.tokensFor('A')).includes('dev1'));
  ok('2c. A aus dem Push-Index entfernt (kein Gerät mehr)', !(await Push.allPushMembers()).includes('A'));

  // 3) Doppelte Registrierung desselben Kontos ist idempotent
  await Push.registerToken('B', 'dev1', 'ios');
  await Push.registerToken('B', 'dev1', 'ios');
  ok('3. keine Duplikate', (await Push.tokensFor('B')).filter((t) => t === 'dev1').length === 1);

  // 4) Wechsel Mitglied -> Team-Gerät: Mitglieds-Zuordnung wird aufgeräumt
  await Push.registerTeamToken('dev1', 'ios', 'anna');
  ok('4. Token im Team-Pool', (await Push.teamTokens()).includes('dev1'));
  ok('4b. Token nicht mehr bei Mitglied B', !(await Push.tokensFor('B')).includes('dev1'));

  // 5) Wechsel Team -> Mitglied: Team-Pool wird aufgeräumt
  await Push.registerToken('C', 'dev1', 'ios');
  ok('5. Token bei Mitglied C', (await Push.tokensFor('C')).includes('dev1'));
  ok('5b. Token nicht mehr im Team-Pool', !(await Push.teamTokens()).includes('dev1'));

  // 6) Abmeldung idempotent (auch doppelt und für unbekannte Tokens)
  await Push.unregisterToken('C', 'dev1');
  await Push.unregisterToken('C', 'dev1');
  await Push.unregisterToken('C', 'gibtsnicht');
  ok('6. Token nach Abmeldung weg', !(await Push.tokensFor('C')).includes('dev1'));
  ok('6b. C aus dem Index (kein Gerät mehr)', !(await Push.allPushMembers()).includes('C'));

  // 7) Zweitgerät bleibt beim Kontowechsel des Erstgeräts unberührt
  await Push.registerToken('D', 'dev-a', 'ios');
  await Push.registerToken('D', 'dev-b', 'android');
  await Push.registerToken('E', 'dev-a', 'ios');   // Gerät a wechselt zu E
  const dToks = await Push.tokensFor('D');
  ok('7. Zweitgerät von D unberührt', dToks.includes('dev-b') && !dToks.includes('dev-a'));
  ok('7b. D bleibt im Index (hat noch ein Gerät)', (await Push.allPushMembers()).includes('D'));

  console.log(pass ? 'PUSH-TOKENS PASS' : 'PUSH-TOKENS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
