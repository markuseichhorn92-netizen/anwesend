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
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Quota = require('../../lib/nutriquota');
const { hasStore } = require('../../lib/store');

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
  return {
    ok: true, available: true,
    tip: T.tipOfDay(today),
    inspiration: T.INSPIRATION,
    plans: T.getLibrary().map(T.trimPlan),
    goals: T.GOALS, levels: T.LEVELS, locations: T.LOCATIONS,
    myPlan: active ? { plan: active.plan, startedAt: active.startedAt, source: active.plan.source } : null,
    premium: !!tier.premium, aiAvailable: !!AI.hasAI,
    quota: Quota.publicQuota(qUsed, tier.premium, qMonth),
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
      if (!premium && !(await Quota.canUse(id, month))) {
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
      // KI-Aktion erst nach Erfolg abbuchen. Der Monatszähler zählt für ALLE hoch
      // (auch Premium, damit die Nutzungsübersicht stimmt); gedeckelt wird nur Basic.
      const used = await Quota.incr(id, month);
      return j(res, 200, { ok: true, plan: plan, quota: Quota.publicQuota(used, premium, month) });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
