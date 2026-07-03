'use strict';

/**
 * GET  /api/member/comm-prefs            -> { ok:true, available, prefs }
 * POST /api/member/comm-prefs { prefs:{ email?,phone?,post?,sms? } }
 *        Erfolg  -> { ok:true, message }
 *        403     -> { ok:false, forbidden:true, message }
 *        sonst   -> { ok:false, message }
 *
 * Marketing-/Kommunikations-Einwilligungen (Magicline, Scopes
 * COMMUNICATION_PREFERENCES_READ/WRITE). Auth über Member-Session (Bearer).
 * Fehlt der Scope (403) oder ist die API nicht verfügbar, liefert GET sauber
 * { available:false } – die UI blendet den Bereich dann komplett aus.
 */

const M = require('../../lib/members');
const C = require('../../lib/mlComm');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    let r;
    try { r = await C.getCommPrefs(sess.id); } catch (e) { r = { available: false }; }
    res.statusCode = 200;
    if (r && r.available) return res.end(JSON.stringify({ ok: true, available: true, prefs: r.prefs || {} }));
    return res.end(JSON.stringify({ ok: true, available: false }));
  }

  if (req.method === 'POST') {
    if (!(await M.rateLimit('comm-prefs:' + sess.id, 20, 3600))) {
      res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele Änderungen – bitte kurz warten.' }));
    }
    const body = await M.readBody(req);
    const src = (body && body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
    const patch = {};
    ['email', 'phone', 'post', 'sms'].forEach(function (k) { if (typeof src[k] === 'boolean') patch[k] = src[k]; });
    if (!Object.keys(patch).length) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Keine gültige Einstellung übermittelt.' }));
    }

    let r;
    try { r = await C.setCommPrefs(sess.id, patch); } catch (e) { r = { ok: false, forbidden: false }; }
    res.statusCode = 200;
    if (r && r.ok) return res.end(JSON.stringify({ ok: true, message: 'Deine Einstellungen wurden gespeichert.' }));
    if (r && r.forbidden) return res.end(JSON.stringify({ ok: false, forbidden: true, message: 'Das Ändern deiner Einwilligungen ist aktuell nicht möglich.' }));
    return res.end(JSON.stringify({ ok: false, message: 'Konnte nicht gespeichert werden – bitte später erneut.' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
