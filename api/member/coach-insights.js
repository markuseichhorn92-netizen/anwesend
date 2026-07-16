'use strict';

/**
 * POST /api/member/coach-insights   (Mitglied-Session erforderlich)
 * ----------------------------------------------------------------
 * FINN erstellt eine ganzheitliche Coaching-Erkenntnis aus Training + Ernährung.
 * Der Client schickt eine kompakte Zusammenfassung (bereits vorliegende Daten),
 * FINN verwebt beide Bereiche zu EINER Aussage. KI-Aktion – Basic-Kontingent
 * gedeckelt (gemeinsamer Monatszähler wie bei Rezept-/Plan-Generierung), Premium
 * unbegrenzt. Datensparsam: es werden nur die aggregierten Tageswerte übergeben.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Quota = require('../../lib/nutriquota');

const QUOTA_MSG = 'Dein Gratis-Kontingent für FINN ist diesen Monat aufgebraucht. Mit Premium gibt es unbegrenzte FINN-Analysen.';

function berlinDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

// Nur die erwarteten, aggregierten Felder übernehmen (kein Durchreichen beliebiger Daten).
function cleanCtx(raw) {
  raw = raw || {};
  const num = (v) => { const n = Math.round(Number(v)); return (isNaN(n) || n < 0) ? 0 : n; };
  const out = { visits7: num(raw.visits7), didToday: !!raw.didToday };
  if (raw.plan && typeof raw.plan === 'object') {
    out.plan = {
      title: String(raw.plan.title || '').slice(0, 60),
      level: String(raw.plan.level || '').slice(0, 20),
      daysPerWeek: num(raw.plan.daysPerWeek) || null,
      aiAssist: !!raw.plan.aiAssist,
    };
  } else { out.plan = null; }
  if (raw.nutrition && typeof raw.nutrition === 'object') {
    const n = raw.nutrition;
    out.nutrition = {
      streak: num(n.streak), goal: String(n.goal || '').slice(0, 24),
      kcal: num(n.kcal), kcalTarget: num(n.kcalTarget),
      protein: num(n.protein), proteinTarget: num(n.proteinTarget),
    };
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });

  const id = sess.id;
  try {
    const body = await M.readBody(req);
    const ctx = cleanCtx(body && body.ctx);

    const premium = Ent.isPremium(await Ent.getEntitlement(id));
    const month = Quota.monthOf(berlinDate());
    if (!premium && !(await Quota.canUse(id, month))) {
      return j(res, 200, { ok: false, error: 'premium_required', quota: 'exhausted', message: QUOTA_MSG });
    }

    const r = await AI.coachInsight(ctx);
    if (!r || !r.ok || !r.text) {
      return j(res, 200, { ok: false, error: 'gen_failed', message: 'FINN konnte gerade keine Analyse erstellen – bitte gleich noch einmal.' });
    }
    const used = await Quota.incr(id, month);
    return j(res, 200, { ok: true, text: r.text, quota: Quota.publicQuota(used, premium, month) });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed', message: 'FINN ist gerade nicht erreichbar.' });
  }
};
