'use strict';

/**
 * Team-Backend: Rundnachricht (Broadcast).
 *   GET  ?segment=…                          -> { ok, count, segment }   Empfänger-Vorschau
 *   POST { segment, title, body, channels }  -> { ok, recipients, pushSent, mailSent, waSent, capped }
 *
 * Empfänger-Ermittlung + Versand liegen in lib/outreach (403-/fehlersicher).
 * Ohne den Scope MEMBER_LIST_READ (bewusst nicht angefragt) sind nur uns bereits
 * BEKANNTE Mitglieder erreichbar: App-Nutzer mit Push ∪ Mitglieder mit Vorgängen.
 * Die Sende-Menge ist auf 500 Empfänger begrenzt (capped:true meldet das).
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const Outreach = require('../../lib/outreach');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  // ── GET: Empfänger-Vorschau (Zahl) ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const segment = url.searchParams.get('segment') || 'app';
    let count = 0;
    try { const r = await Outreach.recipients(segment); count = Array.isArray(r) ? r.length : 0; } catch (e) { count = 0; }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, count: count, segment: segment }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Anti-Spam: max. 20 Rundnachrichten pro Stunde (studioweit).
  if (!(await M.rateLimit('broadcast', 20, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Rundnachrichten – bitte kurz warten.' }));
  }

  const b = await M.readBody(req);
  const segment = String(b.segment || 'app');
  const title = String(b.title || '').trim();
  const body = String(b.body || '').trim();
  const channels = (b.channels && typeof b.channels === 'object') ? b.channels : {};
  if (!title || !body) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte Titel und Text ausfüllen.' }));
  }

  const r = await Outreach.sendBroadcast({ segment: segment, title: title, body: body, channels: channels });
  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    recipients: r.recipients, pushSent: r.pushSent, mailSent: r.mailSent, waSent: r.waSent, capped: r.capped,
  }));
};
