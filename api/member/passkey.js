'use strict';

/**
 * Passkey-Verwaltung für EINGELOGGTE Mitglieder (Authorization: Bearer <token>).
 *   GET                              -> { ok, supported:true, passkeys:[{id,createdAt}] }
 *   POST { action:'reg-options' }    -> WebAuthn-Registrierungsoptionen
 *   POST { action:'reg-verify', response } -> Passkey speichern
 *   POST { action:'remove', id }     -> Passkey entfernen
 */

const M = require('../../lib/members');
const PK = require('../../lib/passkey');

function host(req) { return req.headers['x-forwarded-host'] || req.headers['host'] || ''; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!PK.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, passkeys: [], disabled: true })); }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  const member = Object.assign({}, m, { id: sess.id });

  if (req.method === 'GET') {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, passkeys: await PK.listForMember(sess.id) }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const action = body.action;

  if (action === 'reg-options') {
    try { const options = await PK.regOptions(member, host(req)); res.statusCode = 200; return res.end(JSON.stringify({ ok: true, options: options })); }
    catch (e) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Konnte nicht starten.' })); }
  }
  if (action === 'reg-verify') {
    const r = await PK.regVerify(member, host(req), body.response);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!r.ok, id: r.id || null, message: r.ok ? undefined : 'Passkey konnte nicht gespeichert werden.' }));
  }
  if (action === 'remove') {
    const ok = await PK.removeCred(sess.id, String(body.id || ''));
    res.statusCode = 200; return res.end(JSON.stringify({ ok: ok }));
  }
  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
