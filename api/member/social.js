'use strict';

/**
 * Trainingspartner / Community – Mitglieder-Endpunkt (Auth: Member-Session / Bearer).
 *
 * GET  /api/member/social
 *        -> { ok, available, enabled, profile?, buddies?, requests? }
 * POST /api/member/social { action, ... }
 *        enable {displayName?, share?}  · disable  · set-share {share}
 *        connect-by-code {code}         · accept {buddyId} · decline {buddyId}
 *        remove-buddy {buddyId}         · block {buddyId}  · unblock {buddyId}
 *        Antwort ist i. d. R. der frische Snapshot (+ ggf. status/error/message).
 *
 * Gating: das Feature ist im Frontend hinter SOCIAL_LAUNCH versteckt; der Server
 * ist zusätzlich rein Opt-in (enable nötig, Altersprüfung server-seitig).
 */

const M = require('../../lib/members');
const Social = require('../../lib/social');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const id = sess.id;
  const j = (o) => { res.statusCode = 200; return res.end(JSON.stringify(o)); };

  if (req.method === 'GET') {
    const snap = await Social.snapshot(id).catch(() => ({ ok: true, available: false }));
    return j(snap);
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = (await M.readBody(req)) || {};
  const action = String(body.action || '');
  const buddyId = body.buddyId != null ? String(body.buddyId) : '';
  // Chat darf häufiger sein als Verbinde-/Verwaltungs-Aktionen.
  const heavy = (action === 'dm-send');
  if (!(await M.rateLimit(heavy ? ('social:dm:' + id) : ('social:' + id), heavy ? 240 : 60, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele Aktionen – bitte kurz warten.' }));
  }

  try {
    if (action === 'enable') {
      const member = await M.getMember(id).catch(() => null);
      const r = await Social.enable(id, member, { displayName: body.displayName, share: body.share });
      if (!r.ok) return j(r);
      return j(Object.assign({}, await Social.snapshot(id)));
    }
    if (action === 'disable') { await Social.disable(id); return j(await Social.snapshot(id)); }
    if (action === 'set-share') {
      const r = await Social.setShare(id, body.share);
      if (!r.ok) return j(r);
      return j(await Social.snapshot(id));
    }
    if (action === 'connect-by-code') {
      const r = await Social.connectByCode(id, body.code);
      return j(Object.assign({}, r, r.ok ? await Social.snapshot(id) : {}));
    }
    if (action === 'accept') {
      const r = await Social.accept(id, buddyId);
      return j(Object.assign({}, r, await Social.snapshot(id)));
    }
    if (action === 'decline') { await Social.decline(id, buddyId); return j(await Social.snapshot(id)); }
    if (action === 'remove-buddy') { await Social.removeBuddy(id, buddyId); return j(await Social.snapshot(id)); }
    if (action === 'block') { await Social.block(id, buddyId); return j(await Social.snapshot(id)); }
    if (action === 'unblock') { await Social.unblock(id, buddyId); return j(await Social.snapshot(id)); }
    if (action === 'dm-thread') { return j(await Social.getDm(id, buddyId)); }
    if (action === 'dm-send') { return j(await Social.sendDm(id, buddyId, body.text)); }
    if (action === 'report') { await Social.report(id, buddyId, body.reason); return j(await Social.snapshot(id)); }
    if (action === 'buddy-detail') { return j(await Social.buddyDetail(id, buddyId)); }
    if (action === 'plan-propose') { const r = await Social.proposePlan(id, buddyId, body.date, body.slot); return j(r.ok ? await Social.snapshot(id) : r); }
    if (action === 'plan-join') { await Social.joinPlan(id, buddyId, body.date); return j(await Social.snapshot(id)); }
    if (action === 'plan-cancel') { await Social.cancelPlan(id, buddyId, body.date); return j(await Social.snapshot(id)); }
    return j({ ok: false, error: 'unknown_action' });
  } catch (e) {
    return j({ ok: false, error: 'server_error', message: 'Etwas ist schiefgelaufen – bitte erneut.' });
  }
};
