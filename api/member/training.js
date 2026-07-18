'use strict';

/**
 * GET/POST /api/member/training   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * Der Training-Tab im Coach: Trainingstipp, Inspiration, kuratierte
 * Trainingsplan-Bibliothek und „Mein Plan". FINN kann zusätzlich einen
 * personalisierten Plan generieren (Premium bzw. Gratis-Kontingent).
 *
 *  GET                      -> Tipp, Inspiration, Bibliothek (schlank), mein Plan, Premium/Quota
 *  POST { action }:
 *    plan-start   {planId}  -> kuratierten Plan als „meinen Plan" setzen
 *    plan-start-custom {plan}-> generierten Plan als „meinen Plan" speichern
 *    plan-stop              -> meinen Plan beenden
 *    plan-detail  {planId}  -> vollständigen Bibliotheks-Plan liefern
 *    generate     {…}       -> FINN erstellt einen Plan (KI, gated)
 *
 * Datenmodell/Keys leben in lib/training.js (train:active:<id>). Ohne Store:
 * available:false. FINN-Generierung nur mit KI-Schlüssel; Gating serverseitig.
 */

const M = require('../../lib/members');
const T = require('../../lib/training');
const Ex = require('../../lib/exercises');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Quota = require('../../lib/nutriquota');
const Welcome = require('../../lib/welcomeGift');
const Profile = require('../../lib/memberProfile');
const { hasStore, redisPipeline } = require('../../lib/store');

// ── Trainings-Vitalpunkte: abgeschlossene Einheiten zahlen in denselben Punkte-/Rang-Topf
//    wie Check-ins & Ernährung. Ledger als JSON-Map {date:pts} (formatsicher, ein Read/Write).
const VPKEY = (id) => 'train:vp:' + String(id);
async function loadVpMap(id) {
  try { const [r] = await redisPipeline([['GET', VPKEY(id)]]); const o = r ? JSON.parse(r) : {}; return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}
function vpLedgerFrom(map) {
  const out = [];
  Object.keys(map || {}).forEach(function (d) { const p = parseInt(map[d], 10) || 0; if (p > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d)) out.push({ date: d, pts: p }); });
  out.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return out.slice(0, 120);
}
async function saveVpDay(id, date, pts) {
  try {
    const map = await loadVpMap(id);
    const prev = parseInt(map[date], 10) || 0;
    if (pts <= prev) return prev;               // pro Tag den besten Wert behalten (kein Doppelzählen)
    map[date] = pts;
    const keys = Object.keys(map).filter(function (k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); }).sort();
    while (keys.length > 140) { delete map[keys.shift()]; }
    await redisPipeline([['SET', VPKEY(id), JSON.stringify(map), 'EX', String(220 * 86400)]]);
    return pts;
  } catch (e) { return pts; }
}
// Vitalpunkte fürs Training: moderat, gedeckelt. ~10 je protokollierter Übung + 40 fürs Abschließen.
function trainVpFor(doneCount, finished) { let vp = (doneCount | 0) * 10 + (finished ? 40 : 0); if (vp < 0) vp = 0; if (vp > 150) vp = 150; return vp; }
// kcal-Schätzung (ehrlich „ca.“): MET × Körpergewicht × Stunden. Kraft gemischt ~5,5 MET.
function kcalFor(durationSec, weightKg, met) { const hrs = Math.max(0, Math.min(3, (durationSec || 0) / 3600)); const w = (weightKg && weightKg > 0) ? weightKg : 75; return Math.round((met || 5.5) * w * hrs); }

// ── Trainings-Session (heutige Einheit abhaken / Sätze protokollieren) ──
const SKEY = (id, date) => 'train:sess:' + String(id) + ':' + date;
function cleanStr(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 24); }
async function loadSession(id, date) {
  try { const [r] = await redisPipeline([['GET', SKEY(id, date)]]); if (!r) return null; const o = JSON.parse(r); return (o && o.items) ? o : null; } catch (e) { return null; }
}
async function saveSession(id, date, sess) {
  try { await redisPipeline([['SET', SKEY(id, date), JSON.stringify({ planId: sess.planId, items: sess.items || {} }), 'EX', String(120 * 86400)]]); return true; } catch (e) { return false; }
}

// ── Split-Rotation: A -> B -> C -> wieder A ──
// Merkt sich den zuletzt ABGESCHLOSSENEN Plan-Tag; der nächste Tag ist dann
// „heute dran" – egal, wie viele Kalendertage dazwischen liegen.
const RKEY = (id) => 'train:rot:' + String(id);
async function loadRot(id) {
  try { const [r] = await redisPipeline([['GET', RKEY(id)]]); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
async function saveRot(id, rot) {
  try { await redisPipeline([['SET', RKEY(id), JSON.stringify(rot), 'EX', String(180 * 86400)]]); } catch (e) {}
}

// ── Trainings-Verlauf: abgeschlossene Einheiten protokollieren (für die FINN-Progression) ──
// Kompakte Liste pro Mitglied (neueste zuerst), gedeckelt. Basis, aus der FINN die
// nächste Steigerung ableitet.
const HKEY = (id) => 'train:hist:' + String(id);
async function appendHist(id, plan, di, sessn, date) {
  try {
    const dayDef = (plan.days || [])[di] || {};
    const exs = (dayDef.exercises || []).map(function (e, i) {
      const it = (sessn.items || {})['d' + di + 'e' + i] || {};
      return { n: String((e && e.name) || '').slice(0, 40), s: (it.sets | 0), bio: !!(e && e.bio) };
    });
    const entry = { t: date, day: di, title: String(dayDef.name || ('Tag ' + (di + 1))).slice(0, 40), ex: exs };
    await redisPipeline([['LPUSH', HKEY(id), JSON.stringify(entry)], ['LTRIM', HKEY(id), '0', '39'], ['EXPIRE', HKEY(id), String(220 * 86400)]]);
  } catch (e) {}
}
async function loadHist(id, n) {
  try {
    const [r] = await redisPipeline([['LRANGE', HKEY(id), '0', String((n || 24) - 1)]]);
    if (!Array.isArray(r)) return [];
    return r.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
// Aktuellen Plan + Verlauf als kompakten Text für den FINN-Progressions-Prompt.
function planSummaryText(p) {
  const days = (p.days || []).map(function (d) {
    const ex = (d.exercises || []).map(function (e) { return (e.name || '') + (e.bio ? ' (Biostrength)' : (e.sets ? (' ' + e.sets + '×' + (e.reps || '')) : '')); }).join(', ');
    return (d.name || 'Tag') + ': ' + ex;
  }).join(' | ');
  return (p.title || 'Plan') + ' — ' + days;
}
function histSummaryText(hist) {
  // hist ist neueste→älteste (LPUSH) -> für den Prompt umdrehen.
  return hist.slice().reverse().map(function (h) {
    const ex = (h.ex || []).map(function (e) { return e.n + (e.bio ? '✓' : (e.s ? (' ' + e.s + 'S') : '')); }).join(', ');
    return h.t + ' ' + (h.title || '') + ': ' + ex;
  }).join(' | ');
}
// Welcher Plan-Tag ist heute dran? Ein heute bereits angefangener Tag hat
// Vorrang, ein heute abgeschlossener bleibt stehen (Erfolgsansicht), sonst
// rotiert es auf den Tag NACH dem zuletzt abgeschlossenen. Planwechsel setzt
// die Rotation automatisch zurück (planId-Abgleich).
function todayDayFor(active, sessn, rot, today) {
  const len = (active && active.plan && active.plan.days && active.plan.days.length) || 0;
  if (!len) return 0;
  const items = (sessn && sessn.items) || {};
  for (const k of Object.keys(items)) {
    const m = /^d(\d+)e/.exec(k);
    if (m && (items[k].done || (items[k].sets | 0) > 0)) return parseInt(m[1], 10) % len;
  }
  if (rot && rot.planId === active.plan.id && typeof rot.day === 'number') {
    if (rot.date === today) return rot.day % len;
    return (rot.day + 1) % len;
  }
  return 0;
}

const PREMIUM_MSG = 'Mit Premium erstellt dir FINN unbegrenzt persönliche Trainingspläne.';
const QUOTA_MSG = 'Dein Gratis-Kontingent für FINN ist diesen Monat aufgebraucht. Mit Premium geht’s unbegrenzt weiter – oder du nutzt die fertigen Pläne aus der Bibliothek.';

function berlinDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

// Zustand für GET / nach jeder Mutation.
async function readState(id) {
  const today = berlinDate();
  const tier = Ent.publicTier(await Ent.getEntitlement(id));
  const qMonth = Quota.monthOf(today);
  const qUsed = await Quota.getUsed(id, qMonth);
  const active = await T.resolveActive(id);
  let todayDay = 0;
  if (active) {
    const [sessn, rot] = await Promise.all([loadSession(id, today), loadRot(id)]);
    todayDay = todayDayFor(active, (sessn && sessn.planId === active.plan.id) ? sessn : null, rot, today);
  }
  const vpMap = await loadVpMap(id);
  return {
    ok: true, available: true,
    tip: T.tipOfDay(today),
    inspiration: T.INSPIRATION,
    plans: T.getLibrary().map(T.trimPlan),
    exercises: Ex.publicList(), exerciseGroups: Ex.GROUPS, exerciseMuscles: Ex.MUSCLES,
    goals: T.GOALS, levels: T.LEVELS, locations: T.LOCATIONS,
    myPlan: active ? { plan: active.plan, startedAt: active.startedAt, source: active.plan.source, todayDay: todayDay } : null,
    premium: !!tier.premium, aiAvailable: !!AI.hasAI,
    quota: Quota.publicQuota(qUsed, tier.premium, qMonth),
    vitalLedger: vpLedgerFrom(vpMap),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const id = sess.id;

  if (req.method === 'GET') {
    try { return j(res, 200, await readState(id)); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');

  try {
    // Übungsdatenbank durchsuchen (Freitext + Muskelgruppe). Server-Fallback –
    // der Client filtert die Liste ohnehin lokal aus dem GET-Payload.
    if (action === 'exercise-search') {
      return j(res, 200, { ok: true, exercises: Ex.search(body.q, { group: body.group, bio: !!body.bio }) });
    }

    // Trainings-Session: heutige Einheit abhaken / Sätze protokollieren.
    // Biostrength-Übungen werden nur „done" gesetzt, andere zusätzlich mit „sets".
    if (action === 'session-get' || action === 'session-set' || action === 'session-reset') {
      const date = berlinDate();
      const active = await T.resolveActive(id);
      if (!active) return j(res, 200, { ok: true, available: true, active: false, date: date, items: {} });
      let sess = await loadSession(id, date);
      if (!sess || sess.planId !== active.plan.id) sess = { planId: active.plan.id, items: {} };
      if (action === 'session-set') {
        const key = cleanStr(body.key, 16);
        if (key) {
          const it = sess.items[key] || { done: false, sets: 0 };
          if (body.done != null) it.done = !!body.done;
          if (body.sets != null) { let n = parseInt(body.sets, 10); if (isNaN(n) || n < 0) n = 0; if (n > 20) n = 20; it.sets = n; }
          // Detailliertes Satz-Protokoll (Gewicht/Wdh./Pause) für Nicht-KI-Geräte.
          if (Array.isArray(body.entries)) {
            it.entries = body.entries.slice(0, 20).map(function (en) {
              en = en || {};
              let w = parseFloat(en.w); if (!isFinite(w) || w < 0) w = 0; if (w > 1000) w = 1000;
              let reps = parseInt(en.reps, 10); if (!isFinite(reps) || reps < 0) reps = 0; if (reps > 200) reps = 200;
              let rest = parseInt(en.rest, 10); if (!isFinite(rest) || rest < 0) rest = 0; if (rest > 3600) rest = 3600;
              return { w: Math.round(w * 10) / 10, reps: reps, rest: rest };
            });
            it.sets = it.entries.length;   // Satz-Zähler = Anzahl protokollierter Sätze
          }
          sess.items[key] = it; await saveSession(id, date, sess);
          // Tag komplett abgehakt? -> Rotations-Marker setzen (nächstes Mal ist der Folgetag dran).
          const dm = /^d(\d+)e/.exec(key);
          if (dm) {
            const di = parseInt(dm[1], 10);
            const dayDef = (active.plan.days || [])[di];
            const exN = (dayDef && dayDef.exercises && dayDef.exercises.length) || 0;
            let doneN = 0;
            for (let i = 0; i < exN; i++) { const d2 = sess.items['d' + di + 'e' + i]; if (d2 && d2.done) doneN++; }
            if (exN > 0 && doneN === exN) { await saveRot(id, { planId: active.plan.id, day: di, date: date }); await appendHist(id, active.plan, di, sess, date); }
          }
        }
      } else if (action === 'session-reset') {
        sess = { planId: active.plan.id, items: {} }; await saveSession(id, date, sess);
      }
      return j(res, 200, { ok: true, available: true, active: true, date: date, planId: sess.planId, items: sess.items });
    }

    // Einheit abschließen: Vitalpunkte gutschreiben, kcal schätzen, (Premium) FINN-Einschätzung.
    // Setzt außerdem Rotations-Marker + Verlauf (auch ohne dass jede Übung abgehakt wurde).
    if (action === 'session-finish') {
      const date = berlinDate();
      const active = await T.resolveActive(id);
      if (!active || !active.plan) return j(res, 200, { ok: false, error: 'no_plan', message: 'Kein aktiver Plan.' });
      let sn = await loadSession(id, date);
      if (!sn || sn.planId !== active.plan.id) sn = { planId: active.plan.id, items: {} };
      const len = ((active.plan.days || []).length) || 1;
      let di = parseInt(body.day, 10); if (isNaN(di) || di < 0) di = 0; if (di >= len) di = len - 1;
      const dayDef = (active.plan.days || [])[di] || {};
      const exs = dayDef.exercises || [];
      const isTouched = function (i) { const it = sn.items['d' + di + 'e' + i]; return !!(it && (it.done || (it.sets | 0) > 0 || (Array.isArray(it.entries) && it.entries.length))); };
      let doneCount = 0; const doneNames = [];
      for (let i = 0; i < exs.length; i++) { if (isTouched(i)) { doneCount++; doneNames.push(String((exs[i] && exs[i].name) || '').slice(0, 40)); } }
      let durSec = parseInt(body.durationSec, 10); if (isNaN(durSec) || durSec < 0) durSec = 0; if (durSec > 4 * 3600) durSec = 4 * 3600;
      let weightKg = 75; try { const prof = await Profile.get(id); if (prof && prof.weightKg) weightKg = prof.weightKg; } catch (e) {}
      const kcal = kcalFor(durSec, weightKg, 5.5);
      const vp = trainVpFor(doneCount, true);
      const vpAwarded = await saveVpDay(id, date, vp);
      try { await saveRot(id, { planId: active.plan.id, day: di, date: date }); await appendHist(id, active.plan, di, sn, date); } catch (e) {}
      // FINN-Einschätzung nur für Premium (kostenfreies Extra, kein Kontingent-Verbrauch).
      let finn = '';
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      if (premium && AI.hasAI && doneCount > 0) {
        try {
          const r = await AI.trainingSummary({
            firstName: (sess && sess.firstName) || '',
            dayTitle: String(dayDef.name || 'Training'), goal: active.plan.goal || '',
            durationMin: Math.round(durSec / 60), exercises: doneNames, vp: vp, kcal: kcal,
          });
          if (r && r.ok && r.text) finn = r.text;
        } catch (e) {}
      }
      return j(res, 200, { ok: true, date: date, vp: vp, vpAwarded: vpAwarded, kcal: kcal, durationMin: Math.round(durSec / 60), exercisesDone: doneCount, exercisesTotal: exs.length, premium: premium, finn: finn });
    }

    // Vollständigen Bibliotheks-Plan liefern (für die Detailansicht).
    if (action === 'plan-detail') {
      const p = T.getById(body.planId);
      if (!p) return j(res, 200, { ok: false, error: 'not_found' });
      return j(res, 200, { ok: true, plan: Object.assign({}, p, { source: 'library' }) });
    }

    // Kuratierten Plan als „meinen Plan" setzen.
    if (action === 'plan-start') {
      const p = T.getById(body.planId);
      if (!p) return j(res, 200, { ok: false, error: 'not_found' });
      await T.saveActive(id, { source: 'library', planId: p.id, startedAt: Date.now() });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // FINN-Plan (oder anderen Custom-Plan) als „meinen Plan" speichern.
    if (action === 'plan-start-custom') {
      const norm = T.normalizePlan(body.plan, 'finn');
      if (!norm) return j(res, 200, { ok: false, error: 'invalid_plan' });
      await T.saveActive(id, { source: 'finn', plan: norm, startedAt: Date.now() });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Meinen Plan beenden.
    if (action === 'plan-stop') {
      await T.clearActive(id);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // FINN generiert einen personalisierten Plan (KI). Gated: Premium unbegrenzt,
    // sonst Gratis-Kontingent (lib/nutriquota, gemeinsamer Monatszähler).
    if (action === 'generate') {
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar – schau in der Bibliothek vorbei.' });
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      const month = Quota.monthOf(berlinDate());
      // „Erster Plan aufs Haus": einmalig gratis, ohne Premium und ohne Kontingent-Verbrauch.
      // Nur PRÜFEN (nicht verbrauchen) – eingelöst wird erst nach erfolgreicher Generierung.
      const welcomeFree = !!body.welcome && (await Welcome.available(id, 'train'));
      if (!welcomeFree && !premium && !(await Quota.canUse(id, month))) {
        return j(res, 200, { ok: false, error: 'premium_required', quota: 'exhausted', message: QUOTA_MSG });
      }
      const r = await AI.trainingPlan({
        goal: T.GOALS[body.goal] ? body.goal : 'ganzkoerper',
        level: T.LEVELS[body.level] ? body.level : 'mittel',
        daysPerWeek: body.days || body.daysPerWeek,
        location: T.LOCATIONS[body.location] ? body.location : 'studio',
        equipment: body.equipment,
        focus: body.focus,
        note: body.note,
        firstName: (sess && sess.firstName) || '',
        equipmentContext: T.STUDIO_EQUIPMENT,
      });
      if (!r.ok || !r.plan) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte versuch es gleich noch einmal.' });
      const plan = T.normalizePlan(r.plan, 'finn');
      if (!plan) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte versuch es gleich noch einmal.' });
      // Erst JETZT (nach Erfolg) das Geschenk einlösen bzw. das Kontingent abbuchen –
      // ein fehlgeschlagener Versuch verbraucht so weder Geschenk noch Kontingent.
      if (welcomeFree) { try { await Welcome.consume(id, 'train'); } catch (e) {} }
      const used = welcomeFree ? await Quota.getUsed(id, month) : await Quota.incr(id, month);
      return j(res, 200, { ok: true, plan: plan, quota: Quota.publicQuota(used, premium, month), welcome: welcomeFree });
    }

    // FINN plant die NÄCHSTE Steigerung aus dem Trainingsprotokoll (Premium/Kontingent).
    if (action === 'progress') {
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      const active = await T.resolveActive(id);
      if (!active || !active.plan) return j(res, 200, { ok: false, error: 'no_plan', message: 'Du hast noch keinen aktiven Plan – wähle oder erstelle zuerst einen.' });
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      const month = Quota.monthOf(berlinDate());
      if (!premium && !(await Quota.canUse(id, month))) {
        return j(res, 200, { ok: false, error: 'premium_required', quota: 'exhausted', message: 'Die automatische Progression ist eine Premium-Funktion. Mit Premium plant FINN deinen Fortschritt aus deinen Einheiten.' });
      }
      const hist = await loadHist(id, 24);
      if (hist.length < 2) return j(res, 200, { ok: false, error: 'no_history', message: 'Protokolliere zuerst ein paar Einheiten – dann plant FINN daraus die nächste Steigerung.' });
      const r = await AI.trainingPlan({
        goal: active.plan.goal || 'ganzkoerper', level: active.plan.level || 'mittel',
        daysPerWeek: (active.plan.days || []).length || 3,
        location: active.plan.location || 'studio', equipment: active.plan.equipment,
        firstName: (sess && sess.firstName) || '', equipmentContext: T.STUDIO_EQUIPMENT,
        progression: { planText: planSummaryText(active.plan), historyText: histSummaryText(hist) },
      });
      if (!r.ok || !r.plan) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      const plan = T.normalizePlan(r.plan, 'finn');
      if (!plan) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      const used = await Quota.incr(id, month);
      return j(res, 200, { ok: true, plan: plan, progression: true, basedOn: hist.length, quota: Quota.publicQuota(used, premium, month) });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
