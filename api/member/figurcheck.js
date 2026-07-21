'use strict';

/**
 * GET/POST /api/member/figurcheck   (Authorization: Bearer <token>)
 * -------------------------------------------------------------------------
 * Der Figur-Check: die Mess-Journey fürs Mitglied (Gewicht + Umfänge, Verlauf,
 * Vorher-Nachher). Frei für alle Mitglieder – Zahlen + Kurven kosten nichts.
 * Nur die optionale KI-Auswertung („FINN bewertet deinen Fortschritt") ist
 * Premium bzw. verbraucht das gemeinsame Gratis-Kontingent (lib/nutriquota).
 *
 *  GET                         -> { available, metrics, history, summary, +Premium/Quota }
 *  POST { action:'save', <messwerte>, note? } -> Eintrag ablegen (1/Tag), Verlauf+Vergleich zurück
 *  POST { action:'delete', date }             -> Eintrag löschen
 *  POST { action:'review' }                   -> FINN-Auswertung (Premium/Kontingent)
 *
 * Ohne KV (hasStore=false) -> { ok:true, available:false } (UI blendet aus).
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Quota = require('../../lib/nutriquota');
const Figur = require('../../lib/figurcheck');
const Privacy = require('../../lib/privacy');
const { hasStore, redisPipeline } = require('../../lib/store');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

// Nur die Metrik-Metadaten fürs Frontend (Formular + Kurven). Bereichsgrenzen
// dienen zusätzlich der clientseitigen Vorvalidierung.
function metricDefs() {
  return Figur.METRICS.map(function (m) { return { key: m.key, label: m.label, unit: m.unit, dec: m.dec, lo: m.lo, hi: m.hi }; });
}

async function tierFields(id) {
  const t = Ent.publicTier(await Ent.getEntitlement(id));
  return { premium: t.premium, tier: t.tier, trialing: t.trialing, premiumUntil: t.until };
}

// Ziel des Mitglieds (für die neutrale KI-Deutung) – ohne die große coaching-Lib zu laden.
async function memberGoal(id) {
  try { const [r] = await redisPipeline([['GET', 'nutri:p:' + id]]); const p = r ? JSON.parse(r) : null; return (p && p.goal) || ''; } catch (e) { return ''; }
}

async function snapshot(id) {
  const rec = await Figur.getRec(id);
  const tf = await tierFields(id);
  const month = Quota.monthOf(Figur.berlinToday());
  const used = await Quota.getUsed(id, month);
  return Object.assign({
    ok: true, available: true,
    metrics: metricDefs(),
    history: Figur.history(rec),
    summary: Figur.summary(rec),
    quota: Quota.publicQuota(used, tf.premium, month),
    healthConsent: !!((await Privacy.currentConsents(id)).body_analysis_health || {}).granted,
  }, tf);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const id = sess.id;

  if (req.method === 'GET') {
    try { return j(res, 200, await snapshot(id)); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');

  try {
    if (['save', 'review'].indexOf(action) >= 0) {
      const current = (await Privacy.currentConsents(id)).body_analysis_health;
      if (!(current && current.granted)) {
        if (body.consent !== true) return j(res, 200, { ok: false, error: 'health_consent_required', message: 'Bitte bestätige zuerst ausdrücklich die Verarbeitung deiner Körper- und Gesundheitsdaten.' });
        await Privacy.recordConsent(id, 'body_analysis_health', true, { source: 'figurcheck' });
      }
    }
    if (action === 'save') {
      if (!(await M.rateLimit('figur-save:' + id, 30, 86400))) {
        return j(res, 200, { ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' });
      }
      const today = Figur.berlinToday();
      const entry = Figur.buildEntry(body, today);
      if (!entry) return j(res, 200, { ok: false, error: 'bad_input', message: 'Bitte gib mindestens einen gültigen Messwert ein (z. B. dein Gewicht).' });
      let rec = await Figur.getRec(id);
      rec = Figur.appendEntry(rec, entry);
      await Figur.saveRec(id, rec);
      const snap = await snapshot(id);
      return j(res, 200, Object.assign(snap, { saved: true, savedDate: entry.date }));
    }

    if (action === 'delete') {
      const date = String((body && body.date) || '');
      if (!Figur.isYMD(date)) return j(res, 200, { ok: false, error: 'bad_input' });
      let rec = await Figur.getRec(id);
      if (rec) { rec = Figur.deleteEntry(rec, date); await Figur.saveRec(id, rec); }
      const snap = await snapshot(id);
      return j(res, 200, Object.assign(snap, { deleted: true }));
    }

    // FINN-Auswertung des Fortschritts (Premium bzw. Gratis-Kontingent).
    if (action === 'review') {
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      const rec = await Figur.getRec(id);
      const sum = Figur.summary(rec);
      if (sum.count < 2) return j(res, 200, { ok: false, error: 'no_data', message: 'Erfasse mindestens zwei Messungen – dann wertet FINN deinen Fortschritt aus.' });
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      const month = Quota.monthOf(Figur.berlinToday());
      if (!premium && !(await Quota.canUse(id, month))) {
        return j(res, 200, { ok: false, error: 'premium_required', quota: 'exhausted', message: 'Die FINN-Auswertung ist eine Premium-Funktion. Teste Premium 7 Tage gratis – danach jederzeit kündbar.' });
      }
      if (!(await M.rateLimit('figur-review:' + id, 10, 86400))) {
        return j(res, 200, { ok: false, error: 'rate_limited', message: 'Kurz warten und erneut versuchen.' });
      }
      const ctx = Figur.reviewContext(rec, await memberGoal(id));
      const r = await AI.figurReview(ctx);
      if (!r || !r.ok) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      let used = await Quota.getUsed(id, month);
      if (!premium) used = await Quota.incr(id, month);
      return j(res, 200, { ok: true, review: { summary: r.summary, insights: r.insights, tip: r.tip }, quota: Quota.publicQuota(used, premium, month) });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'server_error' });
  }
};
