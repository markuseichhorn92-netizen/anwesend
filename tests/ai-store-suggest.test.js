'use strict';
// nutritionStoreSuggest (lib/ai.js): mappt Einkaufslisten-Positionen auf konkrete
// Produkte eines Supermarkts (bevorzugt Eigenmarken). Geprüft: Prompt-Regeln
// (JSON-only, KEINE Preise, key exakt, Eigenmarken-Grounding, diet beachtet)
// und die Validierung (Key-Filter, Kappung, leere Antwort).
process.env.ANTHROPIC_API_KEY = 'test-key';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── Quelltext-Zusicherungen (Prompt-Regeln dürfen nicht verloren gehen) ──
  const src = fs.readFileSync(path.resolve(ROOT, 'lib/ai.js'), 'utf8');
  ok('1. Funktion existiert und ist exportiert', /async function nutritionStoreSuggest\(/.test(src) && /nutritionStoreSuggest,/.test(src));
  ok('2. JSON-only-Regel im Prompt', /Schlage je Position GENAU EIN konkretes/.test(src));
  ok('3. Keine Preise/Verfügbarkeit', /KEINE Preise, keine Verfügbarkeits- oder Aktionsangaben/.test(src));
  ok('4. key-Exakt-Regel', /Übernimm key EXAKT wie angegeben/.test(src));
  ok('5. generischer Fallback statt Raten', /generische Bezeichnung/.test(src));

  // ── Funktional mit gemocktem fetch ──
  let lastBody = null; let answer = '';
  global.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(ROOT, 'lib/ai.js'));

  const ctx = {
    store: 'lidl', storeLabel: 'Lidl', diet: 'vegan', goal: 'abnehmen',
    brands: ['Milbona', 'Vemondo', 'Crownfield'],
    items: [{ key: 'haferflocken', name: 'Haferflocken', amount: '500 g' }, { key: 'sojajoghurt', name: 'Sojajoghurt', amount: '400 g' }],
  };
  answer = JSON.stringify({ items: [
    { key: 'HAFERFLOCKEN', product: 'Crownfield Haferflocken zart', note: 'im Müsliregal' },
    { key: 'sojajoghurt', product: 'Vemondo Sojajoghurt Natur', note: '' },
    { key: 'nichtgefragt', product: 'Erfundenes Produkt', note: '' },
  ] });
  let r = await AI.nutritionStoreSuggest(ctx);
  ok('6. ok + beide Positionen beantwortet', r.ok === true && r.items.length === 2);
  ok('7. Keys case-normalisiert und auf Anfrage gefiltert', r.items.some((x) => x.key === 'haferflocken') && !r.items.some((x) => x.key === 'nichtgefragt'));
  const sys = String(lastBody.system);
  ok('8. Markt + Eigenmarken-Grounding im System-Prompt', /Lidl/.test(sys) && /Milbona, Vemondo, Crownfield/.test(sys));
  ok('9. Ernährungsform im Prompt (vegan)', /vegan/.test(sys));
  ok('10. Liste als key=…-Zeilen im User-Turn', /key=haferflocken: Haferflocken \(500 g\)/.test(lastBody.messages[0].content));

  // Kappung: >25 Antwort-Items werden abgeschnitten; überlange Produktnamen gekürzt.
  const manyItems = []; for (let i = 0; i < 30; i++) manyItems.push({ key: 'zutat' + i, name: 'Zutat ' + i, amount: '' });
  answer = JSON.stringify({ items: manyItems.map((it) => ({ key: it.key, product: 'P'.repeat(200), note: 'N'.repeat(200) })) });
  r = await AI.nutritionStoreSuggest({ store: 'lidl', storeLabel: 'Lidl', items: manyItems });
  ok('11. Anfrage-Items auf 25 gekappt', /key=zutat24/.test(lastBody.messages[0].content) && !/key=zutat25/.test(lastBody.messages[0].content));
  ok('12. Antwort auf 25 gekappt + Felder gekürzt', r.ok === true && r.items.length === 25 && r.items[0].product.length === 80 && r.items[0].note.length === 60);

  // Leere/kaputte Antworten -> sauberer Fehler.
  answer = 'kein json';
  r = await AI.nutritionStoreSuggest(ctx);
  ok('13. kaputtes JSON -> parse_failed', r.ok === false && r.error === 'parse_failed');
  answer = JSON.stringify({ items: [] });
  r = await AI.nutritionStoreSuggest(ctx);
  ok('14. leere Antwort -> empty', r.ok === false && r.error === 'empty');
  r = await AI.nutritionStoreSuggest({ store: 'lidl', storeLabel: 'Lidl', items: [] });
  ok('15. ohne Items -> empty (kein KI-Aufruf nötig)', r.ok === false && r.error === 'empty');

  console.log(pass ? 'AI-STORE-SUGGEST PASS' : 'AI-STORE-SUGGEST FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
