'use strict';

/**
 * GET/POST /api/member/inbody   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * InBody-Körperanalyse (InBody 270) als Erfolgskontrolle. Das Mitglied
 * fotografiert den Ergebnisbogen; die KI liest die Werte aus (scan), das
 * Mitglied prüft/korrigiert und speichert (save). Bewertung + Verlauf werden
 * serverseitig berechnet; die Daten fließen in FINN (coach.js) ein.
 *
 *  GET                          -> { ok, available, list, latest, eval, trend, premium, quota }
 *  POST { action:'scan', photo, mediaType }  -> KI liest den Bogen aus (gated) -> { ok, parsed }
 *  POST { action:'save', measurement }        -> Messung speichern -> Zustand
 *  POST { action:'delete', sel }              -> Messung (date/ts) löschen
 *  POST { action:'assess' }                   -> FINN-Einschätzung (Premium, kostenfrei)
 *
 * Ohne KV-Store: available:false. Scan nur mit KI-Schlüssel; Gating serverseitig
 * (Premium unbegrenzt, sonst gemeinsames Gratis-Kontingent lib/nutriquota).
 */

const M = require('../../lib/members');
const IB = require('../../lib/inbody');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Quota = require('../../lib/nutriquota');
const Profile = require('../../lib/memberProfile');
const Privacy = require('../../lib/privacy');
const { hasStore } = require('../../lib/store');

function berlinDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

async function readState(id) {
  const list = await IB.list(id);
  let sex = '';
  try { const p = await Profile.get(id); if (p && p.sex) sex = p.sex; } catch (e) {}
  const latest = list[0] || null;
  const tier = Ent.publicTier(await Ent.getEntitlement(id));
  const qMonth = Quota.monthOf(berlinDate());
  const qUsed = await Quota.getUsed(id, qMonth);
  return {
    ok: true, available: true,
    list: list,
    latest: latest,
    eval: latest ? IB.evaluate(latest, sex) : [],
    segments: latest ? IB.segments(latest) : [],
    symmetry: latest ? IB.symmetry(latest) : null,
    trend: IB.trend(list),
    premium: !!tier.premium,
    quota: Quota.publicQuota(qUsed, tier.premium, qMonth),
    healthConsent: !!((await Privacy.currentConsents(id)).body_analysis_health || {}).granted,
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

  if (!(await M.rateLimit('inbody:' + id, 40, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });
  const body = await M.readBody(req);
  const action = String((body && body.action) || '');

  try {
    if (['scan', 'save', 'assess'].indexOf(action) >= 0) {
      const current = (await Privacy.currentConsents(id)).body_analysis_health;
      if (!(current && current.granted)) {
        if (body.consent !== true) return j(res, 200, { ok: false, error: 'health_consent_required', message: 'Bitte bestätige zuerst ausdrücklich die Verarbeitung deiner Körper- und Gesundheitsdaten.' });
        await Privacy.recordConsent(id, 'body_analysis_health', true, { source: 'inbody' });
      }
    }

    // Bogen fotografieren -> KI liest aus (gated: Premium unbegrenzt, sonst Gratis-Kontingent).
    if (action === 'scan') {
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'Die Foto-Auslese ist gerade nicht verfügbar – du kannst die Werte auch von Hand eintragen.' });
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      const month = Quota.monthOf(berlinDate());
      if (!premium && !(await Quota.canUse(id, month))) {
        return j(res, 200, { ok: false, error: 'premium_required', quota: 'exhausted', message: 'Dein Gratis-Kontingent für KI-Auslese ist diesen Monat aufgebraucht. Mit Premium geht’s unbegrenzt – oder trag die Werte von Hand ein.' });
      }
      const photo = String(body.photo || '').replace(/^data:[^,]+,/, '');
      const r = await AI.scanInbody(photo, body.mediaType);
      if (!r.ok || !r.data) return j(res, 200, { ok: false, error: 'scan_failed', message: 'Der Bogen konnte nicht sicher gelesen werden. Versuch ein schärferes, gerades Foto – oder trag die Werte von Hand ein.' });
      const used = premium ? await Quota.getUsed(id, month) : await Quota.incr(id, month);
      // Als vorbelegtes (noch nicht gespeichertes) Messobjekt zurückgeben – das Mitglied prüft/korrigiert.
      return j(res, 200, { ok: true, parsed: IB.sanitize(r.data), quota: Quota.publicQuota(used, premium, month), healthConsent: true });
    }

    // Geprüfte Messung speichern.
    if (action === 'save') {
      const r = await IB.add(id, body.measurement || body.parsed || {}, Date.now());
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'save_failed', message: 'Bitte gib mindestens einen Kernwert ein (z. B. Gewicht oder Körperfett).' });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Messung löschen.
    if (action === 'delete') {
      await IB.remove(id, body.sel != null ? body.sel : body.date);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // FINN-Einschätzung zur InBody-Analyse (Premium, kostenfreies Extra).
    if (action === 'assess') {
      const list = await IB.list(id);
      if (!list.length) return j(res, 200, { ok: false, error: 'no_data', message: 'Scanne zuerst eine InBody-Analyse ein.' });
      const premium = Ent.isPremium(await Ent.getEntitlement(id));
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: 'Die persönliche FINN-Einschätzung zur InBody-Analyse ist eine Premium-Funktion.' });
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      let goal = '', sex = '';
      try { const p = await Profile.get(id); if (p) { goal = p.goal || ''; sex = p.sex || ''; } } catch (e) {}
      const ctx = IB.toPromptText(list, sex);
      const sys = 'Du bist FINN, der persönliche Coach von Fit-Inn Trier. Ein Mitglied hat seine InBody-Körperanalyse eingescannt. Erkläre die wichtigsten Werte kurz und verständlich (per du, warmherzig, 3–5 Sätze), ordne den Trend ein und gib 1–2 konkrete, sichere Empfehlungen passend zum Ziel. Kein Namensgruß, keine Aufzählung, kein Markdown. Stelle KEINE Diagnosen; verweise bei Auffälligkeiten auf ärztlichen Rat.';
      const user = ctx + (goal ? ('\nZiel des Mitglieds: ' + String(goal).slice(0, 40)) : '') + '\n\nGib deine Einschätzung.';
      const cc = await AI.messagesRaw({ system: sys, messages: [{ role: 'user', content: user }], maxTokens: 340, temperature: 0.75, model: AI.MODEL_ANALYSIS });
      const text = (cc && cc.ok && Array.isArray(cc.content)) ? cc.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim() : '';
      if (!text) return j(res, 200, { ok: false, error: 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      return j(res, 200, { ok: true, text: text });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
