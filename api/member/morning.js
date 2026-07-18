'use strict';

/**
 * GET/POST /api/member/morning   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * Morgen-Check mit dem Polar-H9-Brustgurt: Trainingsbereitschaft aus Ruhepuls
 * (und – falls ein stabiler R-R-Stream ankommt – HRV) gegen die persönliche
 * Baseline. Der Client misst live per Bluetooth und schickt die abgeleiteten
 * Werte; Bewertung (Ampel), Baseline und Verlauf werden serverseitig berechnet.
 * Die Daten fließen in FINN (coach.js) und in die FINN-Einschätzung.
 *
 *  GET                              -> { ok, available, premium, consent, list, latest, baseline, eval, readiness, trend, ... }
 *  POST { action:'consent', value } -> Einwilligung setzen (true=Premium) / widerrufen (false=löscht Daten)
 *  POST { action:'save', measurement } -> Messung speichern (Premium + Einwilligung)
 *  POST { action:'delete', sel }    -> Messung (date/ts) löschen
 *  POST { action:'assess' }         -> FINN-Einschätzung (Premium)
 *
 * KOMPLETT PREMIUM: Messen/Auswerten nur mit Coach Premium. Herz-/HRV-Werte sind
 * Gesundheitsdaten (DSGVO Art. 9) -> ausdrückliche Einwilligung, jederzeit
 * widerrufbar (löscht die Daten). Kein Medizinprodukt: Wellness-Signal, keine Diagnose.
 * Ohne KV-Store: available:false.
 */

const M = require('../../lib/members');
const MO = require('../../lib/morning');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Coaching = require('../../lib/coaching');
const Training = require('../../lib/training');
const { hasStore } = require('../../lib/store');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

const PREMIUM_MSG = 'Der Vital-Check (Bereitschaft, HRV & Trainingssteuerung) ist ein Coach-Premium-Feature.';

async function readState(id) {
  const list = await MO.list(id);
  let consent = false; try { consent = await MO.getConsent(id); } catch (e) {}
  let teamShare = false; try { teamShare = await MO.getTeamShare(id); } catch (e) {}
  let age = 0; try { const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; age = Number(prof.age) || 0; } catch (e) {}
  const tier = Ent.publicTier(await Ent.getEntitlement(id));
  const base = MO.baseline(list);
  const latest = list[0] || null;
  const readiness = latest ? MO.readiness(latest, base) : null;
  const trList = await MO.trList(id);
  const trLatest = trList[0] || null;
  return {
    ok: true, available: true,
    premium: !!tier.premium, tier: tier.tier, trialing: tier.trialing,
    consent: consent,
    teamShare: teamShare,
    list: list,
    latest: latest,
    baseline: base,
    eval: latest ? MO.evaluate(latest, base) : [],
    readiness: readiness,
    balance: latest ? MO.balance(latest, base) : null,
    bioAge: latest ? MO.hrvAge(latest, age, base) : null,
    bioAgeSeries: MO.hrvAgeSeries(list),
    zones: MO.trainingZones(age),
    trainingLoad: readiness ? MO.trainingLoad(readiness, latest) : null,
    insights: MO.insights(list),
    overtraining: MO.overtraining(list),
    weekly: MO.weeklyReport(list),
    trend: MO.trend(list),
    minCalib: MO.MIN_CALIB,
    vitalLedger: MO.vpLedger(list).concat(MO.vpLedgerTraining(trList)),
    // Trainings-Check-in (kurzer Puls-Check vorm Workout) – gegen die Morgen-Baseline.
    training: {
      list: trList,
      latest: trLatest,
      readiness: trLatest ? MO.trainReadiness(trLatest, base) : null,
      hasBaseline: base.rhr != null || base.hrv != null,
    },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const id = sess.id;

  if (req.method === 'GET') {
    try { return j(res, 200, await readState(id)); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  if (!(await M.rateLimit('morning:' + id, 60, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });
  const body = await M.readBody(req);
  const action = String((body && body.action) || '');

  try {
    const premium = Ent.isPremium(await Ent.getEntitlement(id));

    // Einwilligung. Widerruf (value:false) ist IMMER erlaubt (DSGVO) und löscht die Messwerte.
    if (action === 'consent') {
      const on = body.value === true || body.value === 'true' || body.value === 1;
      if (on && !premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      await MO.setConsent(id, on);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Messung speichern (Premium + Einwilligung nötig). Morgen-Check-in ODER
    // kurzer Trainings-Check-in (measurement.kind === 'training').
    if (action === 'save') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte stimme zuerst der Verarbeitung deiner Herzdaten zu.' });
      const meas = body.measurement || {};
      const isTrain = meas.kind === 'training';
      const r = isTrain ? await MO.trAdd(id, meas, Date.now()) : await MO.add(id, meas, Date.now());
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'save_failed', message: 'Es kam kein verwertbarer Messwert an. Miss bitte ruhig und versuch es erneut.' });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Trainer-Freigabe der Bereitschaft (Opt-in). Einschalten nur mit bestehender Einwilligung.
    if (action === 'teamshare') {
      const on = body.value === true || body.value === 'true' || body.value === 1;
      if (on && !(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Aktiviere zuerst den Vital-Check.' });
      await MO.setTeamShare(id, on);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Messung löschen (immer erlaubt – eigene Daten). scope:'training' -> Trainings-Check-in.
    if (action === 'delete') {
      const sel = body.sel != null ? body.sel : body.date;
      if (body.scope === 'training') await MO.trRemove(id, sel);
      else await MO.remove(id, sel);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // FINN-Einschätzung zum Morgen-Check (Premium).
    if (action === 'assess') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: 'Die FINN-Einschätzung ist Teil von Coach Premium.' });
      const list = await MO.list(id);
      if (!list.length) return j(res, 200, { ok: false, error: 'no_data', message: 'Miss zuerst deinen Morgen-Check.' });
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      const m = list[0]; const base = MO.baseline(list); const t = MO.trend(list);
      const bal = MO.balance(m, base); const ba = MO.hrvAge(m, 0, base);
      let firstName = '', goal = '', age = 0, plannedTraining = '';
      try { const mem = await M.getMember(id); firstName = (mem && mem.firstName) || ''; } catch (e) {}
      try { const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; goal = prof.goal || ''; age = Number(prof.age) || 0; } catch (e) {}
      try { const act = await Training.resolveActive(id); if (act && act.plan) plannedTraining = act.plan.title || ''; } catch (e) {}
      const r = await AI.coachMorningCheck({
        firstName: firstName, goal: goal,
        rhr: m.rhr, rhrBaseline: base.rhr, hrv: m.hrvRmssd, hrvBaseline: base.hrv, sdnn: m.hrvSdnn,
        balance: (bal && bal.value != null) ? bal.value : null, balanceLabel: (bal && bal.value != null) ? bal.label : '',
        respRate: m.respRate, orthostatic: m.orthostaticDelta,
        sleepSelf: m.sleepSelf, sleepHours: m.sleepHours, moodSelf: m.moodSelf, stressSelf: m.stressSelf, soreness: m.soreness, sick: m.sick,
        trendRhr: (t && t.sincePrev) ? t.sincePrev.rhr : null,
        plannedTraining: plannedTraining, calibrating: base.calibrating,
        under18: age > 0 && age < 18,
      });
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      return j(res, 200, { ok: true, check: r.check });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
