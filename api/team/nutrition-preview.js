'use strict';

/**
 * Team-Backend: Ernährungs-Premium kostenlos freischalten (Team-Comp/Vorschau).
 * -------------------------------------------------------------------------
 * Damit das Studio-Team die kostenpflichtigen Coaching-/KI-Inhalte prüfen (oder
 * einzelnen Mitgliedern kulanzweise freischalten) kann, ohne ein Zusatzmodul.
 *
 *   GET  ?id=<memberId>                 -> { ok, id, tier:{…publicTier}, source, until }
 *   POST { id, action:'grant'|'revoke'|'magicline-clear' } -> { ok, tier:{…}, source }  (nur Admin)
 *   401 ohne Team-Session · 403 wenn kein Admin · 405 sonst.
 *
 * Kern-Idee: Es wird ein ECHTES Entitlement (nutri:prem:<id>) geschrieben – mit
 * `source:'team_preview'` markiert und (per Default) befristet (`until`). Dadurch
 * greifen ALLE bestehenden Premium-Gates automatisch (nutrition.js /
 * nutrition-coach.js), ohne dort etwas zu ändern.
 *
 * Sicherheitsnetz:
 *  - `revoke` fasst NUR `source:'team_preview'` an – ein aktives Magicline-Modul
 *    wird nie angetastet (sonst 409 conflict).
 *  - `until`-Cap lässt eine befristete Freischaltung von selbst auslaufen.
 * Ohne Store degradiert alles still (tier:free). Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Ent = require('../../lib/entitlements');
const M = require('../../lib/members');            // readBody
const { redisPipeline, hasStore } = require('../../lib/store');

const PREVIEW_DAYS = 30;   // Default-Testzeitraum, wenn keine Dauer angegeben wird
const MAX_DAYS = 3650;

function tierPayload(ent) {
  return { ok: true, tier: Ent.publicTier(ent), source: (ent && ent.source) || null, until: (ent && ent.until) ? Number(ent.until) : null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'nutrition.manage', res)) return;

  // ── Status lesen (jede Team-Session) ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const ent = await Ent.getEntitlement(id);
    // aboOff: das Team sieht, dass es nichts freizuschalten gibt – und ob dieses
    // Mitglied das Zusatzmodul noch gebucht hat (dann in Magicline kündigen).
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id), aboOff: !require('../../lib/features').aboOn() }, tierPayload(ent))));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // ── Freischalten/Entziehen: nur Admin (schaltet ein bezahltes Feature frei) ──
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  const body = await M.readBody(req);
  const id = body.id;
  const action = String(body.action || '').toLowerCase();
  if (id == null || String(id).trim() === '') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
  if (['grant', 'revoke', 'magicline-clear'].indexOf(action) < 0) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_action' })); }
  if (!hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_store', tier: Ent.publicTier(null) })); }

  const prev = await Ent.getEntitlement(id);

  if (action === 'grant') {
    // Ein aktives Magicline-Modul NICHT überschreiben – dann ist eh schon Premium aktiv.
    if (prev && prev.source !== 'team_preview' && Ent.isPremium(prev)) {
      res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'has_real_subscription', tier: Ent.publicTier(prev) }));
    }
    const now = Date.now();
    // Dauer: `permanent:true` -> dauerhaft gratis (until:null); sonst `days` (Default 30, Cap 3650).
    const permanent = body.permanent === true || body.permanent === 'true';
    let until = null;
    if (!permanent) {
      let days = parseInt(body.days, 10);
      if (!Number.isFinite(days) || days <= 0) days = PREVIEW_DAYS;
      days = Math.min(MAX_DAYS, Math.max(1, days));
      until = now + days * 86400000;
    }
    const ent = { tier: 'premium', status: 'active', until: until, since: (prev && prev.since) || now, source: 'team_preview', permanent: permanent, grantedBy: (sess && (sess.user || sess.email)) || 'team', updatedAt: now };
    await Ent.setEntitlement(id, ent);
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(ent))));
  }

  // magicline-clear: den App-Premium-Datensatz eines Magicline-Zusatzmoduls zurücksetzen.
  // Gedacht als Studio-Override, wenn das Modul direkt in Magicline gekündigt wurde ODER
  // die App die Modul-Vertrags-ID nicht (mehr) kennt.
  if (action === 'magicline-clear') {
    const isMagicline = !!(prev && (prev.source === 'magicline' || prev.moduleContractId != null));
    if (!isMagicline) {
      res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'not_magicline', tier: Ent.publicTier(prev) }));
    }
    try { await redisPipeline([['DEL', Ent.PREMKEY(id)]]); } catch (e) {}
    try { await redisPipeline([['DEL', 'nutri:mlmod:' + String(id)]]); } catch (e) {}   // Modul-Status-Cache leeren
    res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(null))));
  }

  // revoke: nur die eigene Vorschau/Gratis-Freischaltung entfernen, nie ein echtes Abo.
  if (prev && prev.source !== 'team_preview') {
    res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'not_a_preview', tier: Ent.publicTier(prev) }));
  }
  try { await redisPipeline([['DEL', Ent.PREMKEY(id)]]); } catch (e) {}
  res.statusCode = 200; return res.end(JSON.stringify(Object.assign({ id: String(id) }, tierPayload(null))));
};
