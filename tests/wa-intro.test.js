'use strict';
// KI-Transparenz-Ansage (lib/waIntro): genau einmal je WhatsApp-Kontakt (idempotent
// per Telefonnummer, atomar über SET NX), vor der ersten inhaltlichen Antwort.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// In-Memory-Store mit SET-NX-Semantik (nur setzen, wenn Key fehlt).
const KV = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'SET') {
      const hasNX = c.slice(2).some((x) => String(x).toUpperCase() === 'NX');
      if (hasNX && KV.has(k)) return null;         // schon vorhanden -> nicht setzen
      KV.set(k, String(c[2])); return 'OK';
    }
    if (op === 'GET') return KV.has(k) ? KV.get(k) : null;
    return null;
  }),
});
const sent = [];
inject('lib/whatsapp.js', { hasWhatsApp: true, sendText: async (to, text) => { sent.push({ to: to, text: text }); return { ok: true }; } });

const WAIntro = require(path.join(ROOT, 'lib/waIntro.js'));

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // 1. Erste Nachricht an einen Kontakt -> Hinweis wird gesendet.
  const a = await WAIntro.discloseOnce('+49 170 1234567');
  ok('1. Erstkontakt -> Hinweis gesendet', a === true && sent.length === 1);
  ok('2. Wortlaut = KI-Offenlegung', sent[0] && sent[0].text === WAIntro.DISCLOSURE && /KI-Assistent/.test(sent[0].text));

  // 3. Zweite Nachricht desselben Kontakts (auch andere Schreibweise) -> NICHT erneut.
  const b = await WAIntro.discloseOnce('491701234567');
  ok('3. Wiederkontakt -> kein zweiter Hinweis', b === false && sent.length === 1);

  // 4. Anderer Kontakt -> eigener Hinweis.
  const c = await WAIntro.discloseOnce('+49 151 9999999');
  ok('4. Anderer Kontakt -> eigener Hinweis', c === true && sent.length === 2);

  // 5. Leere/ungültige Nummer -> nichts.
  const d = await WAIntro.discloseOnce('');
  ok('5. Leere Nummer -> kein Versand', d === false && sent.length === 2);

  console.log(pass ? 'WA-INTRO PASS' : 'WA-INTRO FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
