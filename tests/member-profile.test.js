'use strict';
// Mitglieder-Profil aus dem Onboarding (lib/memberProfile.js): Sanitizing, Clamping,
// Einwilligungs-Gate für Gesundheitsdaten (Art. 9), Prompt-Text und – gegen einen
// In-Memory-KV-Mock – speichern/laden/löschen inkl. Gesundheit-nur-Löschung.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ── KV-Store mocken (In-Memory), BEVOR memberProfile geladen wird ──
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
const KV = new Map();
function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase();
    if (op === 'GET') return KV.has(c[1]) ? KV.get(c[1]) : null;
    if (op === 'SET') { KV.set(c[1], c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(c[1]); return had ? 1 : 0; }
    if (op === 'EXPIRE') return KV.has(c[1]) ? 1 : 0;
    return null;
  }));
}
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true, exports: { hasStore: true, redisPipeline: fakePipeline },
};

const P = require(path.join(ROOT, 'lib/memberProfile.js'));

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // 1. sanitize: Whitelist/Clamp
  const s = P.sanitize({ goal: 'Abnehmen', freq: 12, age: 8, heightCm: 999, weightKg: 74, sex: 'm', trainTime: 'ABENDS', exp: 'erfahren', diet: 'vegan' });
  ok('1. freq auf 1..7 geklemmt', s.freq === 7);
  ok('1b. age auf min 14 geklemmt', s.age === 14);
  ok('1c. heightCm auf max 250 geklemmt', s.heightCm === 250);
  ok('1d. gültige Auswahlen übernommen', s.sex === 'm' && s.trainTime === 'abends' && s.exp === 'erfahren' && s.diet === 'vegan' && s.goal === 'Abnehmen');

  // 1e. Wunschgewicht + onboarded-Flag (geräteübergreifendes Onboarding)
  const sw = P.sanitize({ goal: 'Abnehmen', weightKg: 90, targetWeight: 75, onboarded: true });
  ok('1e. targetWeight übernommen + geklemmt', sw.targetWeight === 75 && sw.onboarded === true);
  const sw2 = P.sanitize({ targetWeight: 5 });
  ok('1f. targetWeight unter Minimum verworfen', sw2.targetWeight === 30 && sw2.onboarded === false);
  ok('1g. toPromptText nennt Wunschgewicht', /Wunschgewicht 75/.test(P.toPromptText(sw)));

  // 2. Listen: Dedup + Cap + Mindestlänge
  const s2 = P.sanitize({ likes: ['Cardio', 'cardio', 'Freihanteln', 'x', 'Cardio'] });
  ok('2. likes dedupliziert + zu Kurzes verworfen', s2.likes.length === 2 && s2.likes.indexOf('Cardio') >= 0);

  // 3. Gesundheits-Gate: ohne Einwilligung nichts übernehmen
  const noC = P.sanitize({ health: { consent: false, items: ['Rücken'], note: 'Bandscheibe' } });
  ok('3. ohne Einwilligung: keine Gesundheitsdaten', noC.health.consent === false && noC.health.items.length === 0 && noC.health.note === '');
  const yesC = P.sanitize({ health: { consent: true, items: ['Rücken', 'Knie'], note: 'Bitte Rücken schonen' } });
  ok('3b. mit Einwilligung: Gesundheitsdaten übernommen', yesC.health.consent === true && yesC.health.items.length === 2 && /Rücken/.test(yesC.health.note));

  // 4. toPromptText: leer ohne Inhalt, sonst mit Feldern; Gesundheit nur bei Einwilligung
  ok('4. toPromptText leer bei leerem Profil', P.toPromptText(P.sanitize({})) === '');
  const pt = P.toPromptText(yesC);
  ok('4b. toPromptText nennt Gesundheit (mit Einwilligung)', /Gesundheit/.test(pt) && /Rücken/.test(pt));
  const ptNo = P.toPromptText(P.sanitize({ goal: 'Abnehmen', health: { consent: false, items: ['Diabetes'] } }));
  ok('4c. toPromptText verrät KEINE Gesundheit ohne Einwilligung', /Ziel/.test(ptNo) && !/Diabetes/.test(ptNo));

  // 4d. Lebensstil (Bestandsdaten für FINNs Kontext): nur mit Einwilligung übernehmen, im Prompt-Text erwähnt
  const lc = P.sanitize({ lifestyle: { consent: false, sleep: 'gut', smoking: 'ja' } });
  ok('4d. Lebensstil ohne Einwilligung leer', lc.lifestyle.consent === false && lc.lifestyle.sleep === '' && lc.lifestyle.smoking === '');
  const ly = P.sanitize({ goal: 'Abnehmen', lifestyle: { consent: true, sleep: 'gut', stress: 'hoch', smoking: 'ja', sitting: 'viel' } });
  ok('4e. Lebensstil mit Einwilligung übernommen', ly.lifestyle.sleep === 'gut' && ly.lifestyle.smoking === 'ja' && ly.lifestyle.stress === 'hoch');
  ok('4f. toPromptText nennt Lebensstil (mit Einwilligung)', /Lebensstil/.test(P.toPromptText(ly)));

  // ── KV-gebundene Operationen ──
  const ID = 'M1';
  // 5. Standard: leeres Profil
  const g0 = await P.get(ID);
  ok('5. Standard: leeres Profil', !P.hasAny(g0));

  // 6. Speichern + Laden
  await P.save(ID, { goal: 'Muskelaufbau', freq: 4, heightCm: 180, weightKg: 82, health: { consent: true, items: ['Schulter'], note: '' } });
  const g1 = await P.get(ID);
  ok('6. gespeichert + geladen', g1.goal === 'Muskelaufbau' && g1.freq === 4 && g1.heightCm === 180 && g1.health.items[0] === 'Schulter');

  // 7. Nur Gesundheit löschen (Rest bleibt)
  await P.clearHealth(ID);
  const g2 = await P.get(ID);
  ok('7. clearHealth entfernt nur Gesundheit', g2.goal === 'Muskelaufbau' && g2.health.consent === false && g2.health.items.length === 0);

  // 8. Alles löschen (DSGVO)
  await P.clear(ID);
  const g3 = await P.get(ID);
  ok('8. clear entfernt das ganze Profil', !P.hasAny(g3));

  console.log(pass ? 'MEMBER-PROFILE PASS' : 'MEMBER-PROFILE FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
