'use strict';
// Prüft die Grundnahrungsmittel-Schicht (lib/baseFoods.js):
//  1) Jeder Eintrag ist per Atwater plausibel (fängt Tippfehler in den Nährwerten ab).
//  2) Die Suche liefert für Alltagsbegriffe das richtige Grundnahrungsmittel zuerst –
//     insbesondere der gemeldete Fall „Kartoffeln" (nicht Knäckebrot mit 373 kcal).
//  3) Die Produktform passt zu dem, was der Endpunkt erwartet.
const BF = require('../lib/baseFoods');

function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── 1) Atwater-Plausibilität je Eintrag ──
  // kcal ≈ 4·Eiweiß + 4·KH + 9·Fett. Ballaststoffe liefern real nur ~2 statt 4 kcal/g,
  // deshalb eine untere (ballaststoffkorrigierte) und obere Schranke mit Toleranz.
  // Ziel: grobe Vertipper fangen (z. B. 373 statt 87), nicht jede Rundung.
  let bad = [];
  for (const f of BF.FOODS) {
    const high = 4 * f.p + 4 * f.c + 9 * f.f;                                // Standard-Atwater
    const low = 4 * f.p + 4 * Math.max(0, f.c - f.fiber) + 2 * f.fiber + 9 * f.f;  // Ballaststoffe @2
    const loBound = Math.min(low, high) * 0.82 - 8;
    const hiBound = Math.max(low, high) * 1.15 + 8;
    if (f.kcal < loBound || f.kcal > hiBound) {
      bad.push(f.name + ' (kcal=' + f.kcal + ', erwartet ' + Math.round(loBound) + '–' + Math.round(hiBound) + ')');
    }
  }
  ok('1. Alle ' + BF.FOODS.length + ' Einträge sind per Atwater plausibel', bad.length === 0, bad.join(' | '));

  // Grundwerte vorhanden und im sinnvollen Bereich (0..900 kcal, Makros 0..100 g)
  let range = [];
  for (const f of BF.FOODS) {
    if (!(f.kcal >= 0 && f.kcal <= 900)) range.push(f.name + ' kcal');
    for (const k of ['p', 'c', 'f', 'fiber', 'sugar']) if (!(f[k] >= 0 && f[k] <= 100)) range.push(f.name + ' ' + k);
    if (!f.name || !f.terms.length) range.push(f.name + ' (Name/Terms)');
  }
  ok('2. Werte und Namen im plausiblen Bereich', range.length === 0, range.slice(0, 6).join(', '));

  // Keine doppelten IDs / Namen
  const ids = new Set(BF.FOODS.map((f) => f.id));
  const names = new Set(BF.FOODS.map((f) => f.name.toLowerCase()));
  ok('3. Keine doppelten IDs', ids.size === BF.FOODS.length);
  ok('4. Keine doppelten Namen', names.size === BF.FOODS.length);

  // ── 2) Suchqualität ──
  const first = (q) => { const r = BF.search(q, 5); return r[0] || null; };

  // Der gemeldete Kernfall: „Kartoffeln" muss Kartoffeln finden, mit plausibler kcal.
  const kart = first('Kartoffeln');
  ok('5. „Kartoffeln" findet Kartoffeln zuerst', kart && /Kartoffeln/.test(kart.name), kart && kart.name);
  ok('6. …mit plausibler kcal (kein Knäckebrot mit 373)', kart && kart.nutriments.kcal100g < 150, kart && String(kart.nutriments.kcal100g));

  const faelle = [
    ['Apfel', /Apfel/], ['Banane', /Banane/], ['Brokkoli', /Brokkoli/],
    ['Ei', /^Ei$/], ['Eier', /^Ei$/], ['Reis', /Reis/], ['Magerquark', /Magerquark/],
    ['Haferflocken', /Haferflocken/], ['Hähnchenbrust', /Hähnchenbrust/],
    ['Möhre', /Karotte/], ['Blaubeeren', /Heidelbeeren/], ['Pasta', /Nudeln/],
    ['Vollkornbrot', /Vollkornbrot/], ['Olivenöl', /Olivenöl/], ['Thunfisch', /Thunfisch/],
  ];
  let missMatch = [];
  for (const [q, re] of faelle) {
    const f = first(q);
    if (!f || !re.test(f.name)) missMatch.push(q + ' -> ' + (f ? f.name : 'nichts'));
  }
  ok('7. ' + faelle.length + ' Alltagsbegriffe treffen das richtige Lebensmittel', missMatch.length === 0, missMatch.join(', '));

  // Exakter Name schlägt Teiltreffer: „Ei" darf nicht an „Eiweiß"/„Zwiebel" o. Ä. scheitern
  ok('8. Kurzer Begriff „Ei" liefert das Ei, nicht ein zufälliges Wort mit „ei"', first('Ei').name === 'Ei', first('Ei').name);

  // Zu kurze/leere Anfrage -> nichts
  ok('9. Anfrage < 2 Zeichen liefert leere Liste', BF.search('a', 5).length === 0 && BF.search('', 5).length === 0);

  // Kein Treffer bei Unsinn
  ok('10. Unbekannter Begriff liefert nichts', BF.search('xyzzyfoobar', 5).length === 0);

  // Limit wird eingehalten
  ok('11. Limit wird beachtet', BF.search('e', 3) && BF.search('brot', 2).length <= 2);

  // ── 3) Produktform ──
  const p = BF.toProduct(BF.FOODS[0]);
  ok('12. Produkt trägt synthetischen Barcode (kollidiert nicht mit echtem EAN)', /^grund:/.test(p.barcode));
  ok('13. Produkt hat nutriments.kcal100g (Endpunkt braucht das für isUsable)', p.nutriments && typeof p.nutriments.kcal100g === 'number');
  ok('14. Quelle ist als Grundnahrung markiert', p.source === 'grundnahrung');
  ok('15. Makro-Schlüssel wie bei OFF (protein100g/carbs100g/fat100g)',
    'protein100g' in p.nutriments && 'carbs100g' in p.nutriments && 'fat100g' in p.nutriments);

  // ── 4) Zusammenführung mit OFF-Treffern ──
  const off = [
    { barcode: '111', name: 'Banane', source: 'openfoodfacts' },        // Dublette zu Grundnahrung
    { barcode: '222', name: 'Bananenchips', source: 'openfoodfacts' },  // eigenständig
    { barcode: '333', name: 'Kartoffeln 1kg Beutel', source: 'openfoodfacts' },
  ];
  const baseB = BF.search('Banane', 5);
  const merged = BF.mergeWithOff(baseB, off, 5);
  ok('16. Grundnahrung steht vor den OFF-Treffern', merged[0].source === 'grundnahrung', merged[0].source);
  ok('17. Doppelte „Banane" aus OFF wird verworfen',
    merged.filter((x) => BF.norm(x.name) === 'banane').length === 1);
  ok('18. Eigenständiges OFF-Produkt bleibt erhalten', merged.some((x) => x.name === 'Bananenchips'));
  ok('19. Merge respektiert das Limit', BF.mergeWithOff(BF.search('e', 20), off, 4).length <= 4);
  ok('20. Ohne OFF-Treffer bleibt reine Grundnahrung', BF.mergeWithOff(baseB, [], 5).every((x) => x.source === 'grundnahrung'));
  ok('21. Ohne Grundnahrung reicht OFF durch',
    BF.mergeWithOff([], off, 3).length === 3 && BF.mergeWithOff([], off, 3)[0].name === 'Banane');

  console.log(pass ? 'BASE-FOODS PASS' : 'BASE-FOODS FAIL');
  process.exit(pass ? 0 : 1);
}
run();
