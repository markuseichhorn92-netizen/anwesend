'use strict';

/**
 * Grundnahrungsmittel – die Basis-Schicht der Lebensmittelsuche.
 * -------------------------------------------------------------------------
 * Warum: Open Food Facts ist eine Verpackungs-/Barcode-Datenbank. Sie kennt
 * Markenprodukte mit Etikett, aber kaum unverpackte Grundnahrungsmittel. Wer
 * „Kartoffeln" sucht, bekam dort irgendein verpacktes Produkt, dessen Name das
 * Wort enthält (z. B. „Roggen-Vollkorn-Knäckebrot", 373 kcal) – also FALSCHE
 * Nährwerte, nicht nur schlechte Treffer. Diese Rückmeldung („Suche schwer,
 * Lebensmittel fehlen") war der Anlass.
 *
 * Deshalb eine kuratierte Basis der am häufigsten geloggten Alltags-Lebensmittel
 * mit Werten je 100 g/ml. Sie wird in der Suche VOR die OFF-Markenprodukte
 * sortiert und funktioniert offline und ohne Rate-Limit. Damit findet „Kartoffeln"
 * wieder Kartoffeln.
 *
 * Diese Datei ist bewusst die Einstiegsschicht: der vollständige amtliche
 * Bundeslebensmittelschlüssel (BLS 4.0, 7.140 Lebensmittel, seit Dez. 2025 unter
 * CC BY 4.0 frei) lässt sich später über DENSELBEN Suchpfad ergänzen, ohne dass
 * sich am Client oder an der Endpunkt-Logik etwas ändert.
 *
 * Alle Werte sind Standard-Referenzwerte gängiger Nährwerttabellen. Der Test
 * tests/base-foods.test.js prüft JEDEN Eintrag per Atwater-Formel (kcal ≈
 * 4·Eiweiß + 4·Kohlenhydrate + 9·Fett, mit Ballaststoff-Korrektur) und fängt so
 * Tippfehler automatisch ab.
 */

// Kompaktformat je Zeile:  [Name, kcal, Eiweiß, KH, Fett, Ballaststoffe, Zucker, "Synonyme; …"]
// Werte je 100 g bzw. je 100 ml (Getränke). Fehlende Ballaststoffe/Zucker = 0.
// Kategorie nur zur Sortier-Feinjustierung (Grundzutaten vor Zubereitetem).
const ROWS = [
  // ── Obst (roh) ──
  ['Apfel', 52, 0.3, 14, 0.2, 2.4, 10, 'aepfel'],
  ['Banane', 89, 1.1, 23, 0.3, 2.6, 12, 'bananen'],
  ['Orange', 47, 0.9, 12, 0.1, 2.4, 9, 'orangen; apfelsine'],
  ['Birne', 57, 0.4, 15, 0.1, 3.1, 10, 'birnen'],
  ['Erdbeeren', 32, 0.7, 8, 0.3, 2, 5, 'erdbeere'],
  ['Heidelbeeren', 57, 0.7, 14, 0.3, 2.4, 10, 'blaubeeren'],
  ['Himbeeren', 52, 1.2, 12, 0.7, 6.5, 4.4, 'himbeere'],
  ['Weintrauben', 69, 0.7, 18, 0.2, 0.9, 16, 'trauben'],
  ['Ananas', 50, 0.5, 13, 0.1, 1.4, 10, ''],
  ['Mango', 60, 0.8, 15, 0.4, 1.6, 14, ''],
  ['Kiwi', 61, 1.1, 15, 0.5, 3, 9, ''],
  ['Wassermelone', 30, 0.6, 8, 0.2, 0.4, 6, 'melone'],
  ['Pfirsich', 39, 0.9, 10, 0.3, 1.5, 8, 'pfirsiche; nektarine'],
  ['Zitrone', 29, 1.1, 9, 0.3, 2.8, 2.5, 'zitronen'],
  ['Avocado', 160, 2, 9, 15, 7, 0.7, 'avocados'],
  ['Datteln', 282, 2.5, 75, 0.4, 8, 63, 'dattel'],
  ['Rosinen', 299, 3.1, 79, 0.5, 3.7, 59, ''],
  ['Apfelmus', 42, 0.2, 11, 0.1, 1.1, 9, ''],

  // ── Gemüse (roh, sonst gekennzeichnet) ──
  ['Kartoffeln, gekocht', 87, 2, 20, 0.1, 1.8, 0.9, 'kartoffel; salzkartoffeln; pellkartoffeln'],
  ['Süßkartoffel, gekocht', 76, 1.4, 18, 0.1, 2.5, 5.7, 'suesskartoffel; batate'],
  ['Karotte', 41, 0.9, 10, 0.2, 2.8, 4.7, 'karotten; moehre; moehren; mohrrübe'],
  ['Brokkoli', 34, 2.8, 7, 0.4, 2.6, 1.7, 'broccoli'],
  ['Tomate', 18, 0.9, 3.9, 0.2, 1.2, 2.6, 'tomaten'],
  ['Gurke', 15, 0.7, 3.6, 0.1, 0.5, 1.7, 'gurken; salatgurke'],
  ['Paprika', 31, 1, 6, 0.3, 2.1, 4.2, 'paprikaschote'],
  ['Zwiebel', 40, 1.1, 9, 0.1, 1.7, 4.2, 'zwiebeln'],
  ['Spinat', 23, 2.9, 3.6, 0.4, 2.2, 0.4, 'blattspinat'],
  ['Blumenkohl', 25, 1.9, 5, 0.3, 2, 1.9, 'karfiol'],
  ['Zucchini', 17, 1.2, 3.1, 0.3, 1, 2.5, ''],
  ['Champignons', 22, 3.1, 3.3, 0.3, 1, 2, 'pilze; champignon'],
  ['Aubergine', 25, 1, 6, 0.2, 3, 3.5, 'auberginen; melanzani'],
  ['Erbsen', 81, 5, 14, 0.4, 5, 6, 'erbse; gruene erbsen'],
  ['Grüne Bohnen', 31, 1.8, 7, 0.1, 3.4, 1.4, 'gruene bohnen; buschbohnen; fisolen'],
  ['Mais', 86, 3.2, 19, 1.2, 2.7, 3.2, 'maiskoerner'],
  ['Kopfsalat', 15, 1.4, 2.9, 0.2, 1.3, 0.8, 'salat; gruener salat'],
  ['Rucola', 25, 2.6, 3.7, 0.7, 1.6, 2, 'rauke'],
  ['Kürbis', 26, 1, 6, 0.1, 0.5, 2.8, 'hokkaido; kuerbis'],
  ['Rote Bete, gekocht', 44, 1.7, 10, 0.2, 2, 7, 'rote beete; rote rübe'],
  ['Sellerie', 42, 1.5, 9, 0.3, 1.8, 1.8, 'knollensellerie'],

  // ── Getreide, Brot, Beilagen ──
  ['Haferflocken', 372, 13, 59, 7, 10, 1, 'hafer; oats'],
  ['Reis, gekocht', 130, 2.7, 28, 0.3, 0.4, 0.1, 'weisser reis; basmatireis'],
  ['Vollkornreis, gekocht', 111, 2.6, 23, 0.9, 1.8, 0.4, 'naturreis; brauner reis'],
  ['Nudeln, gekocht', 158, 5.8, 31, 0.9, 1.8, 0.6, 'pasta; spaghetti; penne'],
  ['Vollkornnudeln, gekocht', 149, 6, 30, 1.4, 4, 1, 'vollkornpasta'],
  ['Quinoa, gekocht', 120, 4.4, 21, 1.9, 2.8, 0.9, ''],
  ['Couscous, gekocht', 112, 3.8, 23, 0.2, 1.4, 0, ''],
  ['Bulgur, gekocht', 83, 3.1, 19, 0.2, 4.5, 0.1, ''],
  ['Vollkornbrot', 217, 7, 41, 3.4, 7, 3, 'vollkornbrote; körnerbrot'],
  ['Roggenbrot', 250, 6.5, 48, 1.7, 6, 2, 'roggenbrote'],
  ['Weißbrot', 265, 9, 49, 3.2, 2.7, 5, 'weissbrot; toastbrot; toast'],
  ['Brötchen', 280, 9, 53, 2.5, 3, 3, 'broetchen; semmel; weck'],
  ['Knäckebrot', 334, 10, 65, 3, 16, 1, 'knaeckebrot'],
  ['Reiswaffeln', 387, 8, 82, 3, 3, 0.5, 'reiswaffel'],
  ['Cornflakes', 357, 7, 84, 0.9, 3, 8, ''],

  // ── Milchprodukte & Eier ──
  ['Milch 3,5%', 64, 3.3, 4.8, 3.6, 0, 4.8, 'vollmilch; milch'],
  ['Milch 1,5%', 47, 3.4, 4.9, 1.5, 0, 4.9, 'fettarme milch'],
  ['Naturjoghurt 3,5%', 61, 3.5, 4.7, 3.5, 0, 4.7, 'joghurt'],
  ['Joghurt 1,5%', 50, 4.3, 6, 1.5, 0, 6, 'fettarmer joghurt'],
  ['Magerquark', 67, 12, 4, 0.2, 0, 4, 'quark; speisequark mager'],
  ['Speisequark 20%', 109, 12, 3.2, 5, 0, 3.2, ''],
  ['Skyr', 63, 11, 4, 0.2, 0, 4, ''],
  ['Hüttenkäse', 98, 11, 3, 4.3, 0, 3, 'huettenkaese; koerniger frischkaese; cottage cheese'],
  ['Frischkäse', 253, 6, 4, 24, 0, 3, 'frischkaese'],
  ['Gouda', 356, 25, 2.2, 27, 0, 0, 'kaese; gouda kaese'],
  ['Mozzarella', 254, 18, 1, 20, 0, 1, ''],
  ['Feta', 264, 14, 4, 21, 0, 4, 'schafskaese'],
  ['Parmesan', 431, 38, 4, 29, 0, 0.9, ''],
  ['Butter', 741, 0.7, 0.6, 83, 0, 0.6, ''],
  ['Ei', 155, 13, 1.1, 11, 0, 1.1, 'eier; huehnerei; spiegelei; ruehrei; gekochtes ei'],

  // ── Fleisch & Fisch ──
  ['Hähnchenbrust, gegart', 165, 31, 0, 3.6, 0, 0, 'haehnchenbrust; hühnchen; hähnchen; putenbrust'],
  ['Putenbrust, gegart', 135, 29, 0, 1, 0, 0, ''],
  ['Rinderhackfleisch, roh', 215, 19, 0, 15, 0, 0, 'hackfleisch; rinderhack; faschiertes'],
  ['Rindersteak, gegart', 217, 26, 0, 12, 0, 0, 'steak; rindfleisch'],
  ['Schweinefilet, roh', 143, 22, 0, 6, 0, 0, 'schweinefleisch; schnitzel'],
  ['Kochschinken', 107, 18, 0.8, 3.3, 0, 0.8, 'schinken; gekochter schinken'],
  ['Salami', 336, 20, 1, 28, 0, 1, ''],
  ['Lachs', 208, 20, 0, 13, 0, 0, 'lachsfilet'],
  ['Thunfisch in Wasser', 116, 26, 0, 1, 0, 0, 'thunfisch'],
  ['Kabeljau', 82, 18, 0, 0.7, 0, 0, 'dorsch'],
  ['Forelle', 119, 18, 0, 5, 0, 0, ''],
  ['Garnelen', 99, 24, 0, 0.3, 0, 0, 'shrimps; scampi'],

  // ── Hülsenfrüchte, Nüsse, Fette ──
  ['Linsen, gekocht', 116, 9, 20, 0.4, 8, 1.8, 'linse'],
  ['Kichererbsen, gekocht', 164, 9, 27, 2.6, 8, 5, ''],
  ['Kidneybohnen, gekocht', 127, 9, 23, 0.5, 7, 0.3, 'bohnen; rote bohnen'],
  ['Tofu', 144, 15, 3, 9, 0, 0.6, 'tofu natur'],
  ['Erdnüsse', 567, 26, 16, 49, 9, 4, 'erdnuss'],
  ['Mandeln', 579, 21, 22, 50, 12, 4, 'mandel'],
  ['Walnüsse', 654, 15, 14, 65, 7, 2.6, 'walnuss'],
  ['Haselnüsse', 628, 15, 17, 61, 10, 4, 'haselnuss'],
  ['Cashewkerne', 553, 18, 30, 44, 3, 6, 'cashew; cashews'],
  ['Sonnenblumenkerne', 584, 21, 20, 51, 9, 2.6, ''],
  ['Leinsamen', 534, 18, 29, 42, 27, 1.6, ''],
  ['Chiasamen', 486, 17, 42, 31, 34, 0, 'chia'],
  ['Erdnussbutter', 588, 25, 20, 50, 6, 9, 'erdnussmus'],
  ['Olivenöl', 884, 0, 0, 100, 0, 0, 'olivenoel; oel'],
  ['Rapsöl', 884, 0, 0, 100, 0, 0, 'rapsoel'],

  // ── Süßes, Aufstriche, Sonstiges ──
  ['Honig', 304, 0.3, 82, 0, 0, 82, ''],
  ['Zucker', 400, 0, 100, 0, 0, 100, 'haushaltszucker'],
  ['Marmelade', 250, 0.4, 62, 0.1, 1, 48, 'konfitüre; konfituere'],
  ['Ketchup', 112, 1.2, 26, 0.1, 0.3, 22, ''],
  ['Zartbitterschokolade', 598, 8, 46, 43, 11, 24, 'dunkle schokolade; zartbitter'],
  ['Vollmilchschokolade', 535, 8, 59, 30, 3, 52, 'schokolade'],

  // ── Getränke (je 100 ml, alkoholfrei) ──
  ['Orangensaft', 45, 0.7, 10, 0.2, 0.2, 8, 'o-saft; orangensaft frisch'],
  ['Apfelsaft', 46, 0.1, 11, 0.1, 0.2, 10, ''],
  ['Cola', 42, 0, 11, 0, 0, 11, 'coca cola; softdrink'],
];

// ── Suche vorbereiten: normalisierte Namens-/Synonymtabelle ──
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Kuratierte Grundnahrungsmittel aufbereiten (Name + Synonyme -> Suchbegriffe).
function fromCurated(r, i) {
  const syn = String(r[7] || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
  const baseName = String(r[0]).split(',')[0];   // „Kartoffeln, gekocht" -> „Kartoffeln" fürs Matching
  const terms = [norm(r[0]), norm(baseName)].concat(syn.map(norm)).filter(Boolean);
  return {
    id: 'grund-' + String(i + 1).padStart(3, '0'),
    name: r[0],
    kcal: r[1], p: r[2], c: r[3], f: r[4], fiber: r[5], sugar: r[6],
    satfat: null, salt: null,
    terms: Array.from(new Set(terms)),
  };
}

/**
 * Vollständige Lebensmittelbasis bauen: die kuratierten Alltags-Lebensmittel zuerst
 * (kurze Namen, Synonyme, gerundete Werte) und danach – falls vorhanden – der
 * vollständige Bundeslebensmittelschlüssel (BLS). BLS-Einträge, deren Name bereits
 * durch ein kuratiertes Lebensmittel abgedeckt ist, werden übersprungen, damit die
 * gepflegte, synonymreiche Version die häufigen Begriffe gewinnt.
 */
function buildFoods(rows, blsArr) {
  const curated = rows.map(fromCurated);
  // Nur EXAKT gleiche (voll normalisierte) Namen entdoppeln – die kuratierten Namen und
  // schon aufgenommene BLS-Namen. NICHT über den Wortstamm: sonst fielen gerade die
  // BLS-Varianten weg, die den Mehrwert bringen (z. B. „Reis, ungeschält, roh" nur weil
  // „Reis" kuratiert ist). Dass die gepflegte kurze Version bei häufigen Begriffen oben
  // steht, sichert das Such-Ranking, nicht das Wegwerfen.
  const usedNames = new Set(curated.map(function (f) { return norm(f.name); }));
  const out = curated.slice();
  (Array.isArray(blsArr) ? blsArr : []).forEach(function (b, i) {
    const name = String(b && b.name || '').replace(/\s+/g, ' ').trim();
    if (!name || b.kcal == null) return;
    const nName = norm(name);
    if (!nName || usedNames.has(nName)) return;
    usedNames.add(nName);
    const nBase = norm(name.split(',')[0].split('(')[0]);
    out.push({
      id: 'bls-' + String(i + 1).padStart(5, '0'),
      name: name.slice(0, 80),
      kcal: b.kcal, p: b.p || 0, c: b.c || 0, f: b.f || 0, fiber: b.fiber || 0, sugar: b.sugar || 0,
      satfat: b.satfat != null ? b.satfat : null, salt: b.salt != null ? b.salt : null,
      terms: Array.from(new Set([nName, nBase].filter(Boolean))),
    });
  });
  return out;
}

// Vollständigen BLS-Datensatz laden, sofern er importiert wurde (scripts/import-bls.js).
// Fehlt die Datei, bleibt es bei den kuratierten Grundnahrungsmitteln – nichts bricht.
function loadBls() {
  try {
    const data = require('./data/bls-foods.json');
    return (data && Array.isArray(data.foods)) ? data.foods : [];
  } catch (e) { return []; }
}

const FOODS = buildFoods(ROWS, loadBls());

// Ein Grundnahrungsmittel in die interne Produktform bringen (wie lib/openFoodFacts.normalize),
// damit der Endpunkt es identisch zu OFF-Produkten weiterverarbeiten kann.
function toProduct(fo) {
  return {
    barcode: 'grund:' + fo.id,
    name: fo.name,
    brand: null,
    quantity: null,
    servingSize: null,
    nutritionBasis: '100g',
    nutriments: {
      kcal100g: fo.kcal,
      protein100g: fo.p,
      carbs100g: fo.c,
      fat100g: fo.f,
      satfat100g: fo.satfat != null ? fo.satfat : null,
      fiber100g: fo.fiber,
      sugars100g: fo.sugar,
      salt100g: fo.salt != null ? fo.salt : null,
    },
    nutriScore: null,        // Note berechnet der Endpunkt aus den Nährwerten
    imageUrl: null,
    source: 'grundnahrung',
    sourceUrl: null,
  };
}

/**
 * Suche in den Grundnahrungsmitteln.
 * Rang: exakter Name > Name beginnt mit Suchbegriff > Wortanfang im Namen/Synonym > enthalten.
 * Kürzere Namen bei gleichem Rang zuerst (spezifischer Treffer).
 * Gibt Produkte in der internen Form zurück (siehe toProduct).
 */
function search(query, limit) {
  const q = norm(query);
  if (q.length < 2) return [];
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
  const qWord = new RegExp('(^| )' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const scored = [];
  for (const fo of FOODS) {
    let best = 0;
    for (const t of fo.terms) {
      let s = 0;
      if (t === q) s = 100;
      else if (t.indexOf(q) === 0) s = 80;
      else if (qWord.test(t)) s = 60;
      else if (t.indexOf(q) >= 0) s = 40;
      if (s > best) best = s;
    }
    if (best > 0) scored.push({ fo: fo, s: best });
  }
  scored.sort(function (a, b) { return (b.s - a.s) || (a.fo.name.length - b.fo.name.length); });
  return scored.slice(0, lim).map(function (x) { return toProduct(x.fo); });
}

/**
 * Grundnahrungsmittel-Treffer VOR die OFF-Markenprodukte mischen.
 * - Grundnahrung zuerst (die verlässlichen, unverpackten Werte),
 * - aber ein paar Plätze für OFF reservieren, damit gebrandete Produkte nicht komplett
 *   verdrängt werden (seit der vollständige BLS viele Varianten je Begriff liefert),
 * - OFF-Produkte, deren Name schon durch ein Grundnahrungsmittel abgedeckt ist, entfallen
 *   (verhindert doppelte „Banane"),
 * - insgesamt auf `limit` gekappt.
 * Beide Listen sind bereits in der internen Produktform.
 */
function mergeWithOff(baseProducts, offProducts, limit) {
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
  const base = Array.isArray(baseProducts) ? baseProducts : [];
  const off = Array.isArray(offProducts) ? offProducts : [];
  const covered = new Set();
  base.forEach(function (p) {
    covered.add(norm(p.name));
    covered.add(norm(String(p.name || '').split(',')[0]));   // „Kartoffeln, gekocht" -> „kartoffeln"
  });
  const offClean = off.filter(function (p) { const n = norm(p && p.name); return n && !covered.has(n); });
  // Bis zu einem Drittel der Plätze für OFF reservieren (aber nur so viele wie vorhanden).
  const reserve = Math.min(offClean.length, Math.floor(lim / 3));
  const out = base.slice(0, Math.max(0, lim - reserve));
  const seen = new Set(out.map(function (p) { return norm(p.name); }));
  for (const p of offClean) { if (out.length >= lim) break; const n = norm(p.name); if (seen.has(n)) continue; seen.add(n); out.push(p); }
  // Falls noch Platz ist (wenig OFF), mit weiterer Grundnahrung auffüllen.
  for (const p of base.slice(Math.max(0, lim - reserve))) { if (out.length >= lim) break; const n = norm(p.name); if (seen.has(n)) continue; seen.add(n); out.push(p); }
  return out.slice(0, lim);
}

module.exports = { FOODS, ROWS, search, toProduct, norm, mergeWithOff, buildFoods };
