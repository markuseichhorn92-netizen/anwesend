'use strict';

/**
 * /api/member/nutrition   (Authorization: Bearer <token>)
 * -------------------------------------------------------
 * Eigenständiges Ernährungs-Modul der Mitglieder-App. KEIN Fremdanbieter:
 * Tagesziel aus den eigenen Körperdaten (Mifflin-St-Jeor), Tracking per
 * Freitext + KI-Schätzung, KI-Rezepte, FINN als Ernährungscoach und ein
 * Verweis aufs Stoffwechsel-Coaching im Studio. Alle Daten liegen nur beim
 * Mitglied (Upstash KV), keine Weitergabe an Dritte.
 *
 *   GET  -> { ok, available, onboarded, profile, targets, today:{date,isToday,entries,totals,water,waterGoal}, streak, pointsToday }
 *
 * Erfassen (Punkt 1: KI schätzt NUR, gespeichert wird erst nach Bestätigung):
 *   POST { action:'estimate', text }            -> { ok, items:[…], meal, estimated } (kein Speichern!)
 *   POST { action:'estimate-photo', base64, mediaType } -> dito per Foto
 *   POST { action:'confirm-log', date?, items:[…] } -> speichert die BESTÄTIGTEN Werte
 *   POST { action:'log-manual', date?, name,portion?,kcal,p,c,f,meal? } (feste Werte, direkt)
 * Bearbeiten (Punkt 2, immer am validierten Tag):
 *   POST { action:'delete', id, date? }
 *   POST { action:'entry-update', id, date?, patch:{name,portion,amount,kcal,p,c,f,meal} }
 *   POST { action:'entry-duplicate', id, date?, toDate? }
 * Favoriten (Punkt 3): fav-list | fav-save{name,kcal,p,c,f,portion?} | fav-delete{id} | fav-log{id,date?,factor?,meal?}
 *   POST { action:'water', delta|set, date? }
 * Rezepte/Plan: recipes | recipes-get | recipe-save | recipe-delete | recipe-log{recipe,servings?,date?} | plan-generate | plan-get | shopping-toggle | shopping-clear
 *   POST { action:'coach', question, history? } -> FINN-Antwort (Punkt 4 Verlauf, Punkt 6 Schutzregeln)
 *   POST { action:'coaching-request' }          -> Inbox-Vorgang „Stoffwechsel-Coaching" + Studio-Mail
 * Datenschutz (Punkt 8): export | delete-day{date?} | delete-all{confirm:'LOESCHEN'}
 *
 * Sicherheit: jeder Wert wird serverseitig geprüft & gedeckelt (sanitizeEntry),
 * Datum validiert (validDate, keine Zukunft), Zugriff nur auf eigene Daten (Session-ID).
 * Ohne KV (hasStore=false) meldet GET available:false und die UI blendet das Modul aus.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const { redisPipeline, hasStore } = require('../../lib/store');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const Ent = require('../../lib/entitlements');
const MlPremium = require('../../lib/mlPremium');
const Coaching = require('../../lib/coaching');
const Stripe = require('../../lib/stripe');
const Recipes = require('../../lib/recipes');
const Quota = require('../../lib/nutriquota');
const Welcome = require('../../lib/welcomeGift');
const Social = require('../../lib/social');
const Figur = require('../../lib/figurcheck');

// Startbestand der studioweiten Rezept-Bibliothek (die 8 kuratierten Rezepte aus der App).
// weightG = ungefähres Gewicht EINER Portion (für Nutri-Score); fruitVegPct = Anteil Obst/Gemüse/
// Hülsenfrüchte/Nüsse. Wird einmalig übernommen (Recipes.seedOnce, idempotent).
const ERN_SEED = [
  { title: 'Rührei mit Tomaten', servings: 1, minutes: 15, kcal: 250, protein: 18, carbs: 4, fat: 18, weightG: 290, fruitVegPct: 40,
    ingredients: [{ name: 'Eier', grams: 165 }, { name: 'Tomate', grams: 120 }, { name: 'Olivenöl', grams: 5 }, { name: 'Salz, Pfeffer, Schnittlauch', grams: 2 }],
    steps: ['Eier verquirlen und würzen.', 'Tomate würfeln und kurz anbraten.', 'Eier zugeben und sanft stocken lassen.'] },
  { title: 'Haferbrei mit Beeren', servings: 1, minutes: 10, kcal: 330, protein: 12, carbs: 52, fat: 7, weightG: 315, fruitVegPct: 19,
    ingredients: [{ name: 'Haferflocken', grams: 50 }, { name: 'Milch', grams: 200 }, { name: 'Beeren', grams: 60 }, { name: 'Honig', grams: 7 }],
    steps: ['Haferflocken mit Milch aufkochen.', '2–3 Min köcheln, dabei rühren.', 'Mit Beeren und Honig toppen.'] },
  { title: 'Magerquark mit Beeren', servings: 1, minutes: 5, kcal: 210, protein: 27, carbs: 20, fat: 1, weightG: 340, fruitVegPct: 17,
    ingredients: [{ name: 'Magerquark', grams: 250 }, { name: 'Milch oder Wasser', grams: 30 }, { name: 'Beeren', grams: 60 }, { name: 'Honig (optional)', grams: 7 }],
    steps: ['Quark mit etwas Milch cremig rühren.', 'Beeren untermischen.', 'Nach Wunsch leicht süßen.'] },
  { title: 'Hähnchen mit Reis & Gemüse', servings: 1, minutes: 25, kcal: 520, protein: 45, carbs: 55, fat: 12, weightG: 470, fruitVegPct: 32,
    ingredients: [{ name: 'Hähnchenbrust', grams: 150 }, { name: 'Reis (roh)', grams: 60 }, { name: 'Gemüse (Brokkoli, Paprika)', grams: 150 }, { name: 'Öl', grams: 5 }],
    steps: ['Reis nach Packung kochen.', 'Hähnchen würzen und anbraten.', 'Gemüse dünsten, alles anrichten.'] },
  { title: 'Ofen-Lachs mit Gemüse', servings: 1, minutes: 30, kcal: 470, protein: 38, carbs: 18, fat: 27, weightG: 360, fruitVegPct: 54,
    ingredients: [{ name: 'Lachsfilet', grams: 150 }, { name: 'Ofengemüse (Zucchini, Paprika)', grams: 200 }, { name: 'Olivenöl', grams: 12 }, { name: 'Zitrone, Kräuter', grams: 5 }],
    steps: ['Ofen auf 200 °C vorheizen.', 'Gemüse mit Öl auf ein Blech geben.', 'Lachs dazulegen, 18–20 Min backen.'] },
  { title: 'Rote Linsensuppe', servings: 1, minutes: 30, kcal: 340, protein: 18, carbs: 45, fat: 8, weightG: 450, fruitVegPct: 45,
    ingredients: [{ name: 'Rote Linsen', grams: 80 }, { name: 'Karotte', grams: 70 }, { name: 'Zwiebel', grams: 50 }, { name: 'Gemüsebrühe', grams: 400 }],
    steps: ['Zwiebel und Karotte anschwitzen.', 'Linsen und Brühe zugeben.', '15–18 Min köcheln, dann pürieren.'] },
  { title: 'Thunfisch-Salat mit Mais', servings: 1, minutes: 10, kcal: 300, protein: 28, carbs: 22, fat: 11, weightG: 390, fruitVegPct: 60,
    ingredients: [{ name: 'Thunfisch (im eigenen Saft)', grams: 120 }, { name: 'Mais', grams: 100 }, { name: 'Salat, Gurke, Tomate', grams: 150 }, { name: 'Joghurt-Dressing', grams: 20 }],
    steps: ['Thunfisch abtropfen lassen.', 'Gemüse und Mais mischen.', 'Mit Dressing anmachen.'] },
  { title: 'Protein-Pancakes', servings: 1, minutes: 15, kcal: 340, protein: 26, carbs: 34, fat: 10, weightG: 270, fruitVegPct: 40,
    ingredients: [{ name: 'Banane', grams: 120 }, { name: 'Eier', grams: 110 }, { name: 'Haferflocken', grams: 40 }, { name: 'Proteinpulver (optional)', grams: 30 }],
    steps: ['Alle Zutaten pürieren.', 'Kleine Pancakes bei mittlerer Hitze backen.', 'Mit Beeren servieren.'] },
];
// Startbestand einmalig übernehmen; pro Cold-Start nur EINE Anfrage (Recipes.seedOnce ist
// zusätzlich via SETNX-Flag idempotent). Wirft nie.
let _seedPromise = null;
function ensureSeed() { if (!_seedPromise) _seedPromise = Recipes.seedOnce(ERN_SEED).catch(function () { return {}; }); return _seedPromise; }

// Freemium: KI-Funktionen sind Premium. Freundliche Meldung fürs Upgrade.
const PREMIUM_MSG = 'Das ist eine Premium-Funktion (KI). Teste Premium 7 Tage gratis – danach jederzeit kündbar.';
// Basic-Gratis-Kontingent für diesen Monat ist aufgebraucht.
const QUOTA_MSG = 'Dein Gratis-Kontingent für FINN ist diesen Monat aufgebraucht. Mit Premium nutzt du FINN unbegrenzt – 7 Tage gratis testen.';

const PKEY = (id) => 'nutri:p:' + String(id);
const DKEY = (id, d) => 'nutri:d:' + String(id) + ':' + d;
const FASTKEY = (id) => 'nutri:fast:' + String(id);
const PLANKEY = (id) => 'nutri:plan:' + String(id);
const SHOPKEY = (id) => 'nutri:shop:' + String(id);
const RECKEY = (id) => 'nutri:rec:' + String(id);
const FAVKEY = (id) => 'nutri:fav:' + String(id);
const COOKKEY = (id) => 'nutri:cook:' + String(id);   // Koch-Plan (was wann kochen) + Einkaufsliste
const DAY_TTL = 400 * 86400;              // ~13 Monate

const FAST_PLANS = { '16:8': 16, '18:6': 18, '14:10': 14 };

const GOALS = { abnehmen: 'Abnehmen', definieren: 'Definieren', halten: 'Gewicht halten', aufbau: 'Muskelaufbau', gesundheit: 'Gesundheit', longevity: 'Longevity' };
// Ziel -> Kalorien-Archetyp + Eiweiß (g/kg). Die Ziele unterscheiden sich v. a. im
// Coaching-Content; die Rechnung bleibt bewusst moderat & sicher (nie unter Grundumsatz).
// Bestehende Ziele (abnehmen/halten/aufbau) behalten exakt ihre bisherigen Werte.
const GOAL_MODEL = {
  abnehmen:   { kind: 'deficit',  pct: 0.18, cap: 500, protein: 1.6 },
  definieren: { kind: 'deficit',  pct: 0.15, cap: 450, protein: 1.9 },
  halten:     { kind: 'maintain',                      protein: 1.6 },
  gesundheit: { kind: 'maintain',                      protein: 1.5 },
  longevity:  { kind: 'maintain',                      protein: 1.4 },
  aufbau:     { kind: 'surplus',  pct: 0.12, cap: 400, protein: 1.8 },
};
const ACTS = { kaum: 1.35, moderat: 1.55, aktiv: 1.75 };
const DIETS = ['omnivor', 'vegetarisch', 'vegan', 'lowcarb', 'highprotein'];

function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }
function clamp(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }

const MEALS = ['fruehstueck', 'mittag', 'abend', 'snack'];
const MAX_ITEMS_PER_CONFIRM = 12;   // pro Bestätigung höchstens so viele Einträge
const MAX_FAVS = 60;

function cleanStr(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// Datum + Stunde in Studio-Zeit (Europe/Berlin), DST-sicher.
function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: parseInt(get('hour'), 10) || 0 };
}
function mealForHour(h) { return h < 11 ? 'fruehstueck' : (h < 15 ? 'mittag' : (h < 21 ? 'abend' : 'snack')); }
function dayKeyMinus(baseYMD, i) { const d = new Date(baseYMD + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - i); return d.toISOString().slice(0, 10); }
function validMeal(m, hour) { return MEALS.indexOf(String(m || '')) >= 0 ? String(m) : mealForHour(hour); }

// Validiertes Tages-Datum (YYYY-MM-DD): keine Zukunft, max ~400 Tage zurück, echtes
// Kalenderdatum. Ungültig/leer -> heute. NIE ein Client-Datum ungeprüft übernehmen.
function validDate(input, todayYMD) {
  const s = String(input || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return todayYMD;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return todayYMD;
  if (s > todayYMD) return todayYMD;
  const min = dayKeyMinus(todayYMD, 400);
  return s < min ? min : s;
}

// Wie validDate, aber für den KOCH-PLAN: Zukunft ist erlaubt (man plant voraus),
// gedeckelt auf 7 Tage zurück bis 21 Tage voraus. So landen Mehrtagespläne am
// richtigen Tag statt alle auf „heute".
function validPlanDate(input, todayYMD) {
  const s = String(input || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return todayYMD;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return todayYMD;
  const min = dayKeyMinus(todayYMD, 7);
  const max = dayKeyMinus(todayYMD, -21);
  if (s < min) return min;
  if (s > max) return max;
  return s;
}

// Ein Ernährungs-Eintrag aus (ggf. ungeprüften) Clientdaten – auf realistische
// Grenzen begrenzt. Immer serverseitig verwenden, bevor gespeichert wird.
function sanitizeEntry(raw, hour, keepId) {
  raw = raw || {};
  const e = {
    id: (keepId && cleanStr(raw.id, 24)) || newEntryId(),
    name: cleanStr(raw.name, 80) || 'Mahlzeit',
    portion: cleanStr(raw.portion, 40),
    kcal: clamp(raw.kcal, 0, 5000, 0),
    p: clamp(raw.p, 0, 500, 0),
    c: clamp(raw.c, 0, 700, 0),
    f: clamp(raw.f, 0, 500, 0),
    meal: validMeal(raw.meal, hour),
    ts: Date.now(),
  };
  const amount = cleanStr(raw.amount, 24);
  if (amount) e.amount = amount;
  if (raw.estimated) e.estimated = true;
  // Quellen-Metadaten (Punkt: korrekte Herkunft im Protokolleintrag).
  const SOURCES = ['ai', 'openfoodfacts', 'manual', 'favorite', 'recipe'];
  if (SOURCES.indexOf(String(raw.source)) >= 0) e.source = String(raw.source);
  const bc = String(raw.barcode || '').replace(/\D/g, '');
  if (bc.length >= 8 && bc.length <= 14) e.barcode = bc;
  return e;
}

// ── Zielwerte (Mifflin-St-Jeor + Aktivitätsfaktor + Ziel-Offset) ──
// WICHTIG (Sicherheit): moderate, gedeckelte Offsets; Kalorien nie deutlich unter
// den Grundumsatz; Eiweiß absolut begrenzt (kein 500-g-Ziel bei hohem Gewicht);
// für unter 18-Jährige KEINE automatische Abnehm-Empfehlung. Dieselbe Logik spiegelt
// der Client in ernTargets() – Abweichungen wären ein Fehler.
function targetsFor(p) {
  p = p || {};
  const sex = p.sex === 'm' ? 'm' : 'w';
  const weight = clamp(p.weight, 35, 250, 70);
  const height = clamp(p.height, 120, 230, 170);
  const age = clamp(p.age, 14, 100, 30);
  const under18 = age < 18;
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'm' ? 5 : -161);
  const factor = ACTS[p.activity] || 1.55;
  const tdee = bmr * factor;
  // Minderjährige nicht automatisch ins Defizit setzen -> als „halten" rechnen.
  let goal = GOALS[p.goal] ? p.goal : 'halten';
  let model = GOAL_MODEL[goal] || GOAL_MODEL.halten;
  if (under18 && model.kind === 'deficit') { goal = 'halten'; model = GOAL_MODEL.halten; }
  let kcal = tdee;
  if (model.kind === 'deficit') kcal = tdee - Math.min(model.cap, tdee * model.pct);       // moderates Defizit, gedeckelt
  else if (model.kind === 'surplus') kcal = tdee + Math.min(model.cap, tdee * model.pct);
  // Untergrenze: geschlechtsabhängiges Minimum UND nie unter den Grundumsatz.
  const floor = Math.max(sex === 'm' ? 1500 : 1200, Math.round(bmr));
  kcal = Math.max(floor, Math.round(kcal / 10) * 10);
  // Eiweiß: sinnvolle g/kg, absolut auf 200 g gedeckelt, Untergrenze 40 g.
  const gPerKg = model.protein;
  const protein = Math.max(40, Math.min(200, Math.round(gPerKg * weight)));
  const fat = Math.max(30, Math.min(150, Math.round(0.9 * weight)));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const water = Math.max(1.5, Math.min(4, Math.round(weight * 0.035 * 10) / 10));
  const note = under18
    ? 'Für unter 18-Jährige zeigen wir nur allgemeine Richtwerte – für individuelle Ziele bitte persönliche Beratung im Studio.'
    : '';
  return { kcal, protein, carbs, fat, water, note, under18 };
}

// ── KV-Helfer ──
async function kvGetJson(key) {
  try { const [r] = await redisPipeline([['GET', key]]); if (!r) return null; return JSON.parse(r); } catch (e) { return null; }
}
async function kvGetMany(keys) {
  if (!keys.length) return [];
  try { return await redisPipeline([['MGET', ...keys]]).then((r) => r[0] || []); } catch (e) { return keys.map(() => null); }
}
async function loadProfile(id) { return kvGetJson(PKEY(id)); }
async function loadDay(id, date) {
  const d = await kvGetJson(DKEY(id, date));
  if (d && Array.isArray(d.entries)) return { entries: d.entries, water: n0(d.water) };
  return { entries: [], water: 0 };
}
async function saveDay(id, date, day) {
  try { await redisPipeline([['SET', DKEY(id, date), JSON.stringify({ entries: day.entries.slice(-60), water: n0(day.water) }), 'EX', String(DAY_TTL)]]); return true; } catch (e) { return false; }
}
// ── Koch-Plan (was wann kochen) + abgeleitete Einkaufsliste ──
async function loadCook(id) {
  const c = await kvGetJson(COOKKEY(id));
  return { items: (c && Array.isArray(c.items)) ? c.items : [], checked: (c && c.checked) || {} };
}
async function saveCook(id, cook) {
  try { await redisPipeline([['SET', COOKKEY(id), JSON.stringify({ items: (cook.items || []).slice(0, 60), checked: cook.checked || {} })]]); return true; } catch (e) { return false; }
}
// Einkaufsliste aus den noch NICHT gekochten Plan-Einträgen aggregieren: Gramm je Zutat
// summieren (skaliert auf die geplanten Portionen), abgehakter Zustand bleibt erhalten.
function buildShopping(cook) {
  const agg = {};
  (cook.items || []).forEach(function (it) {
    if (it.done) return;
    const factor = (it.servings && it.baseServings) ? (it.servings / it.baseServings) : 1;
    (it.ingredients || []).forEach(function (ing) {
      const name = String(ing.text || ing.name || '').replace(/^\d+(?:[.,]\d+)?\s*g\s+/i, '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!agg[key]) agg[key] = { name: name, grams: 0, key: key };
      agg[key].grams += Math.round((Number(ing.grams) || 0) * factor);
    });
  });
  const checked = cook.checked || {};
  return Object.keys(agg).map(function (k) {
    const a = agg[k];
    return { key: a.key, name: a.name, amount: a.grams > 0 ? (a.grams + ' g') : 'nach Bedarf', checked: !!checked[a.key] };
  }).sort(function (a, b) { return (a.checked === b.checked) ? a.name.localeCompare(b.name) : (a.checked ? 1 : -1); });
}

function totalsOf(entries) {
  return (entries || []).reduce(function (t, e) { return { kcal: t.kcal + n0(e.kcal), p: t.p + n0(e.p), c: t.c + n0(e.c), f: t.f + n0(e.f) }; }, { kcal: 0, p: 0, c: 0, f: 0 });
}
function waterGoalCups(t) { return Math.max(6, Math.round(((t && t.water) || 2) / 0.25)); }

// Zusammenhängende Tage mit mindestens einem Eintrag (endet heute oder gestern).
// Vitalpunkte eines EINZELNEN Tages (0–60): protokolliert + Eiweißziel + Kalorienfenster.
// Bewusst OHNE Streak-Term – die Serie wird separat als 🔥-Wert geführt. Diese Punkte
// fließen (aufsummiert über das Fenster) in die globale Vitalpunkte-/Rang-Anzeige ein und
// verknüpfen so das Ernährungs-Tracking mit dem Fortschritt.
function dayVitalPoints(totals, targets, entryCount) {
  let p = 0;
  if (entryCount > 0) p += 20;                                    // heute protokolliert
  if (targets && totals.p >= targets.protein * 0.9) p += 20;      // Eiweißziel (fast) erreicht
  if (targets && totals.kcal >= targets.kcal * 0.85 && totals.kcal <= targets.kcal * 1.1) p += 20; // im Kalorienfenster
  return p;
}
// Streak + kumulierte Vitalpunkte aus EINEM Redis-Read (60-Tage-Fenster).
// -> { streak, vitalPoints, ledger:[{date,pts}] }. Der Ledger speist den Punkte-Verlauf.
async function computeVitals(id, todayDate, targets) {
  const N = 60;
  const keys = []; for (let i = 0; i < N; i++) keys.push(DKEY(id, dayKeyMinus(todayDate, i)));
  const vals = await kvGetMany(keys);
  const days = vals.map(function (v) { try { const o = JSON.parse(v); return (o && Array.isArray(o.entries)) ? o.entries : null; } catch (e) { return null; } });
  const tracked = days.map(function (e) { return !!(e && e.length); });
  // Streak: zusammenhängende getrackte Tage ab heute (heute noch leer -> ab gestern zählen).
  let si = tracked[0] ? 0 : 1, streak = 0;
  if (!(si === 1 && !tracked[1])) { while (tracked[si]) { streak++; si++; } }
  // Vitalpunkte: Summe der Tagespunkte über das Fenster + Verlauf (jüngste zuerst).
  let vitalPoints = 0; const ledger = [];
  for (let i = 0; i < N; i++) {
    if (!tracked[i]) continue;
    const pts = dayVitalPoints(totalsOf(days[i]), targets, days[i].length);
    if (pts <= 0) continue;
    vitalPoints += pts;
    ledger.push({ date: dayKeyMinus(todayDate, i), pts: pts });
  }
  return { streak: streak, vitalPoints: vitalPoints, ledger: ledger };
}

// Fasten-Status: { plan, start(ms|null), active }.
async function loadFasting(id) {
  const f = await kvGetJson(FASTKEY(id));
  const plan = f && FAST_PLANS[f.plan] ? f.plan : '16:8';
  const start = f && typeof f.start === 'number' && f.start > 0 ? f.start : null;
  return { plan: plan, start: start, active: !!start };
}

// ── Antwortobjekt für GET / nach jeder Mutation ──
// forDate (optional, bereits validiert): zeigt den Block „today" für DIESEN Tag –
// so kann der Client auch nachgetragene/vergangene Tage korrekt neu rendern. Der
// Streak bezieht sich immer auf den echten heutigen Tag.
async function buildState(id, profile, forDate) {
  const todayYMD = berlinNow().date;
  const date = (forDate && /^\d{4}-\d{2}-\d{2}$/.test(forDate)) ? forDate : todayYMD;
  const onboarded = !!(profile && profile.onboarded);
  const targets = targetsFor(profile || {});
  const day = await loadDay(id, date);
  const totals = totalsOf(day.entries);
  const vit = await computeVitals(id, todayYMD, targets);
  const fasting = await loadFasting(id);
  // Premium über das Magicline-Zusatzmodul (SEPA) mit dem Entitlement abgleichen –
  // gecacht (30 min), 403-/Fehler-sicher, nur aktiv bei gesetztem ML_PREMIUM_MODULE_ID.
  try { await MlPremium.reconcile(id); } catch (e) {}
  const tier = Ent.publicTier(await Ent.getEntitlement(id));   // Premium-Status für die UI (Freemium)
  // Gratis-Kontingent (Basic) für den aktuellen Monat – die UI zeigt „Noch X von 5".
  // Verbrauch wird für alle gezählt (auch Premium), damit die Nutzungsübersicht stimmt.
  const qMonth = Quota.monthOf(todayYMD);
  const qUsed = await Quota.getUsed(id, qMonth);
  // Preis/Trial dynamisch (aus Stripe, gecacht) – die UI zeigt es statt hartcodierter Copy.
  let priceInfo = null; try { priceInfo = await Stripe.getPriceInfo(); } catch (e) {}
  return {
    ok: true, available: true, onboarded: onboarded,
    profile: profile ? { goal: profile.goal, sex: profile.sex, height: profile.height, weight: profile.weight, age: profile.age, activity: profile.activity, diet: profile.diet } : null,
    targets: targets,
    today: { date, isToday: date === todayYMD, entries: day.entries, totals, water: day.water, waterGoal: waterGoalCups(targets) },
    streak: vit.streak,
    pointsToday: dayVitalPoints(totals, targets, day.entries.length),
    vitalPoints: vit.vitalPoints, vitalLedger: vit.ledger,
    fasting: fasting,
    premium: tier.premium, tier: tier.tier, trialing: tier.trialing, premiumUntil: tier.until,
    premiumEver: tier.everPremium || false, trialEligible: tier.trialEligible !== false && !tier.everPremium,
    premiumTrialEnd: tier.trialEnd || null,
    premiumCancelAt: tier.cancelAtPeriodEnd || false,
    premiumComp: tier.comp || false, premiumPermanent: tier.permanent || false,
    premiumSource: tier.source || null, premiumViaModule: !!tier.viaModule,
    premiumModuleId: MlPremium.configured() ? require('../../lib/mlModules').PREMIUM_MODULE_ID : null,
    premiumInfo: { price: priceInfo, trialDays: Stripe.TRIAL_DAYS, pk: Stripe.PUBLISHABLE || '' },
    quota: Quota.publicQuota(qUsed, tier.premium, qMonth),
  };
}

function newEntryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Punkt 6: deterministische Schutzprüfung für den Ernährungscoach ──
// Erkennt Hinweise auf Krise/Selbstverletzung, Essstörung, Erbrechen/Kompensation
// oder gefährliche Extrem-Restriktion. Trifft eine Regel zu, antwortet FINN NICHT
// frei (KI wird übersprungen), sondern empathisch mit Verweis auf echte Hilfe.
// Nutzertext kann diese Regeln nicht überschreiben.
function safetyResponse(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const CRISIS = /(suizid|selbstmord|umbringen|nicht mehr leben|ritzen|selbstverletz)/;
  const ED = /(erbrech|(ü|ue)bergeb|kotz|brechen nach|magersucht|anorex|bulim|essst(ö|oe)rung|ess ?st(ö|oe)rung|tagelang nicht|abf(ü|ue)hrmittel|appetitz(ü|ue)gler|nur wasser trink|wochenlang fasten|nichts mehr ess|gar nichts ess)/;
  const EXTREME = /(unter 800 kcal|nur \d{2,3} kcal|500 kcal am tag|so wenig wie m(ö|oe)glich ess|komplett aufh(ö|oe)ren zu essen|gar nicht mehr ess)/;
  if (CRISIS.test(t)) {
    return 'Es tut mir leid, dass es dir gerade so geht – damit solltest du nicht allein bleiben. Bitte sprich mit einem Menschen, dem du vertraust, oder hol dir Hilfe: Telefonseelsorge 0800 111 0 111 (kostenlos, rund um die Uhr). In einem Notfall wähle 112. Auch unser Team im Studio ist für dich da.';
  }
  if (ED.test(t) || EXTREME.test(t)) {
    return 'Danke, dass du das ansprichst – das nehme ich ernst. Sehr niedrige Kalorien, Hungern oder Erbrechen können deiner Gesundheit ernsthaft schaden; dabei kann und darf ich dich nicht anleiten. Bitte hol dir echte Unterstützung – z. B. bei deiner Hausärztin/deinem Hausarzt oder beim kostenlosen BZgA-Beratungstelefon Essstörungen: 0221 892031. Unser Team im Studio hilft dir gern, einen gesunden, alltagstauglichen Weg zu finden. 💚';
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false })); }
  const id = sess.id;

  // ── GET: aktueller Stand ──
  if (req.method === 'GET') {
    const profile = await loadProfile(id);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile)));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const action = String(body.action || '');
  const { date, hour } = berlinNow();

  // ── Profil speichern (Onboarding / Neuberechnung) ──
  if (action === 'save-profile') {
    const inp = body.profile || {};
    const profile = {
      onboarded: true,
      goal: GOALS[inp.goal] ? inp.goal : 'halten',
      sex: inp.sex === 'm' ? 'm' : 'w',
      height: clamp(inp.height, 120, 230, 170),
      weight: clamp(inp.weight, 35, 250, 70),
      age: clamp(inp.age, 14, 100, 30),
      activity: ACTS[inp.activity] ? inp.activity : 'moderat',
      diet: DIETS.indexOf(inp.diet) >= 0 ? inp.diet : 'omnivor',
      updatedAt: Date.now(),
    };
    // DSGVO-Einwilligung (Gesundheitsdaten, Art. 9) als Nachweis mit Zeitstempel festhalten;
    // eine bereits erteilte Einwilligung bleibt erhalten.
    try { const prev = await loadProfile(id); profile.consentAt = body.consent ? Date.now() : ((prev && prev.consentAt) || null); } catch (e) {}
    try { await redisPipeline([['SET', PKEY(id), JSON.stringify(profile)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile)));
  }

  const profile = await loadProfile(id);
  // Freemium-Gate: KI-Funktionen kosten. Basic hat pro Monat ein Gratis-Kontingent
  // (lib/nutriquota), danach greift Premium. Premium = unbegrenzt. Alles serverseitig.
  const premium = Ent.isPremium(await Ent.getEntitlement(id));
  const monthKey = Quota.monthOf(date);
  const denyPremium = function () { res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: 'premium_required', message: PREMIUM_MSG })); return true; };
  // Vor einer KI-Aktion: Premium darf immer; Basic nur, solange Kontingent übrig ist
  // (verbraucht NICHT – Abbuchung erst nach Erfolg via chargeAI). Sonst 402-artige Meldung.
  const gateAI = async function () {
    if (premium) return true;
    if (await Quota.canUse(id, monthKey)) return true;
    res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: 'premium_required', quota: 'exhausted', message: QUOTA_MSG }));
    return false;
  };
  // Nach erfolgreicher KI-Aktion den Monatszähler erhöhen – für ALLE (auch Premium, damit die
  // Nutzungsübersicht stimmt). Gedeckelt/gesperrt wird aber nur Basic (siehe gateAI). Gibt die
  // aktuelle, client-sichere Kontingent-Info zurück (für „Noch X"-Badge + Nutzungsübersicht).
  const chargeAI = async function () {
    const used = await Quota.incr(id, monthKey);
    return Quota.publicQuota(used, premium, monthKey);
  };

  // ── Punkt 1: KI-SCHÄTZUNG per Freitext – wird NICHT gespeichert, nur zur Bestätigung ──
  if (action === 'estimate' || action === 'log') {
    if (!(await gateAI())) return;
    const text = cleanStr(body.text, 500);
    if (text.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty', message: 'Bitte beschreibe kurz, was du gegessen hast.' })); }
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-log:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const est = await AI.estimateFood(text);
    if (!est.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'ai_failed', message: 'FINN kann gerade nicht schätzen. Versuch es gleich nochmal.' })); }
    const quota = await chargeAI();
    const meal = mealForHour(hour);
    const items = (est.items || []).map(function (it) { return sanitizeEntry({ name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, estimated: true }, hour); });
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, items: items, meal: meal, estimated: true, quota: quota, message: items.length ? '' : 'Ich konnte kein Lebensmittel erkennen – beschreib es etwas genauer.' }));
  }

  // ── Punkt 1: KI-SCHÄTZUNG per FOTO – wird NICHT gespeichert, nur zur Bestätigung ──
  if (action === 'estimate-photo' || action === 'log-photo') {
    if (!(await gateAI())) return;
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-photo:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const b64 = String(body.base64 || '');
    if (b64.length < 100 || b64.length > 8000000) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_photo', message: 'Kein gültiges Foto empfangen.' })); }
    const est = await AI.estimateFoodPhoto(b64, body.mediaType);
    if (!est.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'ai_failed', message: 'FINN kann das Foto gerade nicht auswerten. Versuch es gleich nochmal.' })); }
    const quota = await chargeAI();
    const meal = mealForHour(hour);
    const items = (est.items || []).map(function (it) { return sanitizeEntry({ name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, estimated: true }, hour); });
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, items: items, meal: meal, estimated: true, quota: quota, message: items.length ? '' : 'Auf dem Foto konnte ich kein Lebensmittel erkennen – versuch es mit einer Texteingabe.' }));
  }

  // ── Punkt 1: bestätigte Mahlzeit SPEICHERN (jeder Wert serverseitig geprüft & gedeckelt) ──
  if (action === 'confirm-log') {
    const targetDate = validDate(body.date, date);
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PER_CONFIRM) : [];
    const items = rawItems.map(function (it) { return sanitizeEntry(it, hour); })
      .filter(function (it) { return it.kcal > 0 || it.p > 0 || it.c > 0 || it.f > 0; });
    if (!items.length) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: [], message: 'Keine gültigen Einträge zum Speichern.' }))); }
    const day = await loadDay(id, targetDate);
    day.entries = day.entries.concat(items);
    await saveDay(id, targetDate, day);
    try { require('../../lib/handled').record('ai', id, 'nutri'); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: items.map(function (a) { return { name: a.name, kcal: a.kcal }; }) })));
  }

  // ── Schnell-Eintrag mit festen Werten (Favorit/Manuell) – direkt gespeichert, Werte geprüft ──
  if (action === 'log-manual') {
    if (!(await M.rateLimit('nutri-log:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile))); }
    const targetDate = validDate(body.date, date);
    const entry = sanitizeEntry({ name: body.name || 'Snack', portion: body.portion, amount: body.amount, kcal: body.kcal, p: body.p, c: body.c, f: body.f, meal: body.meal }, hour);
    const day = await loadDay(id, targetDate);
    day.entries.push(entry);
    await saveDay(id, targetDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: [{ name: entry.name, kcal: entry.kcal }] })));
  }

  // ── Punkt 2: Eintrag löschen (am RICHTIGEN, validierten Tag) ──
  if (action === 'delete') {
    const targetDate = validDate(body.date, date);
    const eid = cleanStr(body.id, 24);
    const day = await loadDay(id, targetDate);
    day.entries = day.entries.filter(function (e) { return String(e.id) !== eid; });
    await saveDay(id, targetDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile, targetDate)));
  }

  // ── Punkt 2: bestehenden Eintrag bearbeiten (Portion, Nährwerte, Mahlzeit) ──
  if (action === 'entry-update') {
    const targetDate = validDate(body.date, date);
    const eid = cleanStr(body.id, 24);
    const patch = body.patch || {};
    const day = await loadDay(id, targetDate);
    let found = false;
    day.entries = day.entries.map(function (e) {
      if (String(e.id) !== eid) return e;
      found = true;
      const merged = sanitizeEntry({
        id: e.id, name: patch.name != null ? patch.name : e.name, portion: patch.portion != null ? patch.portion : e.portion,
        amount: patch.amount != null ? patch.amount : e.amount, kcal: patch.kcal != null ? patch.kcal : e.kcal,
        p: patch.p != null ? patch.p : e.p, c: patch.c != null ? patch.c : e.c, f: patch.f != null ? patch.f : e.f,
        meal: patch.meal != null ? patch.meal : e.meal,
      }, hour, true);
      merged.ts = e.ts || merged.ts;
      return merged;
    });
    if (found) await saveDay(id, targetDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { updated: found })));
  }

  // ── Punkt 2: Eintrag duplizieren (in denselben oder – validiert – einen anderen Tag) ──
  if (action === 'entry-duplicate') {
    const fromDate = validDate(body.date, date);
    const toDate = validDate(body.toDate || body.date, date);
    const eid = cleanStr(body.id, 24);
    const src = await loadDay(id, fromDate);
    const orig = src.entries.filter(function (e) { return String(e.id) === eid; })[0];
    if (!orig) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, toDate), { added: [] }))); }
    const copy = sanitizeEntry(orig, hour);   // frische id, geprüfte Werte
    const day = fromDate === toDate ? src : await loadDay(id, toDate);
    day.entries.push(copy);
    await saveDay(id, toDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, toDate), { added: [{ name: copy.name, kcal: copy.kcal }] })));
  }

  // ── Wasser (Gläser à 0,25 l) – am validierten Tag ──
  if (action === 'water') {
    const targetDate = validDate(body.date, date);
    const day = await loadDay(id, targetDate);
    const goal = waterGoalCups(targetsFor(profile || {}));
    let cups = day.water;
    if (body.set != null) cups = n0(body.set);
    else cups = (day.water || 0) + clamp(body.delta, -20, 20, 0);
    const nextWater = Math.max(0, Math.min(goal + 4, cups));
    // Lost-Update vermeiden: unmittelbar vor dem Schreiben die aktuellsten entries neu laden
    // und nur das Wasser übernehmen. So löscht ein Wasser-Tap kein gerade parallel geloggtes
    // Lebensmittel (der Tages-Datensatz enthält entries + water in einem Objekt).
    const fresh = await loadDay(id, targetDate);
    fresh.water = nextWater;
    await saveDay(id, targetDate, fresh);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile, targetDate)));
  }

  // ── Punkt 2: Nur-Lesen-Stand für einen (validierten) Tag – für Tages-Navigation/Nachtragen ──
  if (action === 'state') {
    const targetDate = validDate(body.date, date);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile, targetDate)));
  }

  // ── Punkt 3: Favoriten (pro Mitglied in KV) ──
  if (action === 'fav-list') {
    const saved = await kvGetJson(FAVKEY(id));
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, favorites: Array.isArray(saved) ? saved : [] }));
  }
  if (action === 'fav-save') {
    const f = sanitizeEntry({ name: body.name, portion: body.portion, kcal: body.kcal, p: body.p, c: body.c, f: body.f }, hour);
    const fav = { id: f.id, name: f.name, portion: f.portion, kcal: f.kcal, p: f.p, c: f.c, f: f.f };
    if (!(fav.kcal > 0 || fav.p > 0 || fav.c > 0 || fav.f > 0)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty', message: 'Bitte gib zumindest Kalorien oder Makros an.' })); }
    const saved = await kvGetJson(FAVKEY(id)); const list = Array.isArray(saved) ? saved : [];
    const dupe = list.some(function (x) { return String(x.name).toLowerCase() === fav.name.toLowerCase() && n0(x.kcal) === fav.kcal; });
    if (!dupe) list.unshift(fav);
    const trimmed = list.slice(0, MAX_FAVS);
    try { await redisPipeline([['SET', FAVKEY(id), JSON.stringify(trimmed)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, favorites: trimmed, saved: !dupe }));
  }
  if (action === 'fav-delete') {
    const fid = cleanStr(body.id, 24);
    const saved = await kvGetJson(FAVKEY(id)); let list = Array.isArray(saved) ? saved : [];
    list = list.filter(function (x) { return String(x.id) !== fid; });
    try { await redisPipeline([['SET', FAVKEY(id), JSON.stringify(list)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, favorites: list }));
  }
  if (action === 'fav-log') {
    const targetDate = validDate(body.date, date);
    const fid = cleanStr(body.id, 24);
    const saved = await kvGetJson(FAVKEY(id)); const list = Array.isArray(saved) ? saved : [];
    const fav = list.filter(function (x) { return String(x.id) === fid; })[0];
    if (!fav) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: [] }))); }
    // Menge anpassbar: Faktor 0,25–10 (z. B. halbe/doppelte Portion).
    const factor = Math.max(0.25, Math.min(10, Number(body.factor) || 1));
    const entry = sanitizeEntry({
      name: fav.name, portion: fav.portion, meal: body.meal,
      kcal: Math.round(n0(fav.kcal) * factor), p: Math.round(n0(fav.p) * factor), c: Math.round(n0(fav.c) * factor), f: Math.round(n0(fav.f) * factor),
    }, hour);
    const day = await loadDay(id, targetDate); day.entries.push(entry); await saveDay(id, targetDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: [{ name: entry.name, kcal: entry.kcal }] })));
  }

  // ── FINN generiert Rezepte -> in die studioweite Bibliothek + Nutri-Score ──
  if (action === 'recipes') {
    // „Erster Plan aufs Haus": der erste FINN-Wochenplan ist gratis. Nur PRÜFEN – eingelöst
    // wird erst nach erfolgreicher Generierung (fehlgeschlagener Versuch verbraucht nichts).
    const welcomeFree = !!body.welcome && (await Welcome.available(id, 'ern'));
    if (!welcomeFree) { if (!(await gateAI())) return; }
    await ensureSeed();   // Startbestand einmalig übernehmen (idempotent)
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN ist gerade nicht verfügbar – schau in der Rezept-Bibliothek vorbei.' })); }
    if (!(await M.rateLimit('nutri-recipes:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    const fridge = String(body.fridge || '').trim().slice(0, 200);
    const wish = fridge ? ('Nutze möglichst nur diese vorhandenen Zutaten: ' + fridge) : cleanStr(body.wish, 140);
    // Mahlzeiten-Fragebogen: welche Mahlzeiten geplant werden (mit sinnvollem kcal-Anteil je Mahlzeit).
    const MEAL_DEF = { fruehstueck: { label: 'Frühstück', share: 0.25 }, mittag: { label: 'Mittag', share: 0.35 }, abend: { label: 'Abend', share: 0.30 }, snack: { label: 'Snack', share: 0.12 } };
    const seenM = {}; const mealsReq = [];
    (Array.isArray(body.meals) ? body.meals : []).forEach(function (x) { const k = String(x || '').toLowerCase(); if (MEAL_DEF[k] && !seenM[k]) { seenM[k] = 1; mealsReq.push(k); } });
    // Mehrtagesplanung: eine Mahlzeit je Tag, über mehrere Tage verteilt (gedeckelt, damit die
    // Generierung handhabbar bleibt). dayOffset = 0..days-1 wird pro Rezept mitgegeben.
    const RCAP = 16;
    let daysReq = Math.max(1, Math.min(7, parseInt(body.days, 10) || 1));
    if (mealsReq.length && mealsReq.length * daysReq > RCAP) { daysReq = Math.max(1, Math.floor(RCAP / mealsReq.length)); }
    const mealsForAI = [];
    if (mealsReq.length) {
      for (let dOff = 0; dOff < daysReq; dOff++) {
        mealsReq.forEach(function (k) { const d = MEAL_DEF[k]; mealsForAI.push({ key: k, dayOffset: dOff, label: d.label, kcal: Math.round((t.kcal || 0) * d.share), protein: Math.round((t.protein || 0) * d.share) }); });
      }
    }
    // Vorlieben: Ernährungsform-Override (egal/vegetarisch/vegan) + Fokus (gesund/eiweißreich/schnell).
    const DIET_OK = { omnivor: 1, vegetarisch: 1, vegan: 1 };
    const dietOverride = DIET_OK[String(body.diet || '').toLowerCase()] ? String(body.diet).toLowerCase() : null;
    const diet = dietOverride || (profile && profile.diet) || 'omnivor';
    const FOCUS_OK = { gesund: 1, eiweissreich: 1, schnell: 1 };
    const focus = (Array.isArray(body.focus) ? body.focus : []).map(function (x) { return String(x || '').toLowerCase(); }).filter(function (f) { return FOCUS_OK[f]; });
    // Auf die Person zuschneiden: eine Portion ~ Anteil einer Hauptmahlzeit am Tagesziel (Standard 33 %).
    const share = Math.max(0.15, Math.min(0.6, Number(body.mealShare) || 0.33));
    const mealKcal = Math.round((t.kcal || 0) * share);
    const mealProtein = Math.round((t.protein || 0) * share);
    const count = mealsForAI.length ? mealsForAI.length : Math.max(1, Math.min(5, parseInt(body.count, 10) || 3));
    const avoidTitles = Array.isArray(body.avoidTitles) ? body.avoidTitles.slice(0, 8).map(function (x) { return cleanStr(x, 60); }).filter(Boolean) : [];
    const r = await AI.nutritionRecipes({ goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: diet, wish: wish, count: count, mealKcal: mealKcal, mealProtein: mealProtein, avoidTitles: avoidTitles, meals: mealsForAI, focus: focus, days: daysReq });
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN kann gerade keine Rezepte erstellen. Versuch es gleich nochmal.' })); }
    // Jedes generierte Rezept in die gemeinsame Bibliothek übernehmen (dedupliziert) und die
    // kanonischen Rezepte inkl. berechnetem Nutri-Score zurückgeben (wachsende Datenbank).
    try { require('../../lib/handled').record('ai', id, 'nutri-recipes'); } catch (e) {}
    const saved = await Recipes.addMany(r.recipes, 'ai');
    // Mahlzeiten-/Tages-Zuordnung (transient, nicht in der Bibliothek gespeichert): pro Rezept die
    // Mahlzeit (fruehstueck/…) + der Tages-Offset für die Plan-Kategorisierung. Index-Zuordnung,
    // da die KI die Rezepte in genau der angeforderten Reihenfolge liefert.
    if (mealsForAI.length) {
      saved.forEach(function (rec, i) {
        rec.meal = mealsForAI[i] ? mealsForAI[i].key : null;
        rec.dayOffset = mealsForAI[i] ? mealsForAI[i].dayOffset : 0;
      });
    }
    if (welcomeFree) { try { await Welcome.consume(id, 'ern'); } catch (e) {} }
    const quota = welcomeFree ? Quota.publicQuota(await Quota.getUsed(id, monthKey), premium, monthKey) : await chargeAI();
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, recipes: saved, quota: quota, days: daysReq, welcome: welcomeFree }));
  }

  // ── Studioweite Rezept-Bibliothek durchstöbern/suchen (wächst mit jeder Generierung) ──
  if (action === 'recipe-library') {
    await ensureSeed();
    const q = cleanStr(body.q, 60);
    const list = q ? await Recipes.searchLibrary(q, 60) : await Recipes.getLibrary(60, parseInt(body.offset, 10) || 0);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, recipes: list }));
  }

  // ── FINN Ernährungscoach (Punkt 4: echter Verlauf · Punkt 6: Schutzregeln) ──
  if (action === 'coach') {
    const question = cleanStr(body.question, 800);
    if (question.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }
    // Schutzprüfung ZUERST – greift auch ohne KI und unabhängig vom Rate-Limit.
    const safe = safetyResponse(question);
    if (safe) {
      try { require('../../lib/handled').record('system', id, 'nutri-safety'); } catch (e) {}
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, answer: safe, safety: true }));
    }
    if (!(await gateAI())) return;   // Sicherheits-Antwort läuft immer, KI-Reply kostet Kontingent/Premium
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-coach:' + id, 30, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const t = targetsFor(profile || {});
    const day = await loadDay(id, date);
    const totals = totalsOf(day.entries);
    // Verlauf serverseitig begrenzen & bereinigen (Punkt 4).
    const history = (Array.isArray(body.history) ? body.history : []).slice(-8)
      .map(function (h) { return { role: (h && h.role === 'assistant') ? 'assistant' : 'user', text: cleanStr(h && h.text, 800) }; })
      .filter(function (h) { return h.text; });
    const r = await AI.nutritionReply(
      { firstName: (m && m.firstName) || '', goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, eatenKcal: totals.kcal, eatenP: totals.p, under18: !!t.under18 },
      history, question);
    if (r.ok) { try { require('../../lib/handled').record('ai', id, 'nutri-chat'); } catch (e) {} }
    const cq = r.ok ? await chargeAI() : null;
    res.statusCode = 200; return res.end(JSON.stringify(r.ok ? { ok: true, answer: r.answer, quota: cq } : { ok: false, message: 'Da komme ich gerade nicht weiter. Frag mich gleich nochmal.' }));
  }

  // ── FINN bewertet die Mahlzeit, die man gerade eintragen will (Einzel-Items + Gesamt) ──
  if (action === 'evaluate-meal') {
    if (!(await gateAI())) return;
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    const items = (Array.isArray(body.items) ? body.items.slice(0, 12) : []).map(function (it) {
      it = it || {}; return { name: cleanStr(it.name, 80) || 'Eintrag', kcal: clamp(it.kcal, 0, 5000, 0), p: clamp(it.p, 0, 500, 0), c: clamp(it.c, 0, 700, 0), f: clamp(it.f, 0, 500, 0) };
    }).filter(function (it) { return it.kcal > 0 || it.p > 0 || it.c > 0 || it.f > 0; });
    if (!items.length) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_items', message: 'Füge zuerst etwas hinzu, das FINN bewerten kann.' })); }
    if (!(await M.rateLimit('nutri-mealeval:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const t = targetsFor(profile || {});
    const totals = totalsOf((await loadDay(id, date)).entries);
    const r = await AI.nutritionMealReview({
      firstName: (m && m.firstName) || '', goal: GOALS[profile && profile.goal] || 'ausgewogen',
      kcalTarget: t.kcal, protein: t.protein, eatenKcal: totals.kcal, eatenP: totals.p, under18: !!t.under18, items: items,
    });
    if (r.ok) { try { require('../../lib/handled').record('ai', id, 'nutri-mealeval'); } catch (e) {} }
    const eq = r.ok ? await chargeAI() : null;
    res.statusCode = 200; return res.end(JSON.stringify(r.ok
      ? { ok: true, rating: r.rating, nutriScore: r.nutriScore || null, summary: r.summary, good: r.good || [], items: r.items, tips: r.tips, quota: eq }
      : { ok: false, error: r.error || 'ai_failed', message: 'Da komme ich gerade nicht weiter. Versuch es gleich nochmal.' }));
  }

  // ── Produkt-Check beim Einkaufen: FINN bewertet EIN gescanntes Produkt aufs Ziel („kaufen?") ──
  if (action === 'product-check') {
    if (!(await gateAI())) return;
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    const prod = body.product || {};
    const name = cleanStr(prod.name, 100);
    if (!name) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_product', message: 'Kein Produkt zum Prüfen.' })); }
    if (!(await M.rateLimit('nutri-prodcheck:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const gn = String(prod.grade || '').trim().toUpperCase();
    const nn = prod.nutriments || {};
    const numOrNull = function (v) { const x = Number(v); return (v == null || !isFinite(x) || x < 0) ? null : Math.round(x * 10) / 10; };
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const r = await AI.nutritionProductCheck({
      firstName: (m && m.firstName) || '', goal: GOALS[profile && profile.goal] || 'ausgewogen', under18: !!targetsFor(profile || {}).under18,
      name: name, brand: cleanStr(prod.brand, 80), grade: /^[ABCDE]$/.test(gn) ? gn : '',
      kcal100: numOrNull(nn.kcal100g), protein100: numOrNull(nn.protein100g), sugars100: numOrNull(nn.sugars100g),
      satfat100: numOrNull(nn.satfat100g), salt100: numOrNull(nn.salt100g), fiber100: numOrNull(nn.fiber100g),
    });
    if (r.ok) { try { require('../../lib/handled').record('ai', id, 'nutri-prodcheck'); } catch (e) {} }
    const eq = r.ok ? await chargeAI() : null;
    res.statusCode = 200; return res.end(JSON.stringify(r.ok
      ? { ok: true, verdict: r.verdict, summary: r.summary, tip: r.tip, quota: eq }
      : { ok: false, error: r.error || 'ai_failed', message: 'Da komme ich gerade nicht weiter. Versuch es gleich nochmal.' }));
  }

  // ── Heißhunger-SOS: FINN spricht kurz gut zu (Soforthilfe, aufs Ziel/Auslöser zugeschnitten) ──
  if (action === 'craving-sos') {
    if (!(await gateAI())) return;
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-sos:' + id, 30, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const crave = ['suess', 'salzig', 'herzhaft', 'unklar'].indexOf(String(body.craving)) >= 0 ? String(body.craving) : 'unklar';
    const trigger = ['hunger', 'kopf'].indexOf(String(body.trigger)) >= 0 ? String(body.trigger) : 'kopf';
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const r = await AI.nutritionCravingSOS({
      firstName: (m && m.firstName) || '', goal: GOALS[profile && profile.goal] || 'ausgewogen',
      under18: !!targetsFor(profile || {}).under18, craving: crave, trigger: trigger,
    });
    if (r.ok) { try { require('../../lib/handled').record('ai', id, 'nutri-sos'); } catch (e) {} }
    const eq = r.ok ? await chargeAI() : null;
    res.statusCode = 200; return res.end(JSON.stringify(r.ok
      ? { ok: true, pep: r.pep, tip: r.tip, quota: eq }
      : { ok: false, error: r.error || 'ai_failed', message: 'Da komme ich gerade nicht weiter. Versuch es gleich nochmal.' }));
  }

  // ── Stoffwechsel-Coaching anfragen (Inbox-Vorgang + Studio-Mail) ──
  if (action === 'coaching-request') {
    if (!(await M.rateLimit('nutri-coaching:' + id, 5, 86400))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Deine Anfrage liegt uns schon vor – wir melden uns.' })); }
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const who = ((((m && m.firstName) || '') + ' ' + ((m && m.lastName) || '')).trim() || 'Mitglied')
      + ((m && m.customerNumber) ? (' (' + m.customerNumber + ')') : '') + ((m && m.email) ? (' · ' + m.email) : '');
    let vorgang = null;
    try {
      vorgang = await Inbox.addVorgang(id, {
        type: 'kontakt', subject: 'Stoffwechsel-Coaching – Interesse',
        systemText: 'Du interessierst dich für das Stoffwechsel-Coaching. Wir melden uns bei dir und stimmen einen Termin ab.',
        teamText: 'Hallo' + ((m && m.firstName) ? (' ' + m.firstName) : '') + ', danke für dein Interesse am Stoffwechsel-Coaching. Wir melden uns kurzfristig bei dir.',
        member: m ? { name: ((m.firstName || '') + ' ' + (m.lastName || '')).trim(), nr: m.customerNumber || null, email: m.email || null } : null,
      });
    } catch (e) {}
    try {
      await SR.notifyStudio({
        member: m ? { id: id, customerId: id, firstName: m.firstName, lastName: m.lastName } : { id: id },
        vorgang: vorgang || {},
        subject: '🥗 Stoffwechsel-Coaching angefragt – ' + who,
        text: 'Ein Mitglied hat über das Ernährungs-Modul Interesse am Stoffwechsel-Coaching bekundet.\n\nMitglied: ' + who + '\n\nBitte für ein Beratungs-/Coaching-Angebot melden.',
      });
    } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
  }

  // ── Intervallfasten: Plan/Start/Stop ──
  if (action === 'fast') {
    const cur = await loadFasting(id);
    const next = { plan: cur.plan, start: cur.start };
    const doo = String(body.do || '');
    if (doo === 'plan' && FAST_PLANS[body.plan]) next.plan = body.plan;
    else if (doo === 'start') next.start = Date.now();
    else if (doo === 'stop') next.start = null;
    try { await redisPipeline([['SET', FASTKEY(id), JSON.stringify(next)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile)));
  }

  // ── Wochenplan generieren (FINN) + Einkaufsliste ableiten ──
  if (action === 'plan-generate') {
    // „Erster Plan aufs Haus": einmalig gratis. Nur PRÜFEN – eingelöst wird nach Erfolg.
    const welcomeFree = !!body.welcome && (await Welcome.available(id, 'ern'));
    if (!welcomeFree) { if (!(await gateAI())) return; }
    if (!(await M.rateLimit('nutri-plan:' + id, 10, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    // Ziel/Ernährungsweise dürfen aus dem Onboarding kommen (auch ohne Ernährungs-Setup).
    const planGoalKey = GOALS[body.goal] ? body.goal : (profile && profile.goal);
    const planDiet = String(body.diet || (profile && profile.diet) || 'omnivor').slice(0, 30);
    const r = await AI.nutritionWeekPlan({ goal: GOALS[planGoalKey] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: planDiet });
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN kann gerade keinen Plan erstellen. Versuch es gleich nochmal.' })); }
    const plan = { days: r.days, createdAt: Date.now() };
    const shop = (r.shopping || []).map(function (s, i) { return { i: i, name: s.name, amount: s.amount, category: s.category || 'Sonstiges', checked: false }; });
    try { await redisPipeline([['SET', PLANKEY(id), JSON.stringify(plan)], ['SET', SHOPKEY(id), JSON.stringify(shop)]]); } catch (e) {}
    if (welcomeFree) { try { await Welcome.consume(id, 'ern'); } catch (e) {} }
    const quota = welcomeFree ? Quota.publicQuota(await Quota.getUsed(id, monthKey), premium, monthKey) : await chargeAI();
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, plan: plan, shopping: shop, quota: quota, welcome: welcomeFree }));
  }

  // ── Plan + Einkaufsliste laden ──
  if (action === 'plan-get') {
    const plan = await kvGetJson(PLANKEY(id));
    const shop = await kvGetJson(SHOPKEY(id));
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, plan: plan || null, shopping: Array.isArray(shop) ? shop : [] }));
  }
  if (action === 'shopping-toggle') {
    const shop = await kvGetJson(SHOPKEY(id)); const list = Array.isArray(shop) ? shop : [];
    const idx = parseInt(body.i, 10);
    if (list[idx]) list[idx].checked = !list[idx].checked;
    try { await redisPipeline([['SET', SHOPKEY(id), JSON.stringify(list)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, shopping: list }));
  }
  if (action === 'shopping-clear') {
    const shop = await kvGetJson(SHOPKEY(id)); let list = Array.isArray(shop) ? shop : [];
    list = list.filter(function (x) { return !x.checked; }).map(function (x, i) { return { i: i, name: x.name, amount: x.amount, checked: false }; });
    try { await redisPipeline([['SET', SHOPKEY(id), JSON.stringify(list)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, shopping: list }));
  }

  // ── Gespeicherte Rezepte: laden / speichern / löschen / ins Protokoll ──
  if (action === 'recipes-get') {
    const saved = await kvGetJson(RECKEY(id));
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, saved: Array.isArray(saved) ? saved : [] }));
  }
  if (action === 'recipe-save') {
    // Rezept in die persönliche Sammlung übernehmen. Kanonische Form (mit Nutri-Score,
    // Gramm-Zutaten, FINN-Bewertung). Nach Möglichkeit auch in die Studio-Bibliothek spiegeln.
    const clean = Recipes.normalizeRecipe(body.recipe || {}, 'member');
    if (!clean.id) clean.id = newEntryId();
    const saved = await kvGetJson(RECKEY(id)); const list = Array.isArray(saved) ? saved : [];
    if (!list.some(function (x) { return Recipes.normTitle(x.title) === Recipes.normTitle(clean.title); })) list.unshift(clean);
    const trimmed = list.slice(0, 40);
    try { await redisPipeline([['SET', RECKEY(id), JSON.stringify(trimmed)]]); } catch (e) {}
    try { await Recipes.addToLibrary(clean, 'member'); } catch (e) {}   // wächst die studioweite Bibliothek
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, saved: trimmed }));
  }
  if (action === 'recipe-delete') {
    const saved = await kvGetJson(RECKEY(id)); let list = Array.isArray(saved) ? saved : [];
    list = list.filter(function (x) { return String(x.id) !== String(body.id); });
    try { await redisPipeline([['SET', RECKEY(id), JSON.stringify(list)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, saved: list }));
  }
  if (action === 'recipe-log') {
    const targetDate = validDate(body.date, date);
    const rp = body.recipe || {};
    // Anzahl der Portionen wählbar; Makros deterministisch × Portionen, dann geprüft.
    const servings = clamp(body.servings, 1, 6, 1);
    const entry = sanitizeEntry({
      name: rp.title || 'Rezept', portion: servings + ' Portion' + (servings > 1 ? 'en' : ''), meal: body.meal,
      kcal: n0(rp.kcal) * servings, p: n0(rp.protein) * servings, c: n0(rp.carbs) * servings, f: n0(rp.fat) * servings,
    }, hour);
    const day = await loadDay(id, targetDate); day.entries.push(entry); await saveDay(id, targetDate, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile, targetDate), { added: [{ name: entry.name, kcal: entry.kcal }] })));
  }

  // ── Koch-Plan: „wann koche ich was" + daraus abgeleitete, abhakbare Einkaufsliste ──
  if (action === 'cookplan-get') {
    const cook = await loadCook(id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  if (action === 'cookplan-add') {
    const cook = await loadCook(id);
    const rec = Recipes.normalizeRecipe(body.recipe || {}, body.recipe && body.recipe.source);
    const when = validPlanDate(body.date, date);   // Koch-Plan darf in die Zukunft planen
    const servings = clamp(body.servings, 1, 12, rec.servings || 1);
    const item = {
      id: newEntryId(),
      title: rec.title,
      date: when,
      servings: servings,
      baseServings: rec.servings || 1,
      minutes: rec.minutes,
      kcal: rec.kcal, protein: rec.protein, carbs: rec.carbs, fat: rec.fat,
      nutri: rec.nutri || null,
      meal: (MEALS.indexOf(String(body.meal || (body.recipe && body.recipe.meal) || '')) >= 0) ? String(body.meal || body.recipe.meal) : null,
      ingredients: rec.ingredients,
      steps: rec.steps,
      utensils: rec.utensils || [],
      done: false,
    };
    cook.items.unshift(item);
    cook.items = cook.items.slice(0, 60);
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  // Ganzen (vom Kunden geprüften/angepassten) Plan-Entwurf auf einmal übernehmen.
  if (action === 'cookplan-add-many') {
    const cook = await loadCook(id);
    const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    items.forEach(function (raw) {
      raw = raw || {}; const rec = Recipes.normalizeRecipe(raw.recipe || {}, (raw.recipe && raw.recipe.source));
      const when = validPlanDate(raw.date, date);   // Koch-Plan darf in die Zukunft planen
      const servings = clamp(raw.servings, 1, 12, rec.servings || 1);
      const rawMeal = String(raw.meal || (raw.recipe && raw.recipe.meal) || '');
      cook.items.unshift({
        id: newEntryId(), title: rec.title, date: when, servings: servings, baseServings: rec.servings || 1,
        minutes: rec.minutes, kcal: rec.kcal, protein: rec.protein, carbs: rec.carbs, fat: rec.fat,
        nutri: rec.nutri || null, meal: (MEALS.indexOf(rawMeal) >= 0) ? rawMeal : null,
        ingredients: rec.ingredients, steps: rec.steps, utensils: rec.utensils || [], done: false,
      });
    });
    cook.items = cook.items.slice(0, 60);
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  if (action === 'cookplan-remove') {
    const cook = await loadCook(id);
    cook.items = cook.items.filter(function (x) { return String(x.id) !== String(body.id); });
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  if (action === 'cookplan-done') {
    const cook = await loadCook(id);
    const it = cook.items.filter(function (x) { return String(x.id) === String(body.id); })[0];
    if (it) it.done = !it.done;
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  // „Gegessen": Plan-Rezept als gekocht markieren UND ins Tagesprotokoll übernehmen (ein Schritt).
  if (action === 'cookplan-eaten') {
    const cook = await loadCook(id);
    const it = cook.items.filter(function (x) { return String(x.id) === String(body.id); })[0];
    if (!it) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Eintrag nicht gefunden.' })); }
    it.done = true;
    await saveCook(id, cook);
    const targetDate = validDate(it.date, date);   // an dem geplanten Tag protokollieren
    const servings = clamp(it.servings, 1, 12, 1);
    const entry = sanitizeEntry({
      // In die geplante Mahlzeit protokollieren (fällt der Eintrag ohne Mahlzeit zurück auf die Uhrzeit).
      name: it.title, portion: servings + ' Portion' + (servings > 1 ? 'en' : ''), meal: it.meal || body.meal,
      kcal: n0(it.kcal) * servings, p: n0(it.protein) * servings, c: n0(it.carbs) * servings, f: n0(it.fat) * servings,
    }, hour);
    const day = await loadDay(id, targetDate); day.entries.push(entry); await saveDay(id, targetDate, day);
    const state = await buildState(id, profile, targetDate);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(state, { cookplan: cook.items, shopping: buildShopping(cook), added: [{ name: entry.name, kcal: entry.kcal }] })));
  }
  if (action === 'cook-check') {
    // Einkaufslisten-Position (nach normalisiertem Namen) abhaken/wieder freigeben.
    const cook = await loadCook(id);
    const key = cleanStr(body.key, 90).toLowerCase();
    if (key) { cook.checked = cook.checked || {}; if (cook.checked[key]) delete cook.checked[key]; else cook.checked[key] = 1; }
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }
  if (action === 'cook-clear-checked') {
    const cook = await loadCook(id);
    cook.checked = {};
    await saveCook(id, cook);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, cookplan: cook.items, shopping: buildShopping(cook) }));
  }

  // ── Verlauf: letzte 7 Tage + FINN-Wochenreview ──
  if (action === 'week') {
    const t = targetsFor(profile || {});
    const keys = []; for (let i = 6; i >= 0; i--) keys.push(DKEY(id, dayKeyMinus(date, i)));
    const vals = await kvGetMany(keys);
    const days = vals.map(function (v, idx) {
      let entries = []; try { const o = JSON.parse(v); if (o && Array.isArray(o.entries)) entries = o.entries; } catch (e) {}
      const tot = totalsOf(entries);
      return { date: dayKeyMinus(date, 6 - idx), kcal: tot.kcal, p: tot.p, c: tot.c, f: tot.f, meals: entries.length };
    });
    const target = t.kcal || 2000;
    const trackedDays = days.filter(function (d) { return d.meals > 0; });
    const tracked = trackedDays.length;
    const inGoal = trackedDays.filter(function (d) { return d.kcal >= target * 0.85 && d.kcal <= target * 1.1; }).length;
    const proteinDays = trackedDays.filter(function (d) { return d.p >= t.protein * 0.9; }).length;
    const avgKcal = tracked ? Math.round(trackedDays.reduce(function (a, d) { return a + d.kcal; }, 0) / tracked) : 0;
    let review = null;
    // Verlauf/Protokoll ist gratis; nur das KI-Wochen-Review ist Premium.
    if (premium && AI.hasAI && tracked > 0 && (await M.rateLimit('nutri-week:' + id, 12, 3600))) {
      const r = await AI.nutritionWeekReview({ goal: GOALS[profile && profile.goal] || '—', kcalTarget: target, protein: t.protein, days: trackedDays.map(function (d) { return { date: d.date.slice(5), kcal: d.kcal, p: d.p }; }), inGoal: inGoal, avgKcal: avgKcal, proteinDays: proteinDays, tracked: tracked });
      if (r.ok) review = { tip: r.tip, insights: r.insights };
    }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, days: days, target: target, stats: { inGoal: inGoal, avgKcal: avgKcal, proteinDays: proteinDays, tracked: tracked }, review: review, reviewLocked: !premium }));
  }

  // ── Punkt 8: Datenschutz – Export / einzelnen Tag löschen / alles löschen ──
  // Exportiert & löscht AUSSCHLIESSLICH die Ernährungsdaten des angemeldeten Mitglieds
  // (alle Schlüssel per Session-ID). Keine internen Schlüssel/Secrets im Export.
  if (action === 'export') {
    const prof = await loadProfile(id);
    const dayKeys = []; for (let i = 0; i < 400; i++) dayKeys.push(DKEY(id, dayKeyMinus(date, i)));
    const vals = await kvGetMany(dayKeys);
    const days = {};
    vals.forEach(function (v, i) { if (!v) return; try { const o = JSON.parse(v); if (o && ((Array.isArray(o.entries) && o.entries.length) || n0(o.water))) days[dayKeyMinus(date, i)] = { entries: o.entries || [], water: n0(o.water) }; } catch (e) {} });
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, export: {
      exportedAt: new Date().toISOString(),
      profile: prof ? { goal: prof.goal, sex: prof.sex, height: prof.height, weight: prof.weight, age: prof.age, activity: prof.activity, diet: prof.diet, consentAt: prof.consentAt || null } : null,
      subscription: Ent.publicTier(await Ent.getEntitlement(id)),   // Abo-Status (read-only; Kündigung über Stripe-Portal)
      days: days,
      favorites: (await kvGetJson(FAVKEY(id))) || [],
      plan: (await kvGetJson(PLANKEY(id))) || null,
      shopping: (await kvGetJson(SHOPKEY(id))) || [],
      recipes: (await kvGetJson(RECKEY(id))) || [],
      cookplan: (await kvGetJson(COOKKEY(id))) || null,
      fasting: (await kvGetJson(FASTKEY(id))) || null,
      coaching: await Coaching.exportState(id),   // Coaching-Programm, Gewohnheiten, Check-ins (DSGVO)
      figur: (await Figur.getRec(id)) || null,   // Figur-Check: Mess-Historie (Gewicht/Umfänge) (DSGVO)
      social: await Social.socialExport(id).catch(function () { return null; }),   // Trainingspartner: Consent, Buddys, Gruppen (DSGVO)
    } }));
  }
  if (action === 'delete-day') {
    const targetDate = validDate(body.date, date);
    try { await redisPipeline([['DEL', DKEY(id, targetDate)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile, targetDate)));
  }
  if (action === 'delete-all') {
    if (String(body.confirm || '') !== 'LOESCHEN') { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'confirm_required', message: 'Bitte bestätige das vollständige Löschen.' })); }
    const keys = [PKEY(id), FAVKEY(id), PLANKEY(id), SHOPKEY(id), RECKEY(id), COOKKEY(id), FASTKEY(id)];
    Coaching.deleteKeys(id).forEach(function (k) { keys.push(k); });   // Coaching-Keys mitlöschen (nutri:prem bleibt bewusst außen vor)
    try { keys.push(require('../../lib/finnMemory').MKEY(id)); } catch (e) {}   // FINN-Gedächtnis (DSGVO) mitlöschen
    try { keys.push(require('../../lib/memberProfile').MKEY(id)); } catch (e) {}   // Onboarding-Profil inkl. Gesundheit (DSGVO) mitlöschen
    try { keys.push(require('../../lib/welcomeGift').MKEY(id)); } catch (e) {}   // Willkommensgeschenk-Status mitlöschen
    for (let i = 0; i < 400; i++) keys.push(DKEY(id, dayKeyMinus(date, i)));
    try { await redisPipeline(keys.map(function (k) { return ['DEL', k]; })); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, deleted: true }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
