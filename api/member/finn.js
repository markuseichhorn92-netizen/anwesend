'use strict';

/**
 * POST /api/member/finn   (Authorization: Bearer <token>)
 * -----------------------------------------------------------------------------
 * FINN-Agenten für das angemeldete Mitglied (Web/App).
 *   { question|message, history:[{role,text}], conversationId? }
 *       -> { ok, answer, link, confirm:{id,preview,risk}|null, handoff, agent, traceId }
 *   { action:'confirm', id }  -> führt den vorgeschlagenen Schritt aus (nur derselbe Aktor)
 *   { action:'decline', id }  -> verwirft ihn
 * GET -> { ok, agents:true, mode }  (Verfügbarkeit)
 *
 * Identität ausschließlich aus der Session – der Client kann keine memberId setzen.
 * Fehlertexte sind kundentauglich; technische Details bleiben serverseitig.
 */

const M = require('../../lib/members');
const Channels = require('../../lib/finn/channels');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method === 'GET') {
    const AI = require('../../lib/ai');
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, agents: true, available: !!AI.hasAI, mode: require('../../lib/finn/magicline').mockOn() ? 'mock' : 'live' }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  let m = null; try { m = await M.getMember(sess.id); } catch (e) {}
  if (!m && !require('../../lib/finn/magicline').mockOn()) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  const body = await M.readBody(req);
  let r;
  try { r = await Channels.memberTurn(sess, m || {}, body); }
  catch (e) { r = { ok: false, error: 'failed', answer: 'Da komme ich gerade nicht weiter. Magst du es unserem Team schreiben?' }; }
  res.statusCode = 200;
  return res.end(JSON.stringify(r));
};
