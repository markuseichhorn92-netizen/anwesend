'use strict';

/**
 * Studio-weite Rezept-Bibliothek (wächst mit jeder FINN-Generierung).
 * ------------------------------------------------------------------
 * Alle generierten Rezepte landen in EINER gemeinsamen, studioweiten Bibliothek,
 * damit sie erhalten bleiben und der Bestand stetig wächst. Deduplizierung über
 * einen normalisierten Titel (Redis-Hash, atomar via HSETNX). Reihenfolge:
 * neueste zuerst (LPUSH), gedeckelt via LTRIM.
 *
 * Datenmodell (Upstash Redis):
 *   nutri:lib:idx        LIST  – Rezept-IDs, neueste zuerst
 *   nutri:lib:r:<id>     STRING(JSON) – das Rezept
 *   nutri:lib:titles     HASH  – normTitle -> id (Dedup)
 *   nutri:lib:seeded     STRING – Flag „Startbestand übernommen"
 *
 * Kanonische Rezept-Form (Makros gelten PRO PORTION):
 *   { id, title, source, servings, minutes, kcal, protein, carbs, fat,
 *     weightG, fruitVegPct, ingredients:[{text,grams}], steps:[..],
 *     finnRating:{stars,text}, nutri:{grade,points}|null, createdAt }
 */

const { redisPipeline, hasStore } = require('./store');
const NS = require('./nutriscore');

const IDX = 'nutri:lib:idx';
const RKEY = (id) => 'nutri:lib:r:' + id;
const TITLES = 'nutri:lib:titles';
const SEEDED = 'nutri:lib:seeded';
const CAP = 300;   // so viele Rezepte hält die Bibliothek maximal (neueste)

function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }
function clampN(v, lo, hi, def) { const n = Number(v); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }
function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// Titel für die Dedup normalisieren: Kleinbuchstaben, ohne Akzente/Sonderzeichen.
function normTitle(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Kurze, kollisionsarme ID ohne Date.now()/Math.random() (die im Workflow-Kontext fehlen):
// aus normalisiertem Titel + Länge. Reicht als Schlüssel (Dedup läuft ohnehin über den Titel).
function idFor(title) {
  const base = normTitle(title).replace(/\s+/g, '-').slice(0, 40) || 'rezept';
  let h = 0; const s = normTitle(title);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return base + '-' + h.toString(36);
}

// Zutat -> {text, grams}. Akzeptiert String ("200 g Reis") oder {name/text, grams}.
function normIngredient(x) {
  if (x && typeof x === 'object') {
    const grams = (x.grams != null) ? clampN(x.grams, 0, 5000, 0) : null;
    const name = str(x.name || x.text, 90);
    if (!name) return null;
    const text = grams ? (grams + ' g ' + name) : name;
    return { text: text, grams: grams };
  }
  const text = str(x, 90);
  if (!text) return null;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);
  const grams = m ? Math.round(parseFloat(m[1].replace(',', '.'))) : null;
  return { text: text, grams: grams };
}

// Küchenutensilien aus Schritten/Zutaten grob ableiten, falls keine angegeben sind.
function deriveUtensils(rec) {
  const hay = (rec.title + ' ' + (rec.steps || []).join(' ') + ' ' + (rec.ingredients || []).map(function (i) { return i.text; }).join(' ')).toLowerCase();
  const out = [];
  const add = function (u) { if (out.indexOf(u) < 0) out.push(u); };
  if (/\bofen|backen|backblech|überbacken|gratin/.test(hay)) { add('Backofen'); add('Backblech'); }
  if (/\bbraten|anbraten|pfanne|omelett|rührei|wok/.test(hay)) add('Pfanne');
  if (/\bkochen|köcheln|aufkochen|suppe|nudeln|reis|brühe/.test(hay)) add('Topf');
  if (/\bpürieren|mixen|smoothie/.test(hay)) add('Pürierstab oder Mixer');
  if (/\brühren|verquirlen|mischen|schüssel|teig|marinieren/.test(hay)) add('Schüssel');
  if (/\breiben|geriebe/.test(hay)) add('Reibe');
  add('Messer'); add('Schneidebrett');
  return out.slice(0, 6);
}
// Rohes Rezept in die kanonische Form bringen + Nutri-Score rechnen. Wirft nie.
function normalizeRecipe(raw, source) {
  raw = raw || {};
  const title = str(raw.title, 100) || 'Rezept';
  let kcal = n0(raw.kcal); const protein = n0(raw.protein), carbs = n0(raw.carbs), fat = n0(raw.fat);
  // kcal mit den Makro-Gramm abgleichen (Atwater: 4/4/9). Die KI gibt manchmal
  // deutlich zu hohe kcal an, die nicht zu den Nährwerten passen. Wenn genug Makros
  // vorhanden sind und die kcal um >12 % abweichen (oder fehlen), rechnen wir die
  // kcal aus den Gramm-Werten neu, damit Anzeige und Nährwerte zusammenpassen.
  const atwater = Math.round(4 * protein + 4 * carbs + 9 * fat);
  if (atwater > 50 && (kcal <= 0 || Math.abs(kcal - atwater) > atwater * 0.12)) kcal = atwater;
  const servings = clampN(raw.servings, 1, 12, 1);
  const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : []).slice(0, 20).map(normIngredient).filter(Boolean);
  // Gewicht PRO PORTION: bevorzugt vom Rezept; sonst Summe der Gramm-Zutaten (fürs ganze
  // Rezept) geteilt durch die Portionen. Dient nur der Nutri-Score-Berechnung.
  let weightG = clampN(raw.weightG, 0, 5000, 0);
  if (!weightG) { const s = ingredients.reduce(function (a, it) { return a + (it.grams || 0); }, 0); if (s > 0) weightG = Math.round(s / servings); }
  const fruitVegPct = clampN(raw.fruitVegPct, 0, 100, 0);
  const fr = raw.finnRating || {};
  const rec = {
    id: str(raw.id, 60) || idFor(title),
    title: title,
    source: source || raw.source || 'ai',
    servings: servings,
    minutes: n0(raw.minutes),
    kcal: kcal, protein: protein, carbs: carbs, fat: fat,
    weightG: weightG, fruitVegPct: fruitVegPct,
    ingredients: ingredients,
    steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 12).map(function (x) { return str(x, 240); }).filter(Boolean),
    finnRating: { stars: clampN(fr.stars, 1, 5, 0), text: str(fr.text, 160) },
    // Fehlende Makros klar markiert (nicht still als korrekte 0 verkaufen).
    macrosComplete: kcal > 0 && (protein > 0 || carbs > 0 || fat > 0),
    createdAt: n0(raw.createdAt),
  };
  // Küchenutensilien: vom Rezept übernehmen, sonst grob ableiten (für den Koch-Modus).
  const uten = (Array.isArray(raw.utensils) ? raw.utensils : []).slice(0, 8).map(function (x) { return str(x, 40); }).filter(Boolean);
  rec.utensils = uten.length ? uten : deriveUtensils(rec);
  // Nutri-Score aus den Gesamt-Nährwerten einer Portion + Portionsgewicht.
  rec.nutri = weightG ? NS.scoreRecipe({ kcal: kcal, protein: protein, carbs: carbs, fat: fat }, weightG, fruitVegPct) : null;
  return rec;
}

// Rezept in die Bibliothek aufnehmen (dedupliziert über den Titel). Wirft nie.
// -> { added:Boolean, id, recipe? }
async function addToLibrary(raw, source) {
  if (!hasStore) return { added: false, id: null };
  const rec = normalizeRecipe(raw, source);
  const nt = normTitle(rec.title);
  if (!nt) return { added: false, id: null };
  try {
    // Atomar den Titel beanspruchen: HSETNX gibt 1 nur beim erstmaligen Setzen zurück.
    const claimed = await redisPipeline([['HSETNX', TITLES, nt, rec.id]]);
    if (Number(claimed[0]) !== 1) {
      const existing = await redisPipeline([['HGET', TITLES, nt]]);
      return { added: false, id: (existing && existing[0]) || null };
    }
    await redisPipeline([
      ['SET', RKEY(rec.id), JSON.stringify(rec)],
      ['LPUSH', IDX, rec.id],
      ['LTRIM', IDX, 0, CAP - 1],
    ]);
    return { added: true, id: rec.id, recipe: rec };
  } catch (e) { return { added: false, id: null }; }
}

// Mehrere Rezepte aufnehmen; gibt die kanonischen Rezepte zurück (neue + bereits vorhandene).
async function addMany(list, source) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const r = await addToLibrary(raw, source);
    if (r.recipe) out.push(r.recipe);
    else if (r.id) { const ex = await getById(r.id); if (ex) out.push(ex); else out.push(normalizeRecipe(raw, source)); }
    else out.push(normalizeRecipe(raw, source));
  }
  return out;
}

async function getById(id) {
  if (!hasStore || !id) return null;
  try { const r = await redisPipeline([['GET', RKEY(String(id))]]); return r && r[0] ? JSON.parse(r[0]) : null; }
  catch (e) { return null; }
}

// Bibliothek laden (neueste zuerst).
async function getLibrary(limit, offset) {
  if (!hasStore) return [];
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 40));
  try {
    const ids = await redisPipeline([['LRANGE', IDX, off, off + lim - 1]]);
    const list = Array.isArray(ids[0]) ? ids[0] : [];
    if (!list.length) return [];
    const vals = await redisPipeline(list.map(function (id) { return ['GET', RKEY(id)]; }));
    return vals.map(function (v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Titel/Zutaten durchsuchen (über die geladene Bibliothek).
async function searchLibrary(q, limit) {
  const term = String(q || '').toLowerCase().trim();
  const all = await getLibrary(100, 0);
  if (!term) return all.slice(0, limit || 40);
  return all.filter(function (r) {
    const hay = (r.title + ' ' + (r.ingredients || []).map(function (i) { return i.text; }).join(' ')).toLowerCase();
    return hay.indexOf(term) >= 0;
  }).slice(0, limit || 40);
}

// Startbestand einmalig übernehmen (idempotent via SETNX-Flag).
async function seedOnce(seeds) {
  if (!hasStore) return { seeded: false };
  try {
    const claim = await redisPipeline([['SETNX', SEEDED, '1']]);
    if (Number(claim[0]) !== 1) return { seeded: false, already: true };
    await addMany(seeds || [], 'seed');
    return { seeded: true, count: (seeds || []).length };
  } catch (e) { return { seeded: false, error: String(e && e.message) }; }
}

async function count() {
  if (!hasStore) return 0;
  try { const r = await redisPipeline([['LLEN', IDX]]); return Number(r[0]) || 0; }
  catch (e) { return 0; }
}

module.exports = {
  normalizeRecipe, normTitle, idFor,
  addToLibrary, addMany, getById, getLibrary, searchLibrary, seedOnce, count,
  CAP,
};
