'use strict';

/**
 * POST /api/member/concierge   (Authorization: Bearer <token>)
 *   { messages:[{role,text}], context:{member,contract,pause,cancelReasons,attest} }
 *   -> { ok, message, chips:[…], action:{type,label,params}|null }
 *
 * KI-gestützter Vertrags-Assistent für Beitragspause & Kündigung. Der Client
 * liefert den Konversationsverlauf + einen kompakten Kontext (Vertrag, Pausen-/
 * Kündigungsgründe, Attest-Status). Die KI stellt Rückfragen, schlägt Antwort-
 * Chips und (bestätigungspflichtige) Aktionen vor. Die eigentlichen verbindlichen
 * Aktionen laufen weiterhin über die bestehenden, geprüften Endpunkte im Client.
 * Ohne KI-Key: { ok:false } -> der Client fällt auf die normalen Buttons zurück.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!(await M.rateLimit('concierge:' + sess.id, 40, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
  }
  if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai' })); }

  const body = await M.readBody(req);
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const context = (body.context && typeof body.context === 'object') ? body.context : {};

  let r;
  try { r = await AI.conciergeReply({ history: history, context: context }); } catch (e) { r = { ok: false }; }
  if (!r || !r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: (r && r.error) || 'ai_failed' })); }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, message: r.message, chips: r.chips || [], action: r.action || null }));
};
