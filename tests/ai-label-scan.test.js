'use strict';
// Etikett-Scan (lib/ai.js nutritionLabelScan): liest die aufgedruckte Nährwerttabelle ab.
// Geprüft: Prompt-Regeln (je 100 g/ml, nichts erfinden, kJ-Umrechnung), Validierung/Kappung,
// Atwater-Plausibilität als Warnung und die Fehlerfälle.
process.env.ANTHROPIC_API_KEY = 'test-key';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── Quelltext: die Sicherheits-/Qualitätsregeln dürfen nicht verloren gehen ──
  const src = fs.readFileSync(path.resolve(ROOT, 'lib/ai.js'), 'utf8');
  ok('1. Funktion existiert und ist exportiert', /async function nutritionLabelScan\(/.test(src) && /nutritionLabelScan,/.test(src));
  ok('2. Bezug je 100 g/ml im Prompt', /ALLE Nährwerte beziehen sich auf 100 g bzw\. 100 ml/.test(src));
  ok('3. Nichts erfinden / nichts schätzen', /NICHTS erfinden und NICHTS schätzen/.test(src));
  ok('4. Portionsspalte wird hochgerechnet', /rechne auf 100 g hoch/.test(src));
  ok('5. kJ-Umrechnung vorgesehen', /kJ \/ 4,184/.test(src));

  let lastBody = null; let answer = '';
  global.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }) };
  };
  const AI = require(path.resolve(ROOT, 'lib/ai.js'));
  const IMG = 'x'.repeat(200);

  // ── Normalfall ──
  answer = JSON.stringify({ name: 'Magerquark', brand: 'MILSANI', basis: '100g', kcal: 67, protein: 12, carbs: 4, fat: 0.3, fiber: null, sugar: 4, satFat: 0.2, salt: 0.05, confidence: 0.9 });
  let r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('6. Werte je 100 g übernommen', r.ok === true && r.per100.kcal === 67 && r.per100.protein === 12 && r.per100.salt === 0.05);
  ok('7. Name und Marke getrennt', r.name === 'Magerquark' && r.brand === 'MILSANI');
  ok('8. Basis erkannt, keine Warnung', r.basis === '100g' && !r.warn && r.confidence === 0.9);
  ok('9. Bild wird als image-Block gesendet', !!(lastBody.messages[0].content || []).some((c) => c.type === 'image'));

  // ── Getränk: 100 ml ──
  answer = JSON.stringify({ name: 'Apfelschorle', brand: 'Rio d\'Oro', basis: '100ml', kcal: 24, protein: 0, carbs: 5.6, fat: 0, confidence: 0.8 });
  r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('10. 100-ml-Basis wird durchgereicht', r.ok === true && r.basis === '100ml');

  // ── Kappung + fehlende Felder bleiben null ──
  answer = JSON.stringify({ name: 'N'.repeat(200), brand: 'B'.repeat(200), basis: 'unsinn', kcal: 99999, protein: -5, carbs: 4, fat: 1, fiber: null, sugar: null, satFat: null, salt: null, confidence: 5 });
  r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('11. Zahlen gedeckelt, Negatives verworfen', r.per100.kcal === 900 && r.per100.protein === null);
  ok('12. Texte gekürzt, Basis-Fallback 100g', r.name.length === 80 && r.brand.length === 60 && r.basis === '100g');
  ok('13. confidence auf 0–1 begrenzt', r.confidence === 1);
  ok('14. Nicht angegebene Werte bleiben null', r.per100.fiber === null && r.per100.salt === null);

  // ── Atwater-Plausibilität: kcal passt nicht zu den Makros ──
  answer = JSON.stringify({ name: 'Krumm', brand: '', basis: '100g', kcal: 100, protein: 30, carbs: 30, fat: 30, confidence: 0.9 });
  r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('15. Unstimmige kcal werden als mismatch markiert', r.ok === true && r.warn === 'mismatch');

  // ── Fehlerfälle ──
  answer = JSON.stringify({ name: '', brand: '', basis: '100g', kcal: null, protein: null, carbs: null, fat: null, confidence: 0 });
  r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('16. Keine Tabelle erkennbar -> no_label', r.ok === false && r.error === 'no_label');
  answer = 'kein json';
  r = await AI.nutritionLabelScan(IMG, 'image/jpeg');
  ok('17. Kaputtes JSON -> parse_failed', r.ok === false && r.error === 'parse_failed');
  r = await AI.nutritionLabelScan('', 'image/jpeg');
  ok('18. Ohne Bild -> empty (kein KI-Aufruf)', r.ok === false && r.error === 'empty');

  console.log(pass ? 'AI-LABEL-SCAN PASS' : 'AI-LABEL-SCAN FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
