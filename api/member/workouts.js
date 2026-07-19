'use strict';

/**
 * GET/POST /api/member/workouts   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * Trainings-Aufzeichnung mit dem Brustgurt: der Client streamt den Puls über
 * dieselbe BLE-Anbindung wie der Vital-Check und schickt am Ende eine (herunter-
 * gerechnete) Puls-Reihe. Hier wird sie serverseitig zur maßgeblichen
 * Zusammenfassung aggregiert (Zonen, Ø/Max, kcal, TRIMP-Last) und abgelegt.
 *
 *  GET                                   -> { ok, available, premium, consent, list, weekly, zones, activities }
 *  POST { action:'save', samples, activity, kind, outdoor } -> Einheit aggregieren + speichern
 *  POST { action:'import', workouts }    -> Einheiten aus Apple Health / Google Fit übernehmen (dedupliziert)
 *  POST { action:'assess', ts }          -> FINN-Auswertung einer Einheit (Premium)
 *  POST { action:'delete', ts }          -> Einheit löschen
 *
 * Herz-/Standortdaten sind Gesundheitsdaten (DSGVO Art. 9): Aufzeichnen nur mit
 * derselben ausdrücklichen Einwilligung wie der Vital-Check (MO.getConsent) und
 * mit Coach Premium. Kein Medizinprodukt – Wellness-/Trainings-Signal.
 */

const M = require('../../lib/members');
const WO = require('../../lib/workouts');
const MO = require('../../lib/morning');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Coaching = require('../../lib/coaching');
const { hasStore } = require('../../lib/store');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

const PREMIUM_MSG = 'Die Trainings-Aufzeichnung mit Puls ist ein Coach-Premium-Feature.';

async function profileFor(id) {
  let age = 0, weightKg = 0, sex = 'm';
  try { const p = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; age = Number(p.age) || 0; weightKg = Number(p.weight) || 0; sex = (p.sex === 'w' || p.sex === 'f') ? 'f' : 'm'; } catch (e) {}
  let hrRest = 0; try { const base = MO.baseline(await MO.list(id)); hrRest = (base && base.rhr) || 0; } catch (e) {}
  return { age, weightKg, sex, hrRest };
}

async function readState(id) {
  const list = await WO.list(id);
  let consent = false; try { consent = await MO.getConsent(id); } catch (e) {}
  const tier = Ent.publicTier(await Ent.getEntitlement(id));
  const prof = await profileFor(id);
  const zones = MO.trainingZones(prof.age || 30);
  const acts = Object.keys(WO.ACTIVITIES).map((k) => ({ key: k, label: WO.ACTIVITIES[k], outdoor: !!WO.OUTDOOR[k] }));
  return {
    ok: true, available: true,
    premium: !!tier.premium, tier: tier.tier, trialing: tier.trialing,
    consent: consent,
    list: list,
    weekly: WO.weeklyLoad(list),
    zones: zones,
    vpPerWorkout: WO.VP_PER_WORKOUT,
    activities: acts,
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

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');
  if (!(await M.rateLimit('workout:' + id, 60, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });

  try {
    const premium = Ent.isPremium(await Ent.getEntitlement(id));

    // Einheit aggregieren + speichern (Premium + Einwilligung nötig).
    if (action === 'save') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte aktiviere zuerst den Vital-Check (Einwilligung für Herzdaten).' });
      const prof = await profileFor(id);
      const samples = Array.isArray(body.samples) ? body.samples : null;
      // Server-seitige Aggregation ist maßgeblich, wenn die Puls-Reihe mitkommt.
      const agg = samples ? WO.aggregate(samples, prof) : null;
      if (samples && !agg) return j(res, 200, { ok: false, error: 'too_short', message: 'Es kamen zu wenige Messwerte an – die Aufzeichnung war zu kurz.' });
      const kind = (body.kind === 'outdoor') ? 'outdoor' : 'indoor';
      const out = (body.outdoor && typeof body.outdoor === 'object') ? body.outdoor : {};
      const session = Object.assign(
        { kind: kind, activity: body.activity, date: body.date, note: body.note },
        agg || { durationSec: body.durationSec, avgHr: body.avgHr, maxHr: body.maxHr, minHr: body.minHr, zoneSecs: body.zoneSecs, kcal: body.kcal, trimp: body.trimp },
        kind === 'outdoor' ? { distanceM: out.distanceM, paceSec: out.paceSec, elevM: out.elevM, route: out.route } : {}
      );
      const r = await WO.add(id, session, Date.now());
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'save_failed', message: 'Speichern hat nicht geklappt – bitte erneut.' });
      const st = await readState(id);
      return j(res, 200, Object.assign({ ok: true, saved: r.saved, session: r.session, vpAdded: WO.VP_PER_WORKOUT }, st));
    }

    // Einheiten aus Apple Health / Google Fit übernehmen (Premium + Einwilligung, dedupliziert per extId).
    if (action === 'import') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte aktiviere zuerst den Vital-Check (Einwilligung für Herzdaten).' });
      const incoming = Array.isArray(body.workouts) ? body.workouts.slice(0, 200) : [];
      const r = await WO.importMany(id, incoming, Date.now());
      const st = await readState(id);
      return j(res, 200, Object.assign({ ok: r.ok !== false, imported: r.added || 0, vpAdded: (r.added || 0) * WO.VP_PER_WORKOUT }, st));
    }

    // FINN-Auswertung einer Einheit (Premium).
    if (action === 'assess') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      const list = await WO.list(id);
      const s = body.ts != null ? list.find((x) => String(x.ts) === String(body.ts)) : list[0];
      if (!s) return j(res, 200, { ok: false, error: 'not_found' });
      let firstName = '', goal = '';
      try { const mem = await M.getMember(id); firstName = (mem && mem.firstName) || ''; } catch (e) {}
      try { const p = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; goal = p.goal || ''; } catch (e) {}
      const zones = MO.trainingZones((await profileFor(id)).age || 30);
      const weekly = WO.weeklyLoad(list);
      if (!AI.workoutReview) return j(res, 200, { ok: false, error: 'no_ai' });
      const r = await AI.workoutReview({
        firstName: firstName, goal: goal,
        activity: WO.ACTIVITIES[s.activity] || s.activity, kind: s.kind,
        durationMin: Math.round((s.durationSec || 0) / 60), avgHr: s.avgHr, maxHr: s.maxHr,
        zoneSecs: s.zoneSecs, zoneLabels: (zones && zones.table ? zones.table.map((z) => z.label) : []),
        kcal: s.kcal, trimp: s.trimp,
        distanceKm: s.distanceM ? Math.round(s.distanceM / 100) / 10 : null,
        weekTrimp: weekly.trimp, weekSessions: weekly.sessions,
      });
      if (!r || !r.ok) return j(res, 200, { ok: false, error: (r && r.error) || 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      return j(res, 200, { ok: true, review: r.review });
    }

    // Einheit löschen (immer erlaubt – eigene Daten).
    if (action === 'delete') {
      await WO.remove(id, body.ts != null ? body.ts : body.sel);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
