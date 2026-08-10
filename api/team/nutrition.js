'use strict';

/**
 * POST/GET /api/team/nutrition   (Team-Session erforderlich)
 * ----------------------------------------------------------
 * Lässt das Studio-Team die Ernährung EINES Mitglieds betreuen:
 *  - GET  ?id=&date=   -> Ziel/Zielwerte, Tag (Einträge+Summen+Wasser), 7-Tage-Überblick, Koch-Plan
 *  - POST { id, action, … }:
 *      entry-update   Eintrag bearbeiten (kcal/Nährwerte/Name/Mahlzeit)
 *      entry-add      manuellen Eintrag hinzufügen
 *      entry-delete   Eintrag löschen
 *      save-profile   Ziel + Körperdaten ändern -> Zielwerte werden neu berechnet
 *      cookplan-add   Rezept in den Essens-/Koch-Plan des Mitglieds legen
 *      cookplan-remove Plan-Eintrag entfernen
 *      recipe-search  Studio-Rezeptbibliothek durchsuchen (zum Zuweisen)
 *
 * WICHTIG: Datenmodell, Schlüssel & Formeln spiegeln bewusst api/member/nutrition.js
 * (dieselben Redis-Keys nutri:p/d/cook, dieselbe targetsFor-Rechnung wie beim
 * Mitglied und im Client). Bei Änderungen dort hier mitziehen.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const Recipes = require('../../lib/recipes');
const { redisPipeline, hasStore } = require('../../lib/store');
const Phases = require('../../lib/nutriPhases');
const PHIDX = 'nutri:phidx';   // SET der Mitglieder mit Phasenplan (für die Wechsel-Benachrichtigung)

// ── Schlüssel & Konstanten (identisch zu api/member/nutrition.js) ──
const PKEY = (id) => 'nutri:p:' + String(id);
const DKEY = (id, d) => 'nutri:d:' + String(id) + ':' + d;
const COOKKEY = (id) => 'nutri:cook:' + String(id);
const DAY_TTL = 400 * 86400;

const GOALS = { abnehmen: 'Abnehmen', definieren: 'Definieren', halten: 'Gewicht halten', aufbau: 'Muskelaufbau', gesundheit: 'Gesundheit', longevity: 'Longevity' };
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
const MEALS = ['fruehstueck', 'mittag', 'abend', 'snack'];

function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }
function clamp(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }
function cleanStr(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function newEntryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: parseInt(get('hour'), 10) || 0 };
}
function mealForHour(h) { return h < 11 ? 'fruehstueck' : (h < 15 ? 'mittag' : (h < 21 ? 'abend' : 'snack')); }
function dayKeyMinus(baseYMD, i) { const d = new Date(baseYMD + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - i); return d.toISOString().slice(0, 10); }
function validMeal(m, hour) { return MEALS.indexOf(String(m || '')) >= 0 ? String(m) : mealForHour(hour); }
function validDate(input, todayYMD) {
  const s = String(input || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return todayYMD;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return todayYMD;
  if (s > todayYMD) return todayYMD;
  const min = dayKeyMinus(todayYMD, 400);
  return s < min ? min : s;
}
function validPlanDate(input, todayYMD) {
  const s = String(input || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return todayYMD;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return todayYMD;
  const min = dayKeyMinus(todayYMD, 7), max = dayKeyMinus(todayYMD, -21);
  if (s < min) return min; if (s > max) return max; return s;
}
function sanitizeEntry(raw, hour, keepId) {
  raw = raw || {};
  const e = {
    id: (keepId && cleanStr(raw.id, 24)) || newEntryId(),
    name: cleanStr(raw.name, 80) || 'Mahlzeit',
    portion: cleanStr(raw.portion, 40),
    kcal: clamp(raw.kcal, 0, 5000, 0),
    p: clamp(raw.p, 0, 500, 0), c: clamp(raw.c, 0, 700, 0), f: clamp(raw.f, 0, 500, 0),
    meal: validMeal(raw.meal, hour),
    ts: Date.now(),
  };
  const amount = cleanStr(raw.amount, 24); if (amount) e.amount = amount;
  e.source = 'team';   // Herkunft: vom Studio-Team eingetragen/geändert
  return e;
}
// Zielwerte – identische Rechnung wie beim Mitglied (Mifflin-St-Jeor + Ziel-Offset).
function targetsFor(p, today) {
  p = p || {};
  const sex = p.sex === 'm' ? 'm' : 'w';
  const weight = clamp(p.weight, 35, 250, 70), height = clamp(p.height, 120, 230, 170), age = clamp(p.age, 14, 100, 30);
  const under18 = age < 18;
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'm' ? 5 : -161);
  const factor = ACTS[p.activity] || 1.55;
  const tdee = bmr * factor;
  let goal = GOALS[p.goal] ? p.goal : 'halten';
  let model = GOAL_MODEL[goal] || GOAL_MODEL.halten;
  if (under18 && model.kind === 'deficit') { goal = 'halten'; model = GOAL_MODEL.halten; }
  let kcal = tdee;
  if (model.kind === 'deficit') kcal = tdee - Math.min(model.cap, tdee * model.pct);
  else if (model.kind === 'surplus') kcal = tdee + Math.min(model.cap, tdee * model.pct);
  const floor = Math.max(sex === 'm' ? 1500 : 1200, Math.round(bmr));
  kcal = Math.max(floor, Math.round(kcal / 10) * 10);
  const protein = Math.max(40, Math.min(200, Math.round(model.protein * weight)));
  const fat = Math.max(30, Math.min(150, Math.round(0.9 * weight)));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const water = Math.max(1.5, Math.min(4, Math.round(weight * 0.035 * 10) / 10));
  const t = { kcal, protein, carbs, fat, water, under18 };
  // Individuelle Zielwerte (z. B. aus einer Stoffwechselanalyse) übersteuern die
  // Formel feldweise – identisch zur Mitglieder-Seite; unter 18 nie übersteuern.
  // Ein laufender Phasenplan hat Vorrang vor dem statischen Override (sonst bliebe der
  // automatische Wechsel genau bei der Zielgruppe wirkungslos). Der Phasenblock ersetzt
  // die Makros komplett; nur Wasser bleibt aus dem Override. Identisch zur Mitglieder-Seite.
  const ov0 = (!under18 && p.targetOverride && typeof p.targetOverride === 'object') ? p.targetOverride : null;
  const ph = (!under18 && p.phasePlan) ? Phases.activeOverride(p.phasePlan, today) : null;
  const ov = ph
    ? { water: ov0 ? ov0.water : null, kcal: ph.kcal, protein: ph.protein, carbs: ph.carbs, fat: ph.fat }
    : ov0;
  if (ov) {
    const num = (v, min, max, dec) => { if (v == null || v === '') return null; const n = Number(v); if (isNaN(n) || n <= 0) return null; const r = dec ? Math.round(n * 10) / 10 : Math.round(n); return Math.max(min, Math.min(max, r)); };
    const k = num(ov.kcal, 1000, 4500), pr = num(ov.protein, 30, 300), ft = num(ov.fat, 20, 250), cb = num(ov.carbs, 1, 700), wa = num(ov.water, 1, 5, true);
    if (k != null || pr != null || ft != null || cb != null || wa != null) {
      if (k != null) t.kcal = k;
      if (pr != null) t.protein = pr;
      if (ft != null) t.fat = ft;
      if (wa != null) t.water = wa;
      t.carbs = (cb != null) ? cb : Math.max(0, Math.round((t.kcal - t.protein * 4 - t.fat * 9) / 4));
      t.custom = true;
    }
  }
  if (ph) t.phase = { name: ph.phaseName, index: ph.phaseIndex, count: ph.phaseCount, week: ph.weekInPhase, weeks: ph.weeksInPhase, until: ph.until };
  return t;
}
function totalsOf(entries) { return (entries || []).reduce((t, e) => ({ kcal: t.kcal + n0(e.kcal), p: t.p + n0(e.p), c: t.c + n0(e.c), f: t.f + n0(e.f) }), { kcal: 0, p: 0, c: 0, f: 0 }); }
function waterGoalCups(t) { return Math.max(6, Math.round(((t && t.water) || 2) / 0.25)); }

async function kvGetJson(key) { try { const [r] = await redisPipeline([['GET', key]]); if (!r) return null; return JSON.parse(r); } catch (e) { return null; } }
async function kvGetMany(keys) { if (!keys.length) return []; try { return await redisPipeline([['MGET', ...keys]]).then((r) => r[0] || []); } catch (e) { return keys.map(() => null); } }
async function loadProfile(id) { return kvGetJson(PKEY(id)); }
async function loadDay(id, date) { const d = await kvGetJson(DKEY(id, date)); if (d && Array.isArray(d.entries)) return { entries: d.entries, water: n0(d.water) }; return { entries: [], water: 0 }; }
async function saveDay(id, date, day) { try { await redisPipeline([['SET', DKEY(id, date), JSON.stringify({ entries: day.entries.slice(-60), water: n0(day.water) }), 'EX', String(DAY_TTL)]]); return true; } catch (e) { return false; } }
async function loadCook(id) { const c = await kvGetJson(COOKKEY(id)); return { items: (c && Array.isArray(c.items)) ? c.items : [], checked: (c && c.checked) || {} }; }
async function saveCook(id, cook) { try { await redisPipeline([['SET', COOKKEY(id), JSON.stringify({ items: (cook.items || []).slice(0, 60), checked: cook.checked || {} })]]); return true; } catch (e) { return false; } }

function dayView(id, date, day, targets) {
  return { date, entries: day.entries, totals: totalsOf(day.entries), water: day.water, waterGoal: waterGoalCups(targets) };
}
// 7-Tage-Überblick (kcal + getrackt ja/nein), jüngster Tag zuerst.
async function weekOverview(id, todayYMD, targets) {
  const N = 7; const keys = []; for (let i = 0; i < N; i++) keys.push(DKEY(id, dayKeyMinus(todayYMD, i)));
  const vals = await kvGetMany(keys);
  return vals.map((v, i) => { let entries = null; try { const o = JSON.parse(v); entries = (o && Array.isArray(o.entries)) ? o.entries : null; } catch (e) {} const t = totalsOf(entries || []); return { date: dayKeyMinus(todayYMD, i), kcal: t.kcal, protein: t.p, entries: (entries || []).length, tracked: !!(entries && entries.length) }; });
}
function trimRecipe(r) { if (!r) return null; return { id: r.id, title: r.title, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, servings: r.servings, minutes: r.minutes, nutri: r.nutri || null }; }

async function readState(id, forDate) {
  const todayYMD = berlinNow().date;
  const date = validDate(forDate, todayYMD);
  const profile = (await loadProfile(id)) || {};
  const targets = targetsFor(profile, todayYMD);
  const day = await loadDay(id, date);
  const cook = await loadCook(id);
  const week = await weekOverview(id, todayYMD, targets);
  const pubProfile = { onboarded: !!profile.onboarded, goal: profile.goal || null, sex: profile.sex || null, height: profile.height || null, weight: profile.weight || null, age: profile.age || null, activity: profile.activity || null, diet: profile.diet || null };
  return {
    ok: true, available: true, today: todayYMD, date,
    profile: pubProfile, goals: GOALS, meals: MEALS,
    targets, targetOverride: profile.targetOverride || null,
    // Phasenplan (Periodisierung): Rohplan für den Editor + aufgelöste Sicht für die Anzeige.
    phasePlan: profile.phasePlan || null,
    phases: Phases.resolve(profile.phasePlan, todayYMD),
    phasesBlocked: targets.under18 === true,
    phaseTemplates: Phases.templateList(),
    phaseLimits: { maxPhases: Phases.MAX_PHASES, maxWeeks: Phases.MAX_WEEKS, limits: Phases.LIMITS, kinds: Phases.KINDS },
    day: dayView(id, date, day, targets), week,
    cookplan: (cook.items || []).slice(0, 40),
    everTracked: !!profile.onboarded || week.some((w) => w.tracked) || (cook.items || []).length > 0,
  };
}

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!Cap.requireCap(sess, 'nutrition.manage', res)) return;
  if (!hasStore) return j(res, 200, { ok: true, available: false });

  // ── GET: Überblick ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return j(res, 400, { ok: false, error: 'missing_id' });
    try { return j(res, 200, await readState(id, url.searchParams.get('date'))); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');
  const { date: todayYMD, hour } = berlinNow();

  // Rezept-Bibliothek durchsuchen (kein Mitglied nötig) – zum Auswählen fürs Zuweisen.
  if (action === 'recipe-search') {
    const q = cleanStr(body.q, 60);
    let list = [];
    try { list = q ? await Recipes.searchLibrary(q, 24) : await Recipes.getLibrary(24, 0); } catch (e) { list = []; }
    return j(res, 200, { ok: true, recipes: (list || []).map(trimRecipe).filter(Boolean) });
  }

  const id = String((body && body.id) || '').trim();
  if (!id) return j(res, 400, { ok: false, error: 'missing_id' });

  try {
    // Ziel + Körperdaten ändern -> Zielwerte werden neu berechnet.
    if (action === 'save-profile') {
      const inp = body.profile || {};
      const prev = (await loadProfile(id)) || {};
      const profile = {
        onboarded: true,
        goal: GOALS[inp.goal] ? inp.goal : (prev.goal || 'halten'),
        sex: inp.sex === 'm' ? 'm' : (inp.sex === 'w' ? 'w' : (prev.sex || 'w')),
        height: clamp(inp.height, 120, 230, prev.height || 170),
        weight: clamp(inp.weight, 35, 250, prev.weight || 70),
        age: clamp(inp.age, 14, 100, prev.age || 30),
        activity: ACTS[inp.activity] ? inp.activity : (prev.activity || 'moderat'),
        diet: DIETS.indexOf(inp.diet) >= 0 ? inp.diet : (prev.diet || 'omnivor'),
        consentAt: prev.consentAt || null,
        updatedAt: Date.now(),
        updatedByTeam: (sess && (sess.user || sess.name)) || 'team',
      };
      // Individuelle Zielwerte bleiben bei einer Neuberechnung der Körperdaten erhalten.
      if (prev.targetOverride) profile.targetOverride = prev.targetOverride;
      if (prev.phasePlan) profile.phasePlan = prev.phasePlan;   // Phasenplan überlebt jede Neuberechnung
      try { await redisPipeline([['SET', PKEY(id), JSON.stringify(profile)]]); } catch (e) {}
      return j(res, 200, await readState(id, body.date));
    }

    // Individuelle Zielwerte setzen (z. B. aus einer Stoffwechselanalyse). Leere Felder
    // behalten den Formelwert; sind alle Felder leer, wird die Übersteuerung entfernt.
    // Für unter 18-Jährige bleiben die Schutz-Richtwerte der Formel – keine Übersteuerung.
    if (action === 'targets-set') {
      const prev = (await loadProfile(id)) || {};
      if (clamp(prev.age, 14, 100, 30) < 18) return j(res, 200, { ok: false, error: 'under18', message: 'Für unter 18-Jährige bleiben die berechneten Richtwerte bestehen.' });
      const inp = (body && body.targets) || {};
      const num = (v, min, max, dec) => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); if (isNaN(n) || n <= 0) return null; const r = dec ? Math.round(n * 10) / 10 : Math.round(n); return Math.max(min, Math.min(max, r)); };
      const ov = {};
      const k = num(inp.kcal, 1000, 4500); if (k != null) ov.kcal = k;
      const pr = num(inp.protein, 30, 300); if (pr != null) ov.protein = pr;
      const cb = num(inp.carbs, 1, 700); if (cb != null) ov.carbs = cb;
      const ft = num(inp.fat, 20, 250); if (ft != null) ov.fat = ft;
      const wa = num(inp.water, 1, 5, true); if (wa != null) ov.water = wa;
      if (Object.keys(ov).length) {
        const note = cleanStr(body.note, 160); if (note) ov.note = note;
        ov.setBy = (sess && (sess.user || sess.name)) || 'team';
        ov.setAt = Date.now();
        prev.targetOverride = ov;
      } else {
        delete prev.targetOverride;
      }
      prev.updatedAt = Date.now();
      try { await redisPipeline([['SET', PKEY(id), JSON.stringify(prev)]]); } catch (e) {}
      return j(res, 200, await readState(id, body.date));
    }

    // ── Phasenplan (Periodisierung) ──────────────────────────────────────────
    // Mehrere Phasen im Voraus planen; der Wechsel passiert automatisch, weil die
    // Zielwerte bei jedem Read neu aufgelöst werden. Unter 18 bleibt gesperrt.
    if (action === 'phases-set') {
      const prev = (await loadProfile(id)) || {};
      if (clamp(prev.age, 14, 100, 30) < 18) return j(res, 200, { ok: false, error: 'under18', message: 'Für unter 18-Jährige bleiben die berechneten Richtwerte bestehen.' });
      const inp = (body && body.plan) || {};
      if (body && body.source) inp.source = body.source;
      if (body && body.analysis) inp.analysis = body.analysis;
      const norm = Phases.normalize(inp, { today: berlinNow().date, setBy: (sess && (sess.user || sess.name)) || 'team' });
      if (!norm.ok) {
        const msg = norm.error === 'no_phases'
          ? 'Bitte mindestens eine Phase mit Zielwerten angeben.'
          : 'Der Phasenplan konnte nicht gelesen werden.';
        return j(res, 200, { ok: false, error: norm.error, message: msg });
      }
      prev.phasePlan = norm.plan;
      prev.updatedAt = Date.now();
      try { await redisPipeline([['SET', PKEY(id), JSON.stringify(prev)]]); } catch (e) {}
      try { await redisPipeline([['SADD', PHIDX, String(id)]]); } catch (e) {}
      return j(res, 200, await readState(id, body.date));
    }

    if (action === 'phases-clear') {
      const prev = (await loadProfile(id)) || {};
      delete prev.phasePlan;
      prev.updatedAt = Date.now();
      try { await redisPipeline([['SET', PKEY(id), JSON.stringify(prev)]]); } catch (e) {}
      try { await redisPipeline([['SREM', PHIDX, String(id)]]); } catch (e) {}
      return j(res, 200, await readState(id, body.date));
    }

    // Stoffwechselanalyse (PDF/Foto) von FINN auslesen lassen -> VORSCHLAG.
    // Speichert NICHTS: das Team prüft im Editor und bestätigt per phases-set.
    // Gesundheitsdaten -> nur mit gültiger Einwilligung des Mitglieds.
    if (action === 'phases-analyze') {
      const prev = (await loadProfile(id)) || {};
      if (clamp(prev.age, 14, 100, 30) < 18) return j(res, 200, { ok: false, error: 'under18', message: 'Für unter 18-Jährige wird kein Phasenplan angewendet.' });
      // Einwilligung für die Gesundheitsdaten-Verarbeitung (das Team kann sie NICHT ersetzen).
      let consentOk = false;
      try { const c = await require('../../lib/privacy').currentConsents(id); consentOk = !!(c && c.nutrition_health && c.nutrition_health.granted); } catch (e) { consentOk = false; }
      if (!consentOk) return j(res, 200, { ok: false, error: 'consent_required', message: 'Das Mitglied hat der Verarbeitung seiner Ernährungs-/Gesundheitsdaten noch nicht zugestimmt. Bitte zuerst im Ernährungsbereich der App bestätigen lassen.' });
      if (!(await M.rateLimit('nutri-phase-ai:' + ((sess && (sess.user || sess.name)) || 'team'), 20, 3600))) {
        return j(res, 200, { ok: false, error: 'rate_limited', message: 'Zu viele Analysen in kurzer Zeit – bitte später erneut versuchen.' });
      }
      const raw = String((body && (body.file || body.document || body.photo)) || '');
      const m = raw.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,(.+)$/);
      const b64 = m ? m[2] : raw.replace(/^data:[^,]*,/, '');
      const mediaType = m ? m[1] : (body && body.mediaType) || 'application/pdf';
      if (!b64 || b64.length < 100) return j(res, 200, { ok: false, error: 'bad_file', message: 'Datei konnte nicht gelesen werden. Bitte eine PDF oder ein Foto der Analyse hochladen.' });
      if (b64.length > 2.4e6) return j(res, 200, { ok: false, error: 'too_large', message: 'Datei ist zu groß. Bitte nur die relevanten Seiten hochladen (max. ca. 1,8 MB).' });

      const AI = require('../../lib/ai');
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'Die KI-Auswertung ist gerade nicht verfügbar. Du kannst die Phasen manuell anlegen.' });
      const base = targetsFor(Object.assign({}, prev, { phasePlan: null, targetOverride: null }), berlinNow().date);
      let r = null;
      try {
        r = await AI.scanMetabolic(b64, mediaType, {
          profile: { sex: prev.sex, age: prev.age, weight: prev.weight, height: prev.height },
          targets: { kcal: base.kcal }, totalWeeks: body.totalWeeks,
        });
      } catch (e) { r = null; }
      if (!r || !r.ok) {
        // Fail-closed: kein Ersatzweg, aber verständliche Meldung (nie Inhalte ins Log).
        return j(res, 200, { ok: false, error: (r && r.error) || 'scan_failed', message: 'Die Analyse konnte nicht ausgewertet werden. Bitte Datei prüfen oder die Phasen manuell anlegen.' });
      }
      // Durch dieselbe Normalisierung schicken, die auch beim Speichern greift –
      // das Team sieht damit exakt das, was gespeichert würde.
      const norm = Phases.normalize({ startDate: body.startDate || berlinNow().date, source: 'analysis', phases: r.phases, analysis: r.analysis }, { today: berlinNow().date });
      if (!norm.ok) return j(res, 200, { ok: false, error: 'no_phases', message: 'FINN konnte aus dem Dokument keinen belastbaren Plan ableiten. Bitte manuell anlegen.' });
      return j(res, 200, {
        ok: true,
        proposal: { startDate: norm.plan.startDate, phases: norm.plan.phases, source: 'analysis' },
        analysis: norm.plan.analysis, rationale: r.rationale, confidence: r.confidence,
      });
    }

    // Vorlage in einen Vorschlag gießen (NICHT speichern) – das Team gibt die
    // Gesamtdauer in Wochen vor, die Phasen werden proportional verteilt.
    if (action === 'phases-template') {
      const prev = (await loadProfile(id)) || {};
      const base = targetsFor(Object.assign({}, prev, { phasePlan: null, targetOverride: null }), berlinNow().date);
      const proposal = Phases.applyTemplate(String(body.template || ''), body.totalWeeks, base, {
        weight: clamp(prev.weight, 35, 250, 75),
        startDate: body.startDate,
      });
      if (!proposal) return j(res, 200, { ok: false, error: 'unknown_template', message: 'Unbekannte Vorlage.' });
      return j(res, 200, { ok: true, proposal: proposal });
    }

    // Eintrag hinzufügen / bearbeiten / löschen (auf einem validierten Tag).
    if (action === 'entry-add' || action === 'entry-update' || action === 'entry-delete') {
      const date = validDate(body.date, todayYMD);
      const day = await loadDay(id, date);

      if (action === 'entry-add') {
        day.entries.push(sanitizeEntry(body, hour, false));
      } else if (action === 'entry-delete') {
        const eid = cleanStr(body.entryId || body.eid, 24);
        day.entries = day.entries.filter((e) => String(e.id) !== eid);
      } else { // entry-update
        const eid = cleanStr(body.entryId || body.eid, 24);
        const patch = body.patch || body;
        let found = false;
        day.entries = day.entries.map((e) => {
          if (String(e.id) !== eid) return e;
          found = true;
          const merged = Object.assign({}, e, {
            name: patch.name != null ? patch.name : e.name,
            portion: patch.portion != null ? patch.portion : e.portion,
            kcal: patch.kcal != null ? patch.kcal : e.kcal,
            p: patch.p != null ? patch.p : e.p, c: patch.c != null ? patch.c : e.c, f: patch.f != null ? patch.f : e.f,
            meal: patch.meal != null ? patch.meal : e.meal, id: e.id,
          });
          const s = sanitizeEntry(merged, hour, true); s.ts = e.ts || s.ts; s.source = 'team'; return s;
        });
        if (!found) return j(res, 200, { ok: false, error: 'entry_not_found' });
      }
      await saveDay(id, date, day);
      const targets = targetsFor((await loadProfile(id)) || {});
      return j(res, 200, { ok: true, day: dayView(id, date, day, targets) });
    }

    // Rezept in den Essens-/Koch-Plan des Mitglieds legen.
    if (action === 'cookplan-add') {
      let raw = body.recipe || null;
      if (!raw && body.recipeId) { try { raw = await Recipes.getById(String(body.recipeId)); } catch (e) {} }
      if (!raw) return j(res, 200, { ok: false, error: 'recipe_missing' });
      const rec = Recipes.normalizeRecipe(raw, raw.source);
      const cook = await loadCook(id);
      const when = validPlanDate(body.date, todayYMD);
      const servings = clamp(body.servings, 1, 12, rec.servings || 1);
      cook.items.unshift({
        id: newEntryId(), title: rec.title, date: when, servings, baseServings: rec.servings || 1,
        minutes: rec.minutes, kcal: rec.kcal, protein: rec.protein, carbs: rec.carbs, fat: rec.fat, nutri: rec.nutri || null,
        meal: (MEALS.indexOf(String(body.meal || '')) >= 0) ? String(body.meal) : null,
        ingredients: rec.ingredients, steps: rec.steps, utensils: rec.utensils || [], done: false,
        assignedByTeam: (sess && (sess.user || sess.name)) || 'team',
      });
      cook.items = cook.items.slice(0, 60);
      await saveCook(id, cook);
      return j(res, 200, { ok: true, cookplan: cook.items.slice(0, 40) });
    }
    if (action === 'cookplan-remove') {
      const itemId = cleanStr(body.itemId, 24);
      const cook = await loadCook(id);
      cook.items = (cook.items || []).filter((it) => String(it.id) !== itemId);
      await saveCook(id, cook);
      return j(res, 200, { ok: true, cookplan: cook.items.slice(0, 40) });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
