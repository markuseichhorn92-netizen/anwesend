'use strict';

/**
 * POST /api/nutrition/recipe   – FINN erzeugt ein deutsches Rezept.
 * -----------------------------------------------------------------
 * Body (JSON):
 *   { mode:'create'|'fridge', text, goal?, kcal?, portions? }
 *     - mode 'create': `text` = Wunsch ("proteinreiches Frühstück, schnell")
 *     - mode 'fridge': `text` = vorhandene Zutaten ("Hähnchen, Reis, Brokkoli")
 *     - goal: Ziel (z. B. "Abnehmen"), kcal: Ziel-Kalorien/Portion, portions: Anzahl
 *
 * Antwort:
 *   { ok:true, ai:true, recipe:{...} }   – KI-Rezept (Claude Haiku)
 *   { ok:true, ai:false, recipe:{...} }  – Demo-Rezept (kein Key / Fehler)
 *
 * Grundgerüst-Endpoint: braucht KEINE Mitglieder-Anmeldung (zum Testen),
 * ist aber leicht IP-ratenbegrenzt. Nutzt ANTHROPIC_API_KEY / AI_MODEL wie lib/ai.js.
 */

const SP = require('../../lib/spoonacular');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const hasAI = Boolean(KEY);

// Ersetzt die KI-geschätzten Nährwerte durch echte Spoonacular-Werte (falls Key & Daten da).
async function verifyNutrition(recipe) {
  try {
    if (!SP.hasKey || !recipe || !Array.isArray(recipe.ingredients) || !recipe.ingredients.length) return recipe;
    const r = await SP.nutritionForList(recipe.ingredients, recipe.portions || 1);
    if (r && r.ok && r.perServing && r.perServing.kcal) {
      recipe.nutrition = r.perServing;
      recipe.nutritionSource = 'spoonacular';
    } else {
      recipe.nutritionSource = 'ai_estimate';
    }
  } catch (e) { recipe.nutritionSource = 'ai_estimate'; }
  return recipe;
}

// Einfache In-Memory-Ratenbremse pro warmer Instanz (kein Store nötig).
const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 20;
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < win; });
  arr.push(now); hits.set(ip, arr);
  return arr.length <= max;
}

const SYSTEM = [
  'Du bist FINN, der Ernährungscoach des Fitnessstudios Fit-Inn Trier.',
  'Erstelle ein alltagstaugliches, gesundes Rezept auf DEUTSCH, passend zu Fitness-Zielen.',
  'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt – kein Fließtext, keine Code-Fences, keine Erklärung davor oder danach.',
  'Schema (alle Felder Pflicht):',
  '{',
  '  "title": string,                       // knackiger Rezeptname',
  '  "subtitle": string,                    // 1 kurzer Satz, worum es geht',
  '  "minutes": number,                     // Zubereitungszeit in Minuten',
  '  "portions": number,                    // Portionen',
  '  "tags": string[],                      // 1-3 kurze Tags, z.B. "proteinreich"',
  '  "ingredients": [{"name": string, "qty": string}],   // Zutat + Menge (z.B. "150 g")',
  '  "steps": string[],                     // Zubereitungsschritte, je 1 Satz',
  '  "nutrition": {"kcal": number, "protein": number, "carbs": number, "fat": number}  // pro Portion, Gramm',
  '}',
  'Die Nährwerte sind fundierte Schätzungen pro Portion. Halte dich an gängige Lebensmittel, die man in Deutschland bekommt.',
].join('\n');

function buildUserPrompt(d) {
  const parts = [];
  if (d.mode === 'fridge') {
    parts.push('Koche etwas aus diesen vorhandenen Zutaten (Grundzutaten wie Salz, Öl, Gewürze dürfen ergänzt werden): ' + (d.text || ''));
  } else {
    parts.push('Rezeptwunsch: ' + (d.text || 'ein gesundes, ausgewogenes Gericht'));
  }
  if (d.goal) parts.push('Ziel des Mitglieds: ' + d.goal + '.');
  if (d.kcal) parts.push('Ziel-Kalorien pro Portion: ca. ' + d.kcal + ' kcal.');
  if (d.portions) parts.push('Portionen: ' + d.portions + '.');
  return parts.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function demoRecipe(d) {
  const fridge = d.mode === 'fridge';
  return {
    title: fridge ? 'Schnelle Pfanne aus dem Kühlschrank' : 'Protein-Bowl mit Quinoa',
    subtitle: fridge ? 'Aus dem, was da ist – in 20 Minuten fertig.' : 'Sättigend, eiweißreich und schnell gemacht.',
    minutes: 20,
    portions: d.portions ? Number(d.portions) : 2,
    tags: ['proteinreich', 'schnell'],
    ingredients: fridge
      ? [{ name: 'vorhandenes Gemüse', qty: '200 g' }, { name: 'Eiweißquelle (z. B. Hähnchen/Tofu)', qty: '150 g' }, { name: 'Reis oder Nudeln', qty: '120 g' }, { name: 'Öl, Salz, Gewürze', qty: 'nach Geschmack' }]
      : [{ name: 'Quinoa', qty: '80 g' }, { name: 'Hähnchenbrust', qty: '150 g' }, { name: 'Brokkoli', qty: '150 g' }, { name: 'Kirschtomaten', qty: '100 g' }, { name: 'Olivenöl', qty: '1 EL' }],
    steps: [
      'Sättigungsbeilage nach Packung garen.',
      'Eiweißquelle in einer Pfanne mit etwas Öl anbraten, würzen.',
      'Gemüse zugeben und bissfest garen.',
      'Alles anrichten und genießen.',
    ],
    nutrition: { kcal: d.kcal ? Number(d.kcal) : 520, protein: 38, carbs: 45, fat: 16 },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateOk(ip)) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' })); }

  // Body lesen (kein Framework – manuell).
  let raw = '';
  await new Promise(function (resolve) { req.on('data', function (c) { raw += c; }); req.on('end', resolve); req.on('error', resolve); });
  let d = {}; try { d = raw ? JSON.parse(raw) : {}; } catch (e) { d = {}; }
  d.text = String(d.text || '').slice(0, 600);
  d.mode = d.mode === 'fridge' ? 'fridge' : 'create';

  if (!hasAI) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, recipe: demoRecipe(d) }));
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0.6,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildUserPrompt(d) }],
      }),
    });
    const text = await r.text().catch(function () { return ''; });
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    const out = json && Array.isArray(json.content)
      ? json.content.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n')
      : '';
    let recipe = extractJson(out);
    if (r.ok && recipe && recipe.title && Array.isArray(recipe.ingredients)) {
      recipe = await verifyNutrition(recipe);   // echte Nährwerte via Spoonacular (falls Key)
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, ai: true, recipe: recipe, model: MODEL }));
    }
    // Modell hat kein sauberes JSON geliefert -> Demo, damit die UI weiterläuft.
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, recipe: demoRecipe(d), note: 'fallback_parse' }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, ai: false, recipe: demoRecipe(d), note: 'fallback_error' }));
  }
};
