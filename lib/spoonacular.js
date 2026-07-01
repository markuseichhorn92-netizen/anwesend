'use strict';

/**
 * Spoonacular-Anbindung für den Ernährungscoach.
 * ----------------------------------------------
 * Liefert ECHTE Nährwerte (statt KI-Schätzungen) für:
 *   - Lebensmittel-Suche  (searchFoods)     → Erfassen ▸ Suche
 *   - Barcode/Produkt     (productByUpc)     → Erfassen ▸ Barcode
 *   - Rezept-Nährwerte    (nutritionForList) → KI-Rezepte absichern
 *
 * Sprache: Spoonacular ist englisch-basiert. Eingaben werden DE→EN übersetzt,
 * Ergebnis-Namen EN→DE (kleine statische Map + KI-Fallback über lib/ai.js).
 *
 * Der API-Key liegt AUSSCHLIESSLICH als Vercel-Env `SPOONACULAR_API_KEY` vor –
 * niemals im Repo. Ohne Key liefern die Funktionen { ok:false, error:'no_key' },
 * damit der Aufrufer sauber auf Demo-Daten zurückfallen kann.
 */

const AI = require('./ai');

const KEY = process.env.SPOONACULAR_API_KEY;
const BASE = 'https://api.spoonacular.com';
const hasKey = Boolean(KEY);

// ── einfache In-Memory-Caches pro warmer Instanz ──
const cacheTrans = new Map();   // "de:begriff" / "en:begriff" -> übersetzung
const cacheNutri = new Map();   // ingredientId -> {kcal,p,c,f}
const cacheSearch = new Map();  // query -> {at, data}

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

// ── Statische Lebensmittel-Map DE↔EN (deckt die häufigsten Fitness-Foods ab) ──
var DE_EN = {
  'hähnchenbrust': 'chicken breast', 'hähnchen': 'chicken', 'hühnchen': 'chicken', 'pute': 'turkey',
  'rind': 'beef', 'rindfleisch': 'beef', 'hackfleisch': 'ground beef', 'schwein': 'pork', 'lachs': 'salmon',
  'thunfisch': 'tuna', 'garnelen': 'shrimp', 'ei': 'egg', 'eier': 'egg', 'eiweiß': 'egg white',
  'magerquark': 'low fat quark', 'quark': 'quark', 'skyr': 'skyr', 'joghurt': 'yogurt',
  'griechischer joghurt': 'greek yogurt', 'käse': 'cheese', 'harzer käse': 'harzer cheese',
  'hüttenkäse': 'cottage cheese', 'feta': 'feta', 'mozzarella': 'mozzarella', 'milch': 'milk',
  'butter': 'butter', 'sahne': 'cream', 'haferflocken': 'oats', 'hafer': 'oats', 'müsli': 'muesli',
  'reis': 'rice', 'vollkornreis': 'brown rice', 'nudeln': 'pasta', 'vollkornnudeln': 'whole wheat pasta',
  'quinoa': 'quinoa', 'kartoffel': 'potato', 'kartoffeln': 'potato', 'süßkartoffel': 'sweet potato',
  'brot': 'bread', 'vollkornbrot': 'whole grain bread', 'toast': 'toast bread', 'brötchen': 'bread roll',
  'linsen': 'lentils', 'kichererbsen': 'chickpeas', 'bohnen': 'beans', 'kidneybohnen': 'kidney beans',
  'tofu': 'tofu', 'brokkoli': 'broccoli', 'spinat': 'spinach', 'tomate': 'tomato', 'tomaten': 'tomato',
  'gurke': 'cucumber', 'paprika': 'bell pepper', 'zucchini': 'zucchini', 'karotte': 'carrot',
  'karotten': 'carrot', 'möhren': 'carrot', 'salat': 'lettuce', 'blattsalat': 'lettuce', 'avocado': 'avocado',
  'zwiebel': 'onion', 'knoblauch': 'garlic', 'pilze': 'mushrooms', 'champignons': 'mushrooms',
  'apfel': 'apple', 'banane': 'banana', 'beeren': 'berries', 'heidelbeeren': 'blueberries',
  'erdbeeren': 'strawberries', 'himbeeren': 'raspberries', 'orange': 'orange', 'birne': 'pear',
  'traube': 'grapes', 'trauben': 'grapes', 'mandeln': 'almonds', 'walnüsse': 'walnuts', 'nüsse': 'nuts',
  'erdnussbutter': 'peanut butter', 'erdnüsse': 'peanuts', 'cashew': 'cashews', 'cashews': 'cashews',
  'olivenöl': 'olive oil', 'öl': 'oil', 'honig': 'honey', 'zucker': 'sugar', 'schokolade': 'chocolate',
  'proteinriegel': 'protein bar', 'proteinshake': 'protein shake', 'proteinpulver': 'whey protein',
  'orangensaft': 'orange juice', 'apfelsaft': 'apple juice', 'wasser': 'water', 'kaffee': 'coffee',
  'banane': 'banana', 'chiasamen': 'chia seeds', 'leinsamen': 'flax seeds', 'couscous': 'couscous',
  'mais': 'corn', 'erbsen': 'peas', 'rührei': 'scrambled eggs', 'spiegelei': 'fried egg', 'omelett': 'omelette'
};
var EN_DE = {};
Object.keys(DE_EN).forEach(function (k) { if (!EN_DE[DE_EN[k]]) EN_DE[DE_EN[k]] = k; });
// hübsche deutsche Anzeige (Groß-/Umlaut) für die Rück-Map
var EN_DE_NICE = {
  'chicken breast': 'Hähnchenbrust', 'chicken': 'Hähnchen', 'turkey': 'Pute', 'beef': 'Rindfleisch',
  'ground beef': 'Hackfleisch', 'pork': 'Schweinefleisch', 'salmon': 'Lachs', 'tuna': 'Thunfisch',
  'shrimp': 'Garnelen', 'egg': 'Ei', 'egg white': 'Eiweiß', 'low fat quark': 'Magerquark', 'quark': 'Quark',
  'skyr': 'Skyr', 'yogurt': 'Joghurt', 'greek yogurt': 'Griechischer Joghurt', 'cheese': 'Käse',
  'cottage cheese': 'Hüttenkäse', 'feta': 'Feta', 'mozzarella': 'Mozzarella', 'milk': 'Milch',
  'butter': 'Butter', 'cream': 'Sahne', 'oats': 'Haferflocken', 'muesli': 'Müsli', 'rice': 'Reis',
  'brown rice': 'Vollkornreis', 'pasta': 'Nudeln', 'whole wheat pasta': 'Vollkornnudeln', 'quinoa': 'Quinoa',
  'potato': 'Kartoffel', 'sweet potato': 'Süßkartoffel', 'bread': 'Brot', 'whole grain bread': 'Vollkornbrot',
  'toast bread': 'Toast', 'bread roll': 'Brötchen', 'lentils': 'Linsen', 'chickpeas': 'Kichererbsen',
  'beans': 'Bohnen', 'kidney beans': 'Kidneybohnen', 'tofu': 'Tofu', 'broccoli': 'Brokkoli',
  'spinach': 'Spinat', 'tomato': 'Tomate', 'cucumber': 'Gurke', 'bell pepper': 'Paprika',
  'zucchini': 'Zucchini', 'carrot': 'Karotte', 'lettuce': 'Blattsalat', 'avocado': 'Avocado',
  'onion': 'Zwiebel', 'garlic': 'Knoblauch', 'mushrooms': 'Champignons', 'apple': 'Apfel', 'banana': 'Banane',
  'berries': 'Beeren', 'blueberries': 'Heidelbeeren', 'strawberries': 'Erdbeeren', 'raspberries': 'Himbeeren',
  'orange': 'Orange', 'pear': 'Birne', 'grapes': 'Trauben', 'almonds': 'Mandeln', 'walnuts': 'Walnüsse',
  'nuts': 'Nüsse', 'peanut butter': 'Erdnussbutter', 'peanuts': 'Erdnüsse', 'cashews': 'Cashews',
  'olive oil': 'Olivenöl', 'oil': 'Öl', 'honey': 'Honig', 'sugar': 'Zucker', 'chocolate': 'Schokolade',
  'protein bar': 'Proteinriegel', 'protein shake': 'Proteinshake', 'whey protein': 'Proteinpulver',
  'orange juice': 'Orangensaft', 'apple juice': 'Apfelsaft', 'water': 'Wasser', 'coffee': 'Kaffee',
  'chia seeds': 'Chiasamen', 'flax seeds': 'Leinsamen', 'couscous': 'Couscous', 'corn': 'Mais',
  'peas': 'Erbsen', 'scrambled eggs': 'Rührei', 'fried egg': 'Spiegelei', 'omelette': 'Omelett'
};

// Emoji-Zuordnung nach Stichwort (Ergebnisse haben keine Emojis)
function emojiFor(nameEn) {
  var s = String(nameEn || '').toLowerCase();
  var map = [
    ['chicken', '🍗'], ['turkey', '🍗'], ['beef', '🥩'], ['pork', '🥩'], ['steak', '🥩'],
    ['salmon', '🐟'], ['tuna', '🐟'], ['fish', '🐟'], ['shrimp', '🦐'], ['egg', '🥚'],
    ['quark', '🧀'], ['skyr', '🥛'], ['yogurt', '🥛'], ['milk', '🥛'], ['cheese', '🧀'],
    ['oats', '🥣'], ['muesli', '🥣'], ['rice', '🍚'], ['pasta', '🍝'], ['noodle', '🍝'],
    ['bread', '🍞'], ['toast', '🍞'], ['roll', '🥖'], ['potato', '🥔'], ['quinoa', '🍚'],
    ['lentil', '🫘'], ['bean', '🫘'], ['chickpea', '🫘'], ['tofu', '🧊'], ['broccoli', '🥦'],
    ['spinach', '🥬'], ['lettuce', '🥬'], ['salad', '🥗'], ['tomato', '🍅'], ['cucumber', '🥒'],
    ['pepper', '🫑'], ['carrot', '🥕'], ['avocado', '🥑'], ['onion', '🧅'], ['garlic', '🧄'],
    ['mushroom', '🍄'], ['apple', '🍎'], ['banana', '🍌'], ['berr', '🫐'], ['blueberr', '🫐'],
    ['strawberr', '🍓'], ['orange', '🍊'], ['pear', '🍐'], ['grape', '🍇'], ['almond', '🌰'],
    ['nut', '🌰'], ['peanut', '🥜'], ['oil', '🫒'], ['honey', '🍯'], ['sugar', '🍬'],
    ['chocolate', '🍫'], ['protein', '🥤'], ['shake', '🥤'], ['juice', '🧃'], ['coffee', '☕'], ['water', '💧']
  ];
  for (var i = 0; i < map.length; i++) { if (s.indexOf(map[i][0]) >= 0) return map[i][1]; }
  return '🍽️';
}
function bgFor(emoji) {
  var m = { '🍗': '#FBEFE8', '🥩': '#FBEFE8', '🐟': '#EAF4FB', '🦐': '#EAF4FB', '🥚': '#FBF2E1',
    '🧀': '#FBF2E1', '🥛': '#EAF4FB', '🥣': '#FBF2E1', '🍚': '#E9F6EE', '🍝': '#FBF2E1', '🍞': '#FBF2E1',
    '🥖': '#FBF2E1', '🥔': '#FBF2E1', '🫘': '#E9F6EE', '🥦': '#E9F6EE', '🥬': '#E9F6EE', '🥗': '#E9F6EE',
    '🍅': '#FBEFE8', '🥑': '#E9F6EE', '🍎': '#FBEFE8', '🍌': '#FBF2E1', '🫐': '#EAF4FB', '🍓': '#FBEFE8',
    '🥤': '#F1ECFA', '🧃': '#FBF2E1', '💧': '#EAF4FB' };
  return m[emoji] || '#eef3f4';
}

// ── HTTP-Helfer ──
async function getJson(path, params) {
  var qs = Object.assign({ apiKey: KEY }, params || {});
  var url = BASE + path + '?' + Object.keys(qs).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(qs[k]); }).join('&');
  var r = await fetch(url, { headers: { accept: 'application/json' } });
  var text = await r.text().catch(function () { return ''; });
  if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 160) };
  var json = null; try { json = JSON.parse(text); } catch (e) {}
  return { ok: true, json: json };
}

// ── Übersetzung ──
async function translate(term, dir) {
  var t = String(term || '').trim();
  if (!t) return t;
  var low = t.toLowerCase();
  if (dir === 'de2en') {
    if (DE_EN[low]) return DE_EN[low];
    var ck = 'de:' + low; if (cacheTrans.has(ck)) return cacheTrans.get(ck);
    if (!AI.hasAI) return t; // ohne KI: unverändert an Spoonacular geben
    var r = await AI.complete(
      'Übersetze den folgenden deutschen Lebensmittel-/Zutatenbegriff in EIN kurzes, gebräuchliches englisches Lebensmittelwort für eine Ernährungsdatenbank. Antworte NUR mit dem englischen Begriff, ohne Satzzeichen.',
      [{ role: 'user', content: t.slice(0, 60) }], { maxTokens: 20, temperature: 0 });
    var out = r.ok ? r.answer.split('\n')[0].replace(/[."]/g, '').trim().toLowerCase() : t;
    cacheTrans.set(ck, out); return out;
  } else {
    if (EN_DE_NICE[low]) return EN_DE_NICE[low];
    if (EN_DE[low]) return cap(EN_DE[low]);
    var ck2 = 'en:' + low; if (cacheTrans.has(ck2)) return cacheTrans.get(ck2);
    if (!AI.hasAI) return cap(t);
    var r2 = await AI.complete(
      'Übersetze den folgenden englischen Lebensmittelnamen in EIN kurzes deutsches Wort (Singular, korrekte Groß-/Kleinschreibung, mit Umlauten). Antworte NUR mit dem deutschen Wort.',
      [{ role: 'user', content: t.slice(0, 60) }], { maxTokens: 20, temperature: 0 });
    var out2 = r2.ok ? r2.answer.split('\n')[0].replace(/[."]/g, '').trim() : cap(t);
    cacheTrans.set(ck2, out2); return out2;
  }
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

function pickNutri(nutrients) {
  var find = function (name) {
    var n = (nutrients || []).find(function (x) { return x && String(x.name).toLowerCase() === name; });
    return n ? num(n.amount) : 0;
  };
  return { kcal: Math.round(find('calories')), p: Math.round(find('protein')), c: Math.round(find('carbohydrates')), f: Math.round(find('fat')) };
}

// ── Lebensmittel-Suche (Erfassen ▸ Suche) ──
// Gibt Nährwerte pro 100 g zurück (per: '100 g').
async function searchFoods(germanQuery, limit) {
  if (!hasKey) return { ok: false, error: 'no_key' };
  var q = String(germanQuery || '').trim();
  if (q.length < 2) return { ok: true, foods: [] };
  limit = Math.min(8, limit || 6);

  var ck = q.toLowerCase() + '#' + limit;
  var cached = cacheSearch.get(ck);
  if (cached && (Date.now() - cached.at) < 6 * 3600 * 1000) return { ok: true, foods: cached.data, cached: true };

  var en = await translate(q, 'de2en');
  var s = await getJson('/food/ingredients/search', { query: en, number: limit, sort: 'calories', sortDirection: 'desc' });
  if (!s.ok) return { ok: false, error: s.error, status: s.status };
  var results = (s.json && s.json.results) || [];

  var foods = [];
  for (var i = 0; i < results.length; i++) {
    var it = results[i];
    var nutri = cacheNutri.get(it.id);
    if (!nutri) {
      var info = await getJson('/food/ingredients/' + it.id + '/information', { amount: 100, unit: 'grams' });
      if (info.ok && info.json && info.json.nutrition) { nutri = pickNutri(info.json.nutrition.nutrients); cacheNutri.set(it.id, nutri); }
    }
    if (!nutri) continue;
    var nameDe = await translate(it.name, 'en2de');
    var emoji = emojiFor(it.name);
    foods.push({ id: it.id, name: nameDe, nameEn: it.name, per: '100 g', kcal: nutri.kcal, p: nutri.p, c: nutri.c, f: nutri.f, emoji: emoji, bg: bgFor(emoji) });
  }
  cacheSearch.set(ck, { at: Date.now(), data: foods });
  return { ok: true, foods: foods };
}

// ── Produkt per Barcode/UPC (Erfassen ▸ Barcode) ──
async function productByUpc(upc) {
  if (!hasKey) return { ok: false, error: 'no_key' };
  var code = String(upc || '').replace(/\D/g, '');
  if (!code) return { ok: false, error: 'bad_upc' };
  var r = await getJson('/food/products/upc/' + code, {});
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  var p = r.json || {};
  var nutrients = (p.nutrition && p.nutrition.nutrients) || [];
  var n = pickNutri(nutrients);
  var nameDe = await translate(String(p.title || '').split(',')[0], 'en2de').catch(function () { return p.title; });
  var emoji = emojiFor(p.title || '');
  return {
    ok: true,
    product: {
      name: p.title || nameDe, nameDe: nameDe, brand: p.brand || '',
      per: '1 Portion', kcal: n.kcal, p: n.p, c: n.c, f: n.f, emoji: emoji, bg: bgFor(emoji), image: p.image || null
    }
  };
}

// ── Nährwerte einer Zutatenliste (KI-Rezepte absichern) ──
// ingredients: [{name, qty}] (deutsch)  |  servings: Anzahl Portionen
// Rückgabe: { ok, perServing:{kcal,protein,carbs,fat} }
async function nutritionForList(ingredients, servings) {
  if (!hasKey) return { ok: false, error: 'no_key' };
  var list = Array.isArray(ingredients) ? ingredients : [];
  if (!list.length) return { ok: false, error: 'empty' };
  servings = Math.max(1, num(servings) || 1);

  // Zutaten DE→EN übersetzen, Menge voranstellen: "150 g chicken breast"
  var lines = [];
  for (var i = 0; i < list.length; i++) {
    var name = await translate(String(list[i].name || ''), 'de2en');
    var qty = String(list[i].qty || list[i].amount || '').trim();
    lines.push((qty ? qty + ' ' : '') + name);
  }
  var body = 'ingredientList=' + encodeURIComponent(lines.join('\n')) +
    '&servings=' + servings + '&includeNutrition=true&language=en';
  var url = BASE + '/recipes/parseIngredients?apiKey=' + encodeURIComponent(KEY);
  var r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body });
  var text = await r.text().catch(function () { return ''; });
  if (!r.ok) return { ok: false, status: r.status, error: text.slice(0, 160) };
  var arr = null; try { arr = JSON.parse(text); } catch (e) {}
  if (!Array.isArray(arr) || !arr.length) return { ok: false, error: 'no_data' };

  var sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  arr.forEach(function (ing) {
    var ns = (ing.nutrition && ing.nutrition.nutrients) || [];
    var pn = pickNutri(ns);
    sum.kcal += pn.kcal; sum.protein += pn.p; sum.carbs += pn.c; sum.fat += pn.f;
  });
  // parseIngredients rechnet die Gesamtmenge; pro Portion teilen:
  var per = {
    kcal: Math.round(sum.kcal / servings), protein: Math.round(sum.protein / servings),
    carbs: Math.round(sum.carbs / servings), fat: Math.round(sum.fat / servings)
  };
  if (!per.kcal) return { ok: false, error: 'zero' };
  return { ok: true, perServing: per };
}

module.exports = { hasKey, searchFoods, productByUpc, nutritionForList, translate, emojiFor, bgFor };
