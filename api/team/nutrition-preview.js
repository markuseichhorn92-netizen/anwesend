'use strict';

/**
 * Team-Backend: Ernährungs-Premium als VORSCHAU freischalten (ohne Stripe).
 * -------------------------------------------------------------------------
 * Damit das Studio-Team die kostenpflichtigen Coaching-/KI-Inhalte prüfen (oder
 * einzelnen Mitgliedern kulanzweise freischalten) kann, ohne ein echtes Abo.
 *
 *   GET  ?id=<memberId>                 -> { ok, id, tier:{…publicTier}, source, until }
 *   POST { id, action:'grant'|'revoke' } -> { ok, tier:{…}, source }        (nur Admin)
 *   401 ohne Team-Session · 403 wenn kein Admin · 405 sonst.
 *
 * Kern-Idee: Es wird ein ECHTES Entitlement (nutri:prem:<id>) geschrieben – Form
 * identisch zu Stripe, nur mit `source:'team_preview'` markiert und auf 180 Tage
 * befristet (`until`). Dadurch greifen ALLE bestehenden Premium-Gates automatisch
 * (nutrition.js / nutrition-coach.js), ohne dort etwas zu ändern.
 *
 * Sicherheitsnetz:
 *  - `revoke` fasst NUR `source:'team_preview'` an – ein echtes Stripe-Abo wird nie
 *    angetastet (sonst 409 conflict).
 *  - `until`-Cap (180 Tage) lässt die Vorschau von selbst auslaufen.
 *  - Der Stripe-Webhook überschreibt einen Vorschau-Eintrag beim echten Abo sowieso.
 * Ohne Store degradiert alles still (tier:free). Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Ent = require('../../lib/entitlements');
const M = require('../../lib/members');            // readBody
const { redisPipeline, hasStore } = require('../../lib/store');

const PREVIEW_DAYS = 180;

function tierPayload(ent) {
  return { ok: true, tier: Ent.publicTier(ent), source: (ent && ent.source) || null, until: (ent && ent.until) ? Number(ent.until) : null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // ── Status lesen (jede Team-Session) ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const ent = await Ent.getEntitlement(id);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(ent))));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // ── Freischalten/Entziehen: nur Admin (schaltet ein bezahltes Feature frei) ──
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const body = await M.readBody(req);
  const id = body.id;
  const action = String(body.action || '').toLowerCase();
  if (id == null || String(id).trim() === '') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
  if (action !== 'grant' && action !== 'revoke') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_action' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_store', tier: Ent.publicTier(null) })); }

  const prev = await Ent.getEntitlement(id);

  if (action === 'grant') {
    // Ein echtes Stripe-Abo NICHT überschreiben – dann ist eh schon Premium aktiv.
    if (prev && prev.source !== 'team_preview' && Ent.isPremium(prev)) {
      res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'has_real_subscription', tier: Ent.publicTier(prev) }));
    }
    const now = Date.now();
    const ent = { tier: 'premium', status: 'active', until: now + PREVIEW_DAYS * 86400000, since: now, source: 'team_preview', grantedBy: (sess && (sess.user || sess.email)) || 'team', updatedAt: now };
    await Ent.setEntitlement(id, ent);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(ent))));
  }

  // revoke: nur die eigene Vorschau entfernen, nie ein echtes Abo.
  if (prev && prev.source !== 'team_preview') {
    res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'not_a_preview', tier: Ent.publicTier(prev) }));
  }
  try { await redisPipeline([['DEL', Ent.PREMKEY(id)]]); } catch (e) {}
  res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(null))));
};
