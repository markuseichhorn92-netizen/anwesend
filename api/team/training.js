'use strict';

/**
 * GET/POST /api/team/training   (Team-Session erforderlich)
 * ---------------------------------------------------------
 * Das Studio-Team verwaltet den Trainingsplan EINES Mitglieds:
 *  - GET ?id=            -> aktueller Plan + Bibliothek + Übungskatalog
 *  - POST { id, action }:
 *      assign        {planId}  -> kuratierten Plan zuweisen („Vom Trainer")
 *      assign-custom {plan}     -> eigenen Plan bauen & zuweisen
 *      unassign                 -> Plan des Mitglieds entfernen
 *      plan-detail   {planId}   -> vollständigen Bibliotheks-Plan liefern
 *      exercise-search {q,group}-> Übungskatalog durchsuchen (fürs Bauen)
 *
 * Speicher/Modell spiegeln bewusst api/member/training.js (train:active:<id>).
 * Zugewiesene Pläne werden als source:'team' abgelegt – das Mitglied sieht
 * dann das Badge „Vom Trainer". Ohne Store: available:false.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const T = require('../../lib/training');
const Ex = require('../../lib/exercises');
const { hasStore } = require('../../lib/store');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

async function readState(id) {
  const active = await T.resolveActive(id);
  return {
    ok: true, available: true,
    myPlan: active ? { plan: active.plan, startedAt: active.startedAt, source: active.plan.source, assignedByTeam: active.assignedByTeam || null } : null,
    plans: T.getLibrary().map(T.trimPlan),
    goals: T.GOALS, levels: T.LEVELS, locations: T.LOCATIONS,
    exercises: Ex.publicList(), exerciseGroups: Ex.GROUPS,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!Cap.requireCap(sess, 'training.manage', res)) return;
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const who = (sess && (sess.user || sess.name)) || 'team';

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return j(res, 400, { ok: false, error: 'missing_id' });
    try { return j(res, 200, await readState(id)); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');

  try {
    // Übungskatalog durchsuchen (kein Mitglied nötig) – fürs Bauen eigener Pläne.
    if (action === 'exercise-search') {
      return j(res, 200, { ok: true, exercises: Ex.search(body.q, { group: body.group, bio: !!body.bio }) });
    }
    // Vollständigen Bibliotheks-Plan liefern.
    if (action === 'plan-detail') {
      const p = T.getById(body.planId);
      if (!p) return j(res, 200, { ok: false, error: 'not_found' });
      return j(res, 200, { ok: true, plan: Object.assign({}, p, { source: 'library' }) });
    }

    const id = String((body && body.id) || '').trim();
    if (!id) return j(res, 400, { ok: false, error: 'missing_id' });

    // Kuratierten Plan zuweisen (als „Vom Trainer").
    if (action === 'assign') {
      const p = T.getById(body.planId);
      if (!p) return j(res, 200, { ok: false, error: 'not_found' });
      await T.saveActive(id, { source: 'team', plan: p, startedAt: Date.now(), assignedByTeam: who });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }
    // Eigenen Plan bauen & zuweisen.
    if (action === 'assign-custom') {
      const norm = T.normalizePlan(body.plan, 'team');
      if (!norm) return j(res, 200, { ok: false, error: 'invalid_plan' });
      await T.saveActive(id, { source: 'team', plan: norm, startedAt: Date.now(), assignedByTeam: who });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }
    // Plan des Mitglieds entfernen.
    if (action === 'unassign') {
      await T.clearActive(id);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
