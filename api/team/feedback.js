'use strict';

/**
 * Team-Backend: App-Feedback der Mitglieder (nur Admin – admin.manage).
 *   GET                                  -> { ok, items:[...], total, open }
 *   POST { action:'status', id, status } -> Feedback auf 'new'|'done' setzen
 *   POST { action:'delete', id }         -> Feedback löschen
 *
 * Die Feedbacks sind anonym (kein Personenbezug) und tragen nur technische
 * Angaben zur Fehlersuche. Cache-Control: private, no-store.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');   // readBody
const FB = require('../../lib/feedback');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;

  if (req.method === 'GET') {
    const l = await FB.list({ limit: 300 });
    return j(res, 200, { ok: true, hasStore: FB.hasStore, items: l.items, total: l.total, open: l.open });
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!FB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Feedback-Speicher nicht verfügbar.' });

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = String((body && body.action) || '');
  const id = String((body && body.id) || '');
  if (!id) return j(res, 400, { ok: false, error: 'id_required' });

  if (action === 'status') {
    const r = await FB.setStatus(id, body.status);
    if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'failed' });
    const l = await FB.list({ limit: 300 });
    return j(res, 200, { ok: true, items: l.items, total: l.total, open: l.open });
  }

  if (action === 'delete') {
    await FB.remove(id);
    const l = await FB.list({ limit: 300 });
    return j(res, 200, { ok: true, items: l.items, total: l.total, open: l.open });
  }

  return j(res, 400, { ok: false, error: 'unknown_action' });
};
