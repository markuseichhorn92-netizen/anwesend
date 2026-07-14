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
 *   GET  -> { ok, available, onboarded, profile, targets, today:{date,entries,totals,water,waterGoal}, streak, pointsToday }
 *
 *   POST { action:'save-profile', profile:{goal,sex,height,weight,age,activity,diet} }
 *   POST { action:'log', text }                 -> KI schätzt kcal/Makros -> Einträge
 *   POST { action:'log-manual', name,kcal,p,c,f } (Schnell-Favorit)
 *   POST { action:'delete', id }
 *   POST { action:'water', delta|set }
 *   POST { action:'recipes', wish? }            -> 3 KI-Rezepte (nicht gespeichert)
 *   POST { action:'coach', question, history? } -> FINN-Antwort
 *   POST { action:'coaching-request' }          -> Inbox-Vorgang „Stoffwechsel-Coaching" + Studio-Mail
 *
 * Ohne KV (hasStore=false) meldet GET available:false und die UI blendet das
 * Modul aus. Es wird nie geworfen.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const { redisPipeline, hasStore } = require('../../lib/store');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');

const PKEY = (id) => 'nutri:p:' + String(id);
const DKEY = (id, d) => 'nutri:d:' + String(id) + ':' + d;
const FASTKEY = (id) => 'nutri:fast:' + String(id);
const PLANKEY = (id) => 'nutri:plan:' + String(id);
const SHOPKEY = (id) => 'nutri:shop:' + String(id);
const RECKEY = (id) => 'nutri:rec:' + String(id);
const DAY_TTL = 400 * 86400;              // ~13 Monate

const FAST_PLANS = { '16:8': 16, '18:6': 18, '14:10': 14 };

const GOALS = { abnehmen: 'Abnehmen', halten: 'Gewicht halten', aufbau: 'Muskelaufbau' };
const ACTS = { kaum: 1.35, moderat: 1.55, aktiv: 1.75 };
const DIETS = ['omnivor', 'vegetarisch', 'vegan', 'lowcarb', 'highprotein'];

function n0(v) { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; }
function clamp(v, lo, hi, def) { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(lo, Math.min(hi, n)); }

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

// ── Zielwerte (Mifflin-St-Jeor + Aktivitätsfaktor + Ziel-Offset) ──
function targetsFor(p) {
  p = p || {};
  const sex = p.sex === 'm' ? 'm' : 'w';
  const weight = clamp(p.weight, 35, 250, 70);
  const height = clamp(p.height, 120, 230, 170);
  const age = clamp(p.age, 14, 100, 30);
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'm' ? 5 : -161);
  const factor = ACTS[p.activity] || 1.55;
  let kcal = bmr * factor + ({ abnehmen: -450, halten: 0, aufbau: 300 }[p.goal] || 0);
  kcal = Math.max(1200, Math.round(kcal / 10) * 10);
  const protein = Math.round((p.goal === 'aufbau' ? 2.0 : 1.8) * weight);
  const fat = Math.round(0.9 * weight);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const water = Math.round(weight * 0.035 * 10) / 10;
  return { kcal, protein, carbs, fat, water };
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
async function buildState(id, profile) {
  const { date } = berlinNow();
  const onboarded = !!(profile && profile.onboarded);
  const targets = targetsFor(profile || {});
  const day = await loadDay(id, date);
  const totals = totalsOf(day.entries);
  const streak = await computeStreak(id, date);
  const fasting = await loadFasting(id);
  return {
    ok: true, available: true, onboarded: onboarded,
    profile: profile ? { goal: profile.goal, sex: profile.sex, height: profile.height, weight: profile.weight, age: profile.age, activity: profile.activity, diet: profile.diet } : null,
    targets: targets,
    today: { date, entries: day.entries, totals, water: day.water, waterGoal: waterGoalCups(targets) },
    streak: streak,
    pointsToday: pointsToday(totals, targets, day.entries.length, streak),
    fasting: fasting,
  };
}

function newEntryId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

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

  // ── Eintrag per Freitext (KI-Schätzung) ──
  if (action === 'log') {
    const text = String(body.text || '').trim();
    if (text.length < 2) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [] }))); }
    if (!(await M.rateLimit('nutri-log:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [], message: 'Kurz durchatmen – gleich wieder versuchen.' }))); }
    const est = await AI.estimateFood(text);
    if (!est.ok || !est.items.length) {
      res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [], message: est.ok ? 'Ich konnte kein Lebensmittel erkennen – beschreib es etwas genauer.' : 'FINN kann gerade nicht schätzen. Versuch es gleich nochmal.' })));
    }
    const day = await loadDay(id, date);
    const meal = mealForHour(hour);
    const added = est.items.map(function (it) { return { id: newEntryId(), name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, ts: Date.now() }; });
    day.entries = day.entries.concat(added);
    await saveDay(id, date, day);
    try { require('../../lib/handled').record('ai', id, 'nutri'); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: added.map(function (a) { return { name: a.name, kcal: a.kcal }; }) })));
  }

  // ── Eintrag per FOTO (KI-Vision-Schätzung) ──
  if (action === 'log-photo') {
    if (!(await M.rateLimit('nutri-photo:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [], message: 'Kurz durchatmen – gleich wieder versuchen.' }))); }
    const b64 = String(body.base64 || '');
    if (b64.length < 100) { res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [], message: 'Kein Foto empfangen.' }))); }
    const est = await AI.estimateFoodPhoto(b64, body.mediaType);
    if (!est.ok || !est.items.length) {
      res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [], message: est.ok ? 'Auf dem Foto konnte ich kein Lebensmittel erkennen – versuch es mit einer Texteingabe.' : 'FINN kann das Foto gerade nicht auswerten. Versuch es gleich nochmal.' })));
    }
    const day = await loadDay(id, date);
    const meal = mealForHour(hour);
    const added = est.items.map(function (it) { return { id: newEntryId(), name: it.name, portion: it.portion, kcal: it.kcal, p: it.p, c: it.c, f: it.f, meal: meal, ts: Date.now() }; });
    day.entries = day.entries.concat(added);
    await saveDay(id, date, day);
    try { require('../../lib/handled').record('ai', id, 'nutri-photo'); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: added.map(function (a) { return { name: a.name, kcal: a.kcal }; }) })));
  }

  // ── Schnell-Favorit (feste Nährwerte) ──
  if (action === 'log-manual') {
    if (!(await M.rateLimit('nutri-log:' + id, 40, 3600))) { res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile))); }
    const name = String(body.name || 'Snack').slice(0, 80).trim() || 'Snack';
    const entry = { id: newEntryId(), name, portion: String(body.portion || '').slice(0, 40), kcal: n0(body.kcal), p: n0(body.p), c: n0(body.c), f: n0(body.f), meal: mealForHour(hour), ts: Date.now() };
    const day = await loadDay(id, date);
    day.entries.push(entry);
    await saveDay(id, date, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [{ name: entry.name, kcal: entry.kcal }] })));
  }

  // ── Eintrag löschen ──
  if (action === 'delete') {
    const eid = String(body.id || '');
    const day = await loadDay(id, date);
    day.entries = day.entries.filter(function (e) { return String(e.id) !== eid; });
    await saveDay(id, date, day);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile)));
  }

  // ── Wasser (Gläser à 0,25 l) ──
  if (action === 'water') {
    const day = await loadDay(id, date);
    const goal = waterGoalCups(targetsFor(profile || {}));
    let cups = day.water;
    if (body.set != null) cups = n0(body.set);
    else cups = (day.water || 0) + (parseInt(body.delta, 10) || 0);
    day.water = Math.max(0, Math.min(goal + 4, cups));
    await saveDay(id, date, day);
    res.statusCode = 200; return res.end(JSON.stringify(await buildState(id, profile)));
  }

  // ── KI-Rezepte (nicht gespeichert) ──
  if (action === 'recipes') {
    if (!(await M.rateLimit('nutri-recipes:' + id, 20, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    const fridge = String(body.fridge || '').trim().slice(0, 200);
    const wish = fridge ? ('Nutze möglichst nur diese vorhandenen Zutaten: ' + fridge) : body.wish;
    const r = await AI.nutritionRecipes({ goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: (profile && profile.diet) || 'omnivor', wish: wish });
    res.statusCode = 200; return res.end(JSON.stringify(r.ok ? { ok: true, recipes: r.recipes } : { ok: false, message: 'FINN kann gerade keine Rezepte erstellen. Versuch es gleich nochmal.' }));
  }

  // ── FINN Ernährungscoach ──
  if (action === 'coach') {
    const question = String(body.question || '').trim();
    if (question.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN ist gerade nicht verfügbar.' })); }
    if (!(await M.rateLimit('nutri-coach:' + id, 30, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    let m = null; try { m = await M.getMember(id); } catch (e) {}
    const t = targetsFor(profile || {});
    const day = await loadDay(id, date);
    const totals = totalsOf(day.entries);
    const r = await AI.nutritionReply(
      { firstName: (m && m.firstName) || '', goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, eatenKcal: totals.kcal, eatenP: totals.p },
      Array.isArray(body.history) ? body.history : [], question);
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
    if (!(await M.rateLimit('nutri-plan:' + id, 10, 3600))) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kurz durchatmen – gleich wieder versuchen.' })); }
    const t = targetsFor(profile || {});
    const r = await AI.nutritionWeekPlan({ goal: GOALS[profile && profile.goal] || 'ausgewogen', kcalTarget: t.kcal, protein: t.protein, diet: (profile && profile.diet) || 'omnivor' });
    if (!r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'FINN kann gerade keinen Plan erstellen. Versuch es gleich nochmal.' })); }
    const plan = { days: r.days, createdAt: Date.now() };
    const shop = (r.shopping || []).map(function (s, i) { return { i: i, name: s.name, amount: s.amount, checked: false }; });
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
    const clean = { id: newEntryId(), title: String(rp.title || 'Rezept').slice(0, 100), kcal: n0(rp.kcal), protein: n0(rp.protein), minutes: n0(rp.minutes), ingredients: (Array.isArray(rp.ingredients) ? rp.ingredients : []).slice(0, 15).map(function (x) { return String(x).slice(0, 90); }), steps: (Array.isArray(rp.steps) ? rp.steps : []).slice(0, 8).map(function (x) { return String(x).slice(0, 200); }) };
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
    const rp = body.recipe || {};
    const entry = { id: newEntryId(), name: String(rp.title || 'Rezept').slice(0, 80), portion: '1 Portion', kcal: n0(rp.kcal), p: n0(rp.protein), c: n0(rp.carbs), f: n0(rp.fat), meal: mealForHour(hour), ts: Date.now() };
    const day = await loadDay(id, date); day.entries.push(entry); await saveDay(id, date, day);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign(await buildState(id, profile), { added: [{ name: entry.name, kcal: entry.kcal }] })));
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
    if (AI.hasAI && tracked > 0 && (await M.rateLimit('nutri-week:' + id, 12, 3600))) {
      const r = await AI.nutritionWeekReview({ goal: GOALS[profile && profile.goal] || '—', kcalTarget: target, protein: t.protein, days: trackedDays.map(function (d) { return { date: d.date.slice(5), kcal: d.kcal, p: d.p }; }), inGoal: inGoal, avgKcal: avgKcal, proteinDays: proteinDays, tracked: tracked });
      if (r.ok) review = { tip: r.tip, insights: r.insights };
    }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, days: days, target: target, stats: { inGoal: inGoal, avgKcal: avgKcal, proteinDays: proteinDays, tracked: tracked }, review: review }));
  }

  res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
