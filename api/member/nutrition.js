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
const Coaching = require('../../lib/coaching');

// Freemium: KI-Funktionen sind Premium. Freundliche Meldung fürs Upgrade.
const PREMIUM_MSG = 'Das ist eine Premium-Funktion (KI). Teste Premium 7 Tage gratis – danach jederzeit kündbar.';

const PKEY = (id) => 'nutri:p:' + String(id);
const DKEY = (id, d) => 'nutri:d:' + String(id) + ':' + d;
const FASTKEY = (id) => 'nutri:fast:' + String(id);
const PLANKEY = (id) => 'nutri:plan:' + String(id);
const SHOPKEY = (id) => 'nutri:shop:' + String(id);
const RECKEY = (id) => 'nutri:rec:' + String(id);
const FAVKEY = (id) => 'nutri:fav:' + String(id);
const DAY_TTL = 400 * 86400;              // ~13 Monate

const FAST_PLANS = { '16:8': 16, '18:6': 18, '14:10': 14 };

const GOALS = { abnehmen: 'Abnehmen', halten: 'Gewicht halten', aufbau: 'Muskelaufbau' };
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
  if (under18 && goal === 'abnehmen') goal = 'halten';
  let kcal = tdee;
  if (goal === 'abnehmen') kcal = tdee - Math.min(500, tdee * 0.18);   // moderates Defizit, gedeckelt
  else if (goal === 'aufbau') kcal = tdee + Math.min(400, tdee * 0.12);
  // Untergrenze: geschlechtsabhängiges Minimum UND nie unter den Grundumsatz.
  const floor = Math.max(sex === 'm' ? 1500 : 1200, Math.round(bmr));
  kcal = Math.max(floor, Math.round(kcal / 10) * 10);
  // Eiweiß: sinnvolle g/kg, absolut auf 200 g gedeckelt, Untergrenze 40 g.
  const gPerKg = goal === 'aufbau' ? 1.8 : 1.6;
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

function totalsOf(entries) {
  return (entries || []).reduce(function (t, e) { return { kcal: t.kcal + n0(e.kcal), p: t.p + n0(e.p), c: t.c + n0(e.c), f: t.f + n0(e.f) }; }, { kcal: 0, p: 0, c: 0, f: 0 });
}
function waterGoalCups(t) { return Math.max(6, Math.round(((t && t.water) || 2) / 0.25)); }

// Zusammenhängende Tage mit mindestens einem Eintrag (endet heute oder gestern).
async function computeStreak(id, todayDate) {
  const keys = []; for (let i = 0; i < 30; i++) keys.push(DKEY(id, dayKeyMinus(todayDate, i)));
  const vals = await kvGetMany(keys);
  const tracked = vals.map(function (v) { try { const o = JSON.parse(v); return !!(o && Array.isArray(o.entries) && o.entries.length); } catch (e) { return false; } });
  let i = tracked[0] ? 0 : 1;                 // heute noch nichts? -> laufender Streak bis gestern
  if (i === 1 && !tracked[1]) return 0;
  let s = 0; while (tracked[i]) { s++; i++; }
  return s;
}
function pointsToday(totals, targets, entryCount, streak) {
  let p = 0;
  if (entryCount > 0) p += 50;                                    // heute getrackt
  if (targets && totals.p >= targets.protein * 0.9) p += 30;      // Eiweißziel (fast) erreicht
  if (targets && totals.kcal >= targets.kcal * 0.85 && totals.kcal <= targets.kcal * 1.1) p += 20; // im Kalorienfenster
  if (streak >= 3) p += 20;                                       // Serie
  return p;
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
  const streak = await computeStreak(id, todayYMD);
  const fasting = await loadFasting(id);
  const tier = Ent.publicTier(await Ent.getEntitlement(id));   // Premium-Status für die UI (Freemium)
  return {
    ok: true, available: true, onboarded: onboarded,
    profile: profile ? { goal: profile.goal, sex: profile.sex, height: profile.height, weight: profile.weight, age: profile.age, activity: profile.activity, diet: profile.diet } : null,
    targets: targets,
    today: { date, isToday: date === todayYMD, entries: day.entries, totals, water: day.water, waterGoal: waterGoalCups(targets) },
    streak: streak,
    pointsToday: pointsToday(totals, targets, day.entries.length, streak),
    fasting: fasting,
    premium: tier.premium, tier: tier.tier, trialing: tier.trialing, premiumUntil: tier.until,
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
  // Freemium-Gate: KI-Funktionen nur mit Premium. Serverseitig (Client-Gates sind umgehbar).
  const premium = Ent.isPremium(await Ent.getEntitlement(id));
  const denyPremium = function () { res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: 'premium_required', message: PREMIUM_MSG })); return true; };

  // ── Punkt 1: KI-SCHÄTZUNG per Freitext – wird NICHT gespeichert, nur zur Bestätigung ──
  if (action === 'estimate' || action === 'log') {
    if (!premium && denyPremium()) return;
    const text = cleanStr(body.text, 500);
    if (text.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty', message: 'Bitte beschreibe kurz, was du gegessen hast.' })); }
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-log:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const est = await AI.estimateFood(text);
    if (!est.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'ai_failed', message: 'FINN kann gerade nicht schätzen. Versuch es gleich nochmal.' })); }
    const meal = mealForHour(hour);
    const items = (est.items || []).map(function (it) { return sanitizeEntry({ name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, estimated: true }, hour); });
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, items: items, meal: meal, estimated: true, message: items.length ? '' : 'Ich konnte kein Lebensmittel erkennen – beschreib es etwas genauer.' }));
  }

  // ── Punkt 1: KI-SCHÄTZUNG per FOTO – wird NICHT gespeichert, nur zur Bestätigung ──
  if (action === 'estimate-photo' || action === 'log-photo') {
    if (!premium && denyPremium()) return;
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-photo:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const b64 = String(body.base64 || '');
    if (b64.length < 100 || b64.length > 8000000) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'bad_photo', message: 'Kein gültiges Foto empfangen.' })); }
    const est = await AI.estimateFoodPhoto(b64, body.mediaType);
    if (!est.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'ai_failed', message: 'FINN kann das Foto gerade nicht auswerten. Versuch es gleich nochmal.' })); }
    const meal = mealForHour(hour);
    const items = (est.items || []).map(function (it) { return sanitizeEntry({ name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, estimated: true }, hour); });
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, items: items, meal: meal, estimated: true, message: items.length ? '' : 'Auf dem Foto konnte ich kein Lebensmittel erkennen – versuch es mit einer Texteingabe.' }));
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
    day.water = Math.max(0, Math.min(goal + 4, cups));
    await saveDay(id, targetDate, day);
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

  // ── KI-Rezepte (nicht gespeichert) ──
  if (action === 'recipes') {
    if (!premium && denyPremium()) return;
    if (!(await M.rateLimit('nutri-recipes:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    const fridge = String(body.fridge || '').trim().slice(0, 200);
    const wish = fridge ? ('Nutze möglichst nur diese vorhandenen Zutaten: ' + fridge) : body.wish;
    const r = await AI.nutritionRecipes({ goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: (profile && profile.diet) || 'omnivor', wish: wish });
    res.statusCode = 200; return res.end(JSON.stringify(r.ok ? { ok: true, recipes: r.recipes } : { ok: false, message: 'FINN kann gerade keine Rezepte erstellen. Versuch es gleich nochmal.' }));
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
    if (!premium && denyPremium()) return;   // Sicherheits-Antwort läuft immer, KI-Reply nur mit Premium
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
    res.statusCode = 200; return res.end(JSON.stringify(r.ok ? { ok: true, answer: r.answer } : { ok: false, message: 'Da komme ich gerade nicht weiter. Frag mich gleich nochmal.' }));
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
    if (!premium && denyPremium()) return;
    if (!(await M.rateLimit('nutri-plan:' + id, 10, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    const r = await AI.nutritionWeekPlan({ goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: (profile && profile.diet) || 'omnivor' });
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN kann gerade keinen Plan erstellen. Versuch es gleich nochmal.' })); }
    const plan = { days: r.days, createdAt: Date.now() };
    const shop = (r.shopping || []).map(function (s, i) { return { i: i, name: s.name, amount: s.amount, category: s.category || 'Sonstiges', checked: false }; });
    try { await redisPipeline([['SET', PLANKEY(id), JSON.stringify(plan)], ['SET', SHOPKEY(id), JSON.stringify(shop)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, plan: plan, shopping: shop }));
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
    const rp = body.recipe || {};
    // Volle Makros je Portion mitspeichern (Punkt 7: keine still fehlenden Makros).
    const clean = {
      id: newEntryId(), title: cleanStr(rp.title, 100) || 'Rezept',
      servings: clamp(rp.servings, 1, 12, 1),
      kcal: n0(rp.kcal), protein: n0(rp.protein), carbs: n0(rp.carbs), fat: n0(rp.fat), minutes: n0(rp.minutes),
      ingredients: (Array.isArray(rp.ingredients) ? rp.ingredients : []).slice(0, 15).map(function (x) { return cleanStr(x, 90); }).filter(Boolean),
      steps: (Array.isArray(rp.steps) ? rp.steps : []).slice(0, 8).map(function (x) { return cleanStr(x, 200); }).filter(Boolean),
    };
    const saved = await kvGetJson(RECKEY(id)); const list = Array.isArray(saved) ? saved : [];
    if (!list.some(function (x) { return x.title === clean.title; })) list.unshift(clean);
    const trimmed = list.slice(0, 40);
    try { await redisPipeline([['SET', RECKEY(id), JSON.stringify(trimmed)]]); } catch (e) {}
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
      fasting: (await kvGetJson(FASTKEY(id))) || null,
      coaching: await Coaching.exportState(id),   // Coaching-Programm, Gewohnheiten, Check-ins (DSGVO)
    } }));
  }
  if (action === 'delete-day') {
    const targetDate = validDate(body.date, date);
    try { await redisPipeline([['DEL', DKEY(id, targetDate)]]); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile, targetDate)));
  }
  if (action === 'delete-all') {
    if (String(body.confirm || '') !== 'LOESCHEN') { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'confirm_required', message: 'Bitte bestätige das vollständige Löschen.' })); }
    const keys = [PKEY(id), FAVKEY(id), PLANKEY(id), SHOPKEY(id), RECKEY(id), FASTKEY(id)];
    Coaching.deleteKeys(id).forEach(function (k) { keys.push(k); });   // Coaching-Keys mitlöschen (nutri:prem bleibt bewusst außen vor)
    for (let i = 0; i < 400; i++) keys.push(DKEY(id, dayKeyMinus(date, i)));
    try { await redisPipeline(keys.map(function (k) { return ['DEL', k]; })); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, deleted: true }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
