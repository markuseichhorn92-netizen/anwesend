'use strict';

/**
 * POST /api/member/feedback   (Authorization: Bearer <token>)
 * -----------------------------------------------------------
 * Mitglied gibt App-Feedback ab (Banner auf der Startseite). Die Anfrage ist
 * authentifiziert (Spam-Schutz per Rate-Limit), aber das Feedback wird
 * ANONYM gespeichert: die memberId wird bewusst NICHT mitgeschrieben. Mit
 * dabei sind nur technische, für die Fehlersuche nötige Angaben (Plattform,
 * grobe Geräte-/OS-Kennung, Screen, App-Version, Viewport) – ohne Name,
 * Mitgliedsnummer, E-Mail oder IP. Cache-Control: no-store.
 *
 *   POST { text, category?, meta? } -> { ok } | { ok:false, error }
 */

const M = require('../../lib/members');
const FB = require('../../lib/feedback');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!FB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Feedback ist gerade nicht verfügbar.' });

  // Spam-Schutz: max. 8 Feedbacks pro Mitglied und Tag. Die ID dient NUR dem
  // Rate-Limit-Schlüssel und wird NICHT beim Feedback gespeichert.
  if (!(await M.rateLimit('feedback:' + sess.id, 8, 86400))) {
    return j(res, 200, { ok: false, error: 'rate_limited', message: 'Danke! Du hast heute schon viel Feedback gegeben – morgen gern wieder.' });
  }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }

  const r = await FB.submit({ text: body.text, category: body.category, meta: body.meta });
  if (!r.ok) {
    const msg = r.error === 'empty' ? 'Bitte schreib kurz, worum es geht.' : 'Konnte nicht gesendet werden – bitte später erneut.';
    return j(res, 200, { ok: false, error: r.error || 'failed', message: msg });
  }
  return j(res, 200, { ok: true });
};
